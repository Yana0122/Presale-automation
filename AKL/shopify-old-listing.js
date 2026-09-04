require("dotenv").config();

const fs = require("fs");
const path = require("path");
const OAuth = require("oauth-1.0a");
const crypto = require("crypto");
const JSONbig = require("json-bigint")({
  storeAsString: true,
});

// --------------------------------------------------
// CONFIG
// --------------------------------------------------

const STATE_FILE = path.join(
  __dirname,
  "../json/AKL/processed-state.json"
);

const TV_API = "https://api.tradevine.com";

// --------------------------------------------------
// TRADEVINE OAUTH
// --------------------------------------------------

const oauth = OAuth({
  consumer: {
    key: process.env.TV_CONSUMER_KEY,
    secret: process.env.TV_CONSUMER_SECRET,
  },
  signature_method: "HMAC-SHA1",
  hash_function: (base, key) =>
    crypto.createHmac("sha1", key).update(base).digest("base64"),
});

const token = {
  key: process.env.TV_ACCESS_TOKEN,
  secret: process.env.TV_ACCESS_TOKEN_SECRET,
};

// --------------------------------------------------
// PROCESSED STATE
// --------------------------------------------------

function loadProcessedState() {
  if (!fs.existsSync(STATE_FILE)) {
    console.error(`State file not found: ${STATE_FILE}`);
    return {};
  }

  try {
    return JSON.parse(
      fs.readFileSync(STATE_FILE, "utf8")
    );
  } catch (err) {
    console.error(
      `Could not read ${STATE_FILE}:`,
      err.message
    );

    return {};
  }
}

function saveProcessedState(state) {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(state, null, 2)
  );
}

// --------------------------------------------------
// BOM CHILD PROTECTION
// --------------------------------------------------

function isChildProduct(productCode) {
  return /^PR\d+-[A-Z]$/i.test(
    String(productCode || "").trim()
  );
}

// --------------------------------------------------
// EXTRACT PRODUCT CODE FROM STATE KEY
// --------------------------------------------------

function extractProductCodeFromStateKey(key) {
  if (!key) {
    return null;
  }

  // inv:PO4447:PR15242
  if (key.startsWith("inv:")) {
    const parts = key.split(":");

    if (parts.length >= 3) {
      return parts
        .slice(2)
        .join(":")
        .toUpperCase();
    }
  }

  // title:PR15242
  if (key.startsWith("title:")) {
    return key
      .replace(/^title:/i, "")
      .toUpperCase();
  }

  // bom:PR15242
  if (key.startsWith("bom:")) {
    return key
      .replace(/^bom:/i, "")
      .toUpperCase();
  }

  return null;
}

// --------------------------------------------------
// GET PRODUCTS PROCESSED BY BOM/PRESALE AUTOMATION
// --------------------------------------------------

function getProcessedProductsFromState() {
  const state = loadProcessedState();
  const products = new Set();

  Object.entries(state).forEach(
    ([key, value]) => {
      if (!value || value.done !== true) {
        return;
      }

      if (key.startsWith("blocked:")) {
        return;
      }

      if (key.startsWith("shopify-listed:")) {
        return;
      }

      const productCode =
        extractProductCodeFromStateKey(key);

      if (!productCode) {
        return;
      }

      if (isChildProduct(productCode)) {
        return;
      }

      products.add(productCode);
    }
  );

  return Array.from(products);
}

// --------------------------------------------------
// GET ACTIVE PO FOR PRODUCT
// --------------------------------------------------
//
// The active PO comes from the current title:/bom:
// state entry.
//
// Example:
//
// title:PR15241
// {
//   done: true,
//   poNumber: "PO1589"
// }
//
// --------------------------------------------------

function getActivePOForProduct(
  productCode,
  state = null
) {
  const currentState =
    state || loadProcessedState();

  const normalizedCode =
    String(productCode || "")
      .trim()
      .toUpperCase();

  const possibleKeys = [
    `title:${normalizedCode}`,
    `bom:${normalizedCode}`,
  ];

  for (const key of possibleKeys) {
    const entry = currentState[key];

    if (
      entry &&
      entry.done === true &&
      entry.poNumber
    ) {
      return {
        poNumber: String(entry.poNumber)
          .trim()
          .toUpperCase(),

        stateKey: key,

        stateEntry: entry,
      };
    }
  }

  return null;
}

// --------------------------------------------------
// SHOPIFY LISTING STATE KEY
// --------------------------------------------------
//
// IMPORTANT:
// Listing protection is now:
//
// PO + PRODUCT
//
// Example:
//
// shopify-listed:PO1589:PR15241
//
// and later:
//
// shopify-listed:PO1595:PR15241
//
// Both records can exist.
// --------------------------------------------------

function getShopifyListingStateKey(
  productCode,
  poNumber
) {
  const normalizedProduct =
    String(productCode || "")
      .trim()
      .toUpperCase();

  const normalizedPO =
    String(poNumber || "")
      .trim()
      .toUpperCase();

  if (!normalizedProduct || !normalizedPO) {
    return null;
  }

  return `shopify-listed:${normalizedPO}:${normalizedProduct}`;
}

// --------------------------------------------------
// CHECK WHETHER THIS PRODUCT + PO WAS PREVIOUSLY LISTED
// --------------------------------------------------

function wasPreviouslyListed(
  productCode,
  poNumber
) {
  const state = loadProcessedState();

  const key = getShopifyListingStateKey(
    productCode,
    poNumber
  );

  if (!key) {
    return false;
  }

  return state[key]?.done === true;
}

// --------------------------------------------------
// PERMANENTLY RECORD SHOPIFY LISTING
// --------------------------------------------------

function recordShopifyListed(
  productCode,
  poNumber,
  details = {}
) {
  const state = loadProcessedState();

  const key = getShopifyListingStateKey(
    productCode,
    poNumber
  );

  if (!key) {
    throw new Error(
      "Cannot record Shopify listing without productCode and poNumber"
    );
  }

  state[key] = {
    done: true,
    date: new Date().toISOString(),
    productCode: String(productCode)
      .trim()
      .toUpperCase(),
    poNumber: String(poNumber)
      .trim()
      .toUpperCase(),
    note: "Product successfully listed on Shopify for this presale cycle",
    ...details,
  };

  saveProcessedState(state);
}

// --------------------------------------------------
// API GET
// --------------------------------------------------

async function apiGet(url) {
  const authHeader = oauth.toHeader(
    oauth.authorize(
      {
        url,
        method: "GET",
      },
      token
    )
  );

  const res = await fetch(url, {
    method: "GET",
    headers: {
      ...authHeader,
      Accept: "application/json",
    },
  });

  const text = await res.text();

  try {
    return {
      status: res.status,
      data: JSONbig.parse(text),
      raw: text,
    };
  } catch {
    return {
      status: res.status,
      data: null,
      raw: text,
    };
  }
}

// --------------------------------------------------
// API POST
// --------------------------------------------------

async function apiPost(url, body) {
  const authHeader = oauth.toHeader(
    oauth.authorize(
      {
        url,
        method: "POST",
      },
      token
    )
  );

  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...authHeader,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();

  try {
    return {
      status: res.status,
      data: JSONbig.parse(text),
      raw: text,
    };
  } catch {
    return {
      status: res.status,
      data: null,
      raw: text,
    };
  }
}

// --------------------------------------------------
// ADD DS TO TITLE
// --------------------------------------------------

function addDSToTitle(title) {
  const currentTitle =
    (title || "").trim();

  if (!currentTitle) {
    return "DS";
  }

  if (/\bDS\b/i.test(currentTitle)) {
    return currentTitle;
  }

  return `DS ${currentTitle}`;
}

// --------------------------------------------------
// BUILD TAGS
// --------------------------------------------------

function buildTags(
  title,
  existingTags
) {
  const tags = [];

  if (
    (title || "")
      .toLowerCase()
      .includes("xclusive")
  ) {
    tags.push("xclusive");
  }

  if (existingTags) {
    const existing =
      String(existingTags)
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);

    existing.forEach((tag) => {
      const lowerTag =
        tag.toLowerCase();

      if (
        lowerTag === "xclusive" ||
        lowerTag === "pre-order-auckland"
      ) {
        return;
      }

      if (
        !tags.some(
          (t) =>
            t.toLowerCase() === lowerTag
        )
      ) {
        tags.push(tag);
      }
    });
  }

  tags.push("Pre-Order-Auckland");

  return tags.join(", ");
}

// --------------------------------------------------
// VALIDATE REQUIRED SHOPIFY FIELDS
// --------------------------------------------------

function validateShopifyFields(
  shopifyProduct
) {
  const missing = [];

  if (
    !shopifyProduct.SellPriceIncTax ||
    Number(
      shopifyProduct.SellPriceIncTax
    ) <= 0
  ) {
    missing.push("price");
  }

  if (
    !shopifyProduct.BodyHtml ||
    !String(
      shopifyProduct.BodyHtml
    ).trim()
  ) {
    missing.push("description");
  }

  if (
    !shopifyProduct.PhotoIdentifier ||
    !String(
      shopifyProduct.PhotoIdentifier
    ).trim()
  ) {
    missing.push("image");
  }

  return {
    ok: missing.length === 0,
    missing,
  };
}

// --------------------------------------------------
// FIND SHOPIFY PRODUCT RECORD
// --------------------------------------------------

async function findShopifyProductRecord(
  productCode
) {
  const url =
    `${TV_API}/v1/ShopifyProduct` +
    `?productCode=${encodeURIComponent(
      productCode
    )}` +
    `&pageSize=5`;

  const result =
    await apiGet(url);

  if (result.status !== 200) {
    console.log(
      `  ${productCode}: ShopifyProduct lookup failed:`,
      result.status,
      result.raw?.slice(0, 300)
    );

    return null;
  }

  const list =
    result.data?.List ||
    result.data?.list ||
    [];

  return list.find(
    (x) =>
      String(x.ProductCode).toUpperCase() ===
      String(productCode).toUpperCase()
  ) || null;
}

// --------------------------------------------------
// GET BASE PRODUCT PHOTO
// --------------------------------------------------

async function getBaseProductPhoto(
  shopifyProduct,
  productCode
) {
  const productId =
    shopifyProduct.ProductID ||
    shopifyProduct.ProductId ||
    shopifyProduct.productId ||
    null;

  if (!productId) {
    console.log(
      `  ${productCode}: ProductID not available on ShopifyProduct record`
    );

    return null;
  }

  const url =
    `${TV_API}/v1/Product/${productId}`;

  const result =
    await apiGet(url);

  if (result.status !== 200) {
    console.log(
      `  ${productCode}: failed to retrieve base product`,
      result.status,
      result.raw?.slice(0, 300)
    );

    return null;
  }

  const photo =
    result.data?.PhotoIdentifier;

  if (
    !photo ||
    !String(photo).trim()
  ) {
    console.log(
      `  ${productCode}: no photo found on base product either — genuinely missing`
    );

    return null;
  }

  return String(photo).trim();
}

// --------------------------------------------------
// SAVE SHOPIFY PRODUCT TAB
// --------------------------------------------------

async function saveShopifyProduct(
  shopifyProduct
) {
  const shopifyProductId =
    shopifyProduct.ShopifyProductID;

  if (!shopifyProductId) {
    throw new Error(
      "ShopifyProductID is missing"
    );
  }

  const url =
    `${TV_API}/v1/ShopifyProduct/${shopifyProductId}`;

  const result =
    await apiPost(
      url,
      shopifyProduct
    );

  if (
    result.status !== 200 &&
    result.status !== 201
  ) {
    throw new Error(
      `ShopifyProduct save failed (${result.status}): ${
        result.raw?.slice(0, 500) || ""
      }`
    );
  }

  return result;
}

// --------------------------------------------------
// LIST ONE EXISTING PRODUCT
// --------------------------------------------------

async function listExistingProductOnShopify(
  productCode,
  poNumber = null
) {
  console.log("");
  console.log(
    "========================================"
  );
  console.log(
    ` SHOPIFY OLD LISTING: ${productCode}`
  );
  console.log(
    "========================================"
  );

  if (isChildProduct(productCode)) {
    console.log(
      `  ${productCode}: SKIP — BOM child product`
    );

    return {
      ok: true,
      skipped: true,
      reason: "bom_child",
      productCode,
    };
  }

  // --------------------------------------------------
  // DETERMINE ACTIVE PO
  // --------------------------------------------------

  if (!poNumber) {
    const activeCycle =
      getActivePOForProduct(
        productCode
      );

    if (!activeCycle) {
      console.log(
        `  ${productCode}: BLOCKED — no active presale cycle`
      );

      return {
        ok: false,
        reason: "no_active_presale_cycle",
        productCode,
      };
    }

    poNumber =
      activeCycle.poNumber;
  }

  poNumber = String(poNumber)
    .trim()
    .toUpperCase();

  console.log(
    `  ${productCode}: Presale PO = ${poNumber}`
  );

  // --------------------------------------------------
  // CYCLE-SPECIFIC DUPLICATE PROTECTION
  // --------------------------------------------------

  if (
    wasPreviouslyListed(
      productCode,
      poNumber
    )
  ) {
    console.log(
      `  ${productCode}: SKIP — already listed for ${poNumber}`
    );

    return {
      ok: true,
      skipped: true,
      reason: "already_listed_for_cycle",
      productCode,
      poNumber,
    };
  }

  console.log(
    `  ${productCode}: new Shopify listing cycle detected`
  );

  let shopifyProduct =
    await findShopifyProductRecord(
      productCode
    );

  if (!shopifyProduct) {
    console.log(
      `  ${productCode}: BLOCKED — no ShopifyProduct record exists`
    );

    return {
      ok: false,
      reason: "no_shopify_record",
      productCode,
      poNumber,
    };
  }

  console.log(
    `  ${productCode}: ShopifyProduct found`
  );

  console.log(
    `  ShopifyProductID: ${shopifyProduct.ShopifyProductID}`
  );

  // --------------------------------------------------
  // IMPORTANT:
  // DO NOT USE IsListedOnShopify AS DUPLICATE PROTECTION.
  //
  // It may still be TRUE from an old cycle.
  // The PO + Product state above is the authority.
  // --------------------------------------------------

  console.log(
    `  ${productCode}: existing ShopifyProduct found — updating for current presale cycle`
  );

  // --------------------------------------------------
  // ADD DS
  // --------------------------------------------------

  const originalTitle =
    shopifyProduct.Title || "";

  const newTitle =
    addDSToTitle(
      originalTitle
    );

  if (
    newTitle !== originalTitle
  ) {
    console.log(
      `  ${productCode}: adding DS to title`
    );

    console.log(
      `    Before: ${originalTitle}`
    );

    console.log(
      `    After:  ${newTitle}`
    );

    shopifyProduct.Title =
      newTitle;

    try {
      await saveShopifyProduct(
        shopifyProduct
      );

      console.log(
        `  ${productCode}: DS title saved`
      );
    } catch (err) {
      console.log(
        `  ${productCode}: FAILED to save DS title`
      );

      console.log(
        `  ${err.message}`
      );

      return {
        ok: false,
        reason:
          "ds_title_save_failed",
        error: err.message,
        productCode,
        poNumber,
      };
    }
  } else {
    console.log(
      `  ${productCode}: DS already present in title`
    );
  }

  // --------------------------------------------------
  // IMAGE
  // --------------------------------------------------

  if (
    !shopifyProduct.PhotoIdentifier ||
    !String(
      shopifyProduct.PhotoIdentifier
    ).trim()
  ) {
    console.log(
      `  ${productCode}: Shopify tab has no image`
    );

    console.log(
      `  ${productCode}: checking base product image...`
    );

    const basePhoto =
      await getBaseProductPhoto(
        shopifyProduct,
        productCode
      );

    if (basePhoto) {
      console.log(
        `  ${productCode}: copying image "${basePhoto}"`
      );

      shopifyProduct.PhotoIdentifier =
        basePhoto;

      try {
        await saveShopifyProduct(
          shopifyProduct
        );

        console.log(
          `  ${productCode}: image saved to Shopify tab`
        );
      } catch (err) {
        console.log(
          `  ${productCode}: FAILED to save image`
        );

        console.log(
          `  ${err.message}`
        );

        return {
          ok: false,
          reason:
            "image_save_failed",
          error: err.message,
          productCode,
          poNumber,
        };
      }
    } else {
      console.log(
        `  ${productCode}: BLOCKED — no image available`
      );

      return {
        ok: false,
        reason:
          "validation_failed",
        missing: ["image"],
        productCode,
        poNumber,
      };
    }
  } else {
    console.log(
      `  ${productCode}: image already selected ✓`
    );
  }

  // --------------------------------------------------
  // VALIDATION
  // --------------------------------------------------

  const validation =
    validateShopifyFields(
      shopifyProduct
    );

  if (!validation.ok) {
    console.log(
      `  ${productCode}: BLOCKED — missing [${validation.missing.join(
        ", "
      )}]`
    );

    return {
      ok: false,
      reason:
        "validation_failed",
      missing:
        validation.missing,
      productCode,
      poNumber,
    };
  }

  console.log(
    `  ${productCode}: price ✓`
  );

  console.log(
    `  ${productCode}: description ✓`
  );

  console.log(
    `  ${productCode}: image ✓`
  );

  // --------------------------------------------------
  // TAGS
  // --------------------------------------------------

  const tags =
    buildTags(
      shopifyProduct.Title,
      shopifyProduct.Tags
    );

  shopifyProduct.Tags =
    tags;

  console.log(
    `  ${productCode}: setting tags: "${tags}"`
  );

  try {
    await saveShopifyProduct(
      shopifyProduct
    );

    console.log(
      `  ${productCode}: tags saved`
    );
  } catch (err) {
    console.log(
      `  ${productCode}: FAILED to save tags`
    );

    console.log(
      `  ${err.message}`
    );

    return {
      ok: false,
      reason:
        "tag_update_failed",
      error: err.message,
      productCode,
      poNumber,
    };
  }

  // --------------------------------------------------
  // RELOAD
  // --------------------------------------------------

  const fresh =
    await findShopifyProductRecord(
      productCode
    );

  if (!fresh) {
    console.log(
      `  ${productCode}: could not reload ShopifyProduct`
    );

    return {
      ok: false,
      reason:
        "reload_failed",
      productCode,
      poNumber,
    };
  }

  // --------------------------------------------------
  // VERIFY DS
  // --------------------------------------------------

  if (
    !/\bDS\b/i.test(
      fresh.Title || ""
    )
  ) {
    console.log(
      `  ${productCode}: BLOCKED — DS was not saved correctly`
    );

    return {
      ok: false,
      reason:
        "ds_not_saved",
      productCode,
      poNumber,
    };
  }

  console.log(
    `  ${productCode}: DS ✓`
  );

  // --------------------------------------------------
  // FINAL VALIDATION
  // --------------------------------------------------

  const finalValidation =
    validateShopifyFields(
      fresh
    );

  if (!finalValidation.ok) {
    console.log(
      `  ${productCode}: BLOCKED before listing — missing [${finalValidation.missing.join(
        ", "
      )}]`
    );

    return {
      ok: false,
      reason:
        "final_validation_failed",
      missing:
        finalValidation.missing,
      productCode,
      poNumber,
    };
  }

  console.log(
    `  ${productCode}: final validation ✓`
  );

  // --------------------------------------------------
  // VERIFY PRE-ORDER TAG
  // --------------------------------------------------

  const finalTags =
    String(
      fresh.Tags || ""
    )
      .split(",")
      .map(
        (tag) =>
          tag.trim().toLowerCase()
      )
      .filter(Boolean);

  if (
    !finalTags.includes(
      "pre-order-auckland"
    )
  ) {
    console.log(
      `  ${productCode}: Pre-Order-Auckland tag was not saved correctly`
    );

    return {
      ok: false,
      reason:
        "tag_not_saved",
      productCode,
      poNumber,
    };
  }

  console.log(
    `  ${productCode}: Pre-Order-Auckland tag ✓`
  );

  // --------------------------------------------------
  // LIST ON SHOPIFY
  // --------------------------------------------------

  fresh.IsListedOnShopify =
    true;

  console.log(
    `  ${productCode}: setting IsListedOnShopify = true`
  );

  try {
    await saveShopifyProduct(
      fresh
    );

    console.log(
      `  ${productCode}: Listed on Shopify = TRUE`
    );
  } catch (err) {
    console.log(
      `  ${productCode}: FAILED to list on Shopify`
    );

    console.log(
      `  ${err.message}`
    );

    return {
      ok: false,
      reason:
        "listing_failed",
      error: err.message,
      productCode,
      poNumber,
    };
  }

  // --------------------------------------------------
  // RECORD THIS SPECIFIC PO + PRODUCT CYCLE
  // --------------------------------------------------

  try {
    recordShopifyListed(
      productCode,
      poNumber,
      {
        shopifyProductId:
          fresh.ShopifyProductID,
      }
    );

    console.log(
      `  ${productCode}: permanently recorded as shopify-listed for ${poNumber}`
    );
  } catch (err) {
    console.log(
      `  ${productCode}: WARNING — Shopify listing succeeded but state record failed`
    );

    console.log(
      `  ${err.message}`
    );

    return {
      ok: true,
      warning:
        "shopify_listed_but_state_record_failed",
      productCode,
      poNumber,
      shopifyProductId:
        fresh.ShopifyProductID,
    };
  }

  console.log(
    `  ${productCode}: ✓ Shopify listing completed`
  );

  console.log(
    "========================================"
  );

  return {
    ok: true,
    productCode,
    poNumber,
    shopifyProductId:
      fresh.ShopifyProductID,
    title: fresh.Title,
    tags: fresh.Tags,
    image: fresh.PhotoIdentifier,
    isListed:
      fresh.IsListedOnShopify,
  };
}

// --------------------------------------------------
// PROCESS ALL ELIGIBLE PRODUCTS
// --------------------------------------------------

async function processProcessedProductsForShopify() {
  console.log("");
  console.log(
    "========================================"
  );
  console.log(
    " SHOPIFY OLD LISTING AUTOMATION"
  );
  console.log(
    "========================================"
  );
  console.log("");

  const products =
    getProcessedProductsFromState();

  if (!products.length) {
    console.log(
      `No processed products found in ${STATE_FILE}.`
    );

    return [];
  }

  console.log(
    `Found ${products.length} processed product(s):`
  );

  products.forEach(
    (code) =>
      console.log(`  - ${code}`)
  );

  const results = [];

  for (const productCode of products) {
    try {
      const activeCycle =
        getActivePOForProduct(
          productCode
        );

      if (!activeCycle) {
        console.log(
          `${productCode}: SKIPPED — no active presale cycle`
        );

        results.push({
          ok: true,
          skipped: true,
          reason:
            "no_active_presale_cycle",
          productCode,
        });

        continue;
      }

      const result =
        await listExistingProductOnShopify(
          productCode,
          activeCycle.poNumber
        );

      results.push(result);
    } catch (err) {
      console.error(
        `${productCode}: unexpected Shopify listing error:`,
        err.message
      );

      results.push({
        ok: false,
        productCode,
        reason:
          "script_error",
        error: err.message,
      });
    }
  }

  return results;
}

// --------------------------------------------------
// EXPORTS
// --------------------------------------------------

module.exports = {
  listExistingProductOnShopify,
  processProcessedProductsForShopify,
  getProcessedProductsFromState,
  getActivePOForProduct,
  wasPreviouslyListed,
  recordShopifyListed,
  getShopifyListingStateKey,
  buildTags,
  validateShopifyFields,
  addDSToTitle,
  isChildProduct,
};

// --------------------------------------------------
// RUN DIRECTLY
// --------------------------------------------------

if (require.main === module) {
  processProcessedProductsForShopify()
    .then(() => {
      console.log("");
      console.log(
        "Shopify listing script finished."
      );
      console.log("");
    })
    .catch((err) => {
      console.error(
        "SCRIPT CRASHED:",
        err.message
      );

      console.error(err);

      process.exit(1);
    });
}