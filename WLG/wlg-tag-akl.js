require("dotenv").config();

const fs = require("fs");
const path = require("path");
const OAuth = require("oauth-1.0a");
const crypto = require("crypto");
const JSONbig = require("json-bigint")({
  storeAsString: true,
});

// ============================================================
// CONFIG
// ============================================================

// Wellington ../json/WLG/processed-state-wlg.json
const WLG_STATE_FILE = path.join(
  __dirname,
  "../json/WLG/processed-state-wlg.json"
);

// Separate state for this tagging operation
const TAG_STATE_FILE = path.join(
  __dirname,
  "../json/WLG/wlg-tag-akl-state.json"
);

const TV_API = "https://api.tradevine.com";

// Tag we want to add to the AKL Shopify tab
const REQUIRED_TAG = "Pre-Order-Wellington";

// ============================================================
// AUCKLAND TRADEVINE OAUTH
// ============================================================

const oauth = OAuth({
  consumer: {
    key: process.env.TV_CONSUMER_KEY,
    secret: process.env.TV_CONSUMER_SECRET,
  },

  signature_method: "HMAC-SHA1",

  hash_function: (base, key) =>
    crypto
      .createHmac("sha1", key)
      .update(base)
      .digest("base64"),
});

const token = {
  key: process.env.TV_ACCESS_TOKEN,
  secret: process.env.TV_ACCESS_TOKEN_SECRET,
};

// ============================================================
// API GET
// ============================================================

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

  let data = null;

  try {
    data = JSONbig.parse(text);
  } catch {
    data = null;
  }

  return {
    status: res.status,
    data,
    raw: text,
  };
}

// ============================================================
// API POST
// ============================================================

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

  let data = null;

  try {
    data = JSONbig.parse(text);
  } catch {
    data = null;
  }

  return {
    status: res.status,
    data,
    raw: text,
  };
}

// ============================================================
// LOAD WELLINGTON PROCESSED STATE
// ============================================================

function loadWellingtonState() {
  if (!fs.existsSync(WLG_STATE_FILE)) {
    throw new Error(
      `Could not find Wellington state file: ${WLG_STATE_FILE}`
    );
  }

  try {
    return JSON.parse(
      fs.readFileSync(
        WLG_STATE_FILE,
        "utf8"
      )
    );
  } catch (err) {
    throw new Error(
      `Could not read Wellington ../json/WLG/processed-state-wlg.json: ${err.message}`
    );
  }
}

// ============================================================
// LOAD TAG STATE
// ============================================================

function loadTagState() {
  if (!fs.existsSync(TAG_STATE_FILE)) {
    return {};
  }

  try {
    return JSON.parse(
      fs.readFileSync(
        TAG_STATE_FILE,
        "utf8"
      )
    );
  } catch {
    return {};
  }
}

// ============================================================
// SAVE TAG STATE
// ============================================================

function saveTagState(state) {
  fs.writeFileSync(
    TAG_STATE_FILE,
    JSON.stringify(
      state,
      null,
      2
    )
  );
}

// ============================================================
// EXTRACT PRODUCT CODE
// ============================================================

function extractProductCode(key) {
  if (!key) {
    return null;
  }

  // inv:PO1560:PR15242
  if (key.startsWith("inv:")) {
    const parts = key.split(":");

    if (parts.length >= 3) {
      return parts
        .slice(2)
        .join(":")
        .trim()
        .toUpperCase();
    }
  }

  // title:PR15242
  if (key.startsWith("title:")) {
    return key
      .replace(/^title:/i, "")
      .trim()
      .toUpperCase();
  }

  // bom:PR15242
  if (key.startsWith("bom:")) {
    return key
      .replace(/^bom:/i, "")
      .trim()
      .toUpperCase();
  }

  return null;
}

// ============================================================
// CHILD PRODUCT CHECK
// ============================================================
//
// PR15242-A
// PR15242-B
//
// These are NOT tagged individually.
// Only PR15242 is tagged.
//

function isChildProduct(productCode) {
  return /^PR\d+-[A-Z]$/i.test(
    String(productCode || "").trim()
  );
}

// ============================================================
// GET PRODUCTS THAT WERE ACTIONED IN WELLINGTON
// ============================================================

function getActionedProducts(state) {
  const products = new Set();

  for (const [key, value] of Object.entries(state)) {
    if (!value || value.done !== true) {
      continue;
    }

    const productCode =
      extractProductCode(key);

    if (!productCode) {
      continue;
    }

    // Never tag BOM children
    if (isChildProduct(productCode)) {
      continue;
    }

    products.add(productCode);
  }

  return Array.from(products);
}

// ============================================================
// FIND AKL SHOPIFY PRODUCT RECORD
// ============================================================

async function findAklShopifyProduct(productCode) {
  const url =
    `${TV_API}/v1/ShopifyProduct` +
    `?productCode=${encodeURIComponent(productCode)}` +
    `&pageSize=100`;

  console.log("");
  console.log("GET:");
  console.log(url);

  const result = await apiGet(url);

  console.log(
    `HTTP: ${result.status}`
  );

  if (result.status !== 200) {
    console.log(
      "Response:",
      result.raw?.slice(0, 500)
    );

    return null;
  }

  const list =
    result.data?.List ||
    result.data?.list ||
    [];

  const record = list.find(
    (item) =>
      String(item.ProductCode || "")
        .toUpperCase() ===
      String(productCode)
        .toUpperCase()
  );

  return record || null;
}

// ============================================================
// BUILD TAG LIST
// ============================================================

function addWellingtonTag(existingTags) {
  const tags = [];

  if (existingTags) {
    String(existingTags)
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
      .forEach((tag) => {
        if (
          !tags.some(
            (existing) =>
              existing.toLowerCase() ===
              tag.toLowerCase()
          )
        ) {
          tags.push(tag);
        }
      });
  }

  // Do not duplicate tag
  if (
    !tags.some(
      (tag) =>
        tag.toLowerCase() ===
        REQUIRED_TAG.toLowerCase()
    )
  ) {
    tags.push(REQUIRED_TAG);
  }

  return tags.join(", ");
}

// ============================================================
// SAVE AKL SHOPIFY TAB
// ============================================================

async function saveAklShopifyProduct(shopifyProduct) {
  const shopifyProductId =
    shopifyProduct.ShopifyProductID;

  if (!shopifyProductId) {
    throw new Error(
      "ShopifyProductID missing"
    );
  }

  const url =
    `${TV_API}/v1/ShopifyProduct/${shopifyProductId}`;

  console.log("");
  console.log("POST:");
  console.log(url);

  const result = await apiPost(
    url,
    shopifyProduct
  );

  console.log(
    `HTTP: ${result.status}`
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

// ============================================================
// VERIFY TAG
// ============================================================

async function verifyWellingtonTag(productCode) {
  const fresh =
    await findAklShopifyProduct(
      productCode
    );

  if (!fresh) {
    throw new Error(
      "Could not reload ShopifyProduct after save"
    );
  }

  const tags = String(
    fresh.Tags || ""
  )
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);

  const found =
    tags.includes(
      REQUIRED_TAG.toLowerCase()
    );

  if (!found) {
    throw new Error(
      `${REQUIRED_TAG} was not found after reload`
    );
  }

  return fresh;
}

// ============================================================
// TAG ONE PRODUCT
// ============================================================

async function tagProduct(productCode, tagState) {
  console.log("");
  console.log(
    "========================================"
  );
  console.log(
    `PROCESSING ${productCode}`
  );
  console.log(
    "========================================"
  );

  // ----------------------------------------------------------
  // SAFETY: already completed
  // ----------------------------------------------------------

  if (
    tagState[productCode]?.done === true
  ) {
    console.log(
      `${productCode}: already tagged previously — SKIPPING`
    );

    return {
      ok: true,
      skipped: true,
    };
  }

  // ----------------------------------------------------------
  // FIND AKL SHOPIFY TAB
  // ----------------------------------------------------------

  const shopifyProduct =
    await findAklShopifyProduct(
      productCode
    );

  if (!shopifyProduct) {
    console.log(
      `${productCode}: BLOCKED — no AKL ShopifyProduct record found`
    );

    return {
      ok: false,
      reason: "no_akl_shopify_record",
    };
  }

  console.log("");
  console.log(
    `${productCode}: AKL ShopifyProduct found`
  );

  console.log(
    `ShopifyProductID: ${shopifyProduct.ShopifyProductID}`
  );

  console.log(
    `Current tags: "${shopifyProduct.Tags || ""}"`
  );

  // ----------------------------------------------------------
  // ADD WELLINGTON TAG
  // ----------------------------------------------------------

  const newTags =
    addWellingtonTag(
      shopifyProduct.Tags
    );

  console.log("");
  console.log(
    `New tags: "${newTags}"`
  );

  // ----------------------------------------------------------
  // ALREADY HAS TAG
  // ----------------------------------------------------------

  if (
    String(shopifyProduct.Tags || "")
      .split(",")
      .map((tag) => tag.trim().toLowerCase())
      .includes(
        REQUIRED_TAG.toLowerCase()
      )
  ) {
    console.log(
      `${productCode}: ${REQUIRED_TAG} already exists ✓`
    );

    tagState[productCode] = {
      done: true,
      alreadyPresent: true,
      date: new Date().toISOString(),
      shopifyProductId:
        String(
          shopifyProduct.ShopifyProductID
        ),
    };

    saveTagState(tagState);

    return {
      ok: true,
      alreadyPresent: true,
    };
  }

  // ----------------------------------------------------------
  // SAVE
  // ----------------------------------------------------------

  shopifyProduct.Tags =
    newTags;

  try {
    await saveAklShopifyProduct(
      shopifyProduct
    );

    console.log("");
    console.log(
      `${productCode}: tag save successful ✓`
    );
  } catch (err) {
    console.log("");
    console.log(
      `${productCode}: TAG SAVE FAILED`
    );

    console.log(
      err.message
    );

    return {
      ok: false,
      reason: "tag_save_failed",
      error: err.message,
    };
  }

  // ----------------------------------------------------------
  // RELOAD + VERIFY
  // ----------------------------------------------------------

  try {
    const fresh =
      await verifyWellingtonTag(
        productCode
      );

    console.log("");
    console.log(
      `${productCode}: ${REQUIRED_TAG} verified ✓`
    );

    console.log(
      `Final tags: "${fresh.Tags}"`
    );

    // --------------------------------------------------------
    // ONLY MARK DONE AFTER VERIFICATION
    // --------------------------------------------------------

    tagState[productCode] = {
      done: true,
      date: new Date().toISOString(),
      shopifyProductId:
        String(
          fresh.ShopifyProductID
        ),
      tags:
        fresh.Tags,
    };

    saveTagState(tagState);

    return {
      ok: true,
      tags: fresh.Tags,
    };
  } catch (err) {
    console.log("");
    console.log(
      `${productCode}: VERIFICATION FAILED`
    );

    console.log(
      err.message
    );

    return {
      ok: false,
      reason: "verification_failed",
      error: err.message,
    };
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("");
  console.log(
    "=============================================="
  );
  console.log(
    " WLG → AKL SHOPIFY TAG AUTOMATION"
  );
  console.log(
    "=============================================="
  );

  // ----------------------------------------------------------
  // CHECK AKL CREDENTIALS
  // ----------------------------------------------------------

  const requiredEnv = [
    "TV_CONSUMER_KEY",
    "TV_CONSUMER_SECRET",
    "TV_ACCESS_TOKEN",
    "TV_ACCESS_TOKEN_SECRET",
  ];

  for (const name of requiredEnv) {
    if (!process.env[name]) {
      throw new Error(
        `Missing ${name} in .env`
      );
    }
  }

  console.log("");
  console.log(
    "✓ Auckland Tradevine credentials found"
  );

  // ----------------------------------------------------------
  // LOAD WELLINGTON STATE
  // ----------------------------------------------------------

  const wlgState =
    loadWellingtonState();

  const products =
    getActionedProducts(
      wlgState
    );

  console.log("");
  console.log(
    `Found ${products.length} eligible WLG product(s) in ../json/WLG/processed-state-wlg.json.`
  );

  if (products.length === 0) {
    console.log(
      "Nothing to process."
    );

    return;
  }

  console.log("");
  console.log(
    "Products to check in AKL:"
  );

  products.forEach((code) => {
    console.log(
      `  - ${code}`
    );
  });

  // ----------------------------------------------------------
  // LOAD TAG STATE
  // ----------------------------------------------------------

  const tagState =
    loadTagState();

  let tagged = 0;
  let alreadyDone = 0;
  let blocked = 0;

  // ----------------------------------------------------------
  // PROCESS
  // ----------------------------------------------------------

  for (const productCode of products) {
    const result =
      await tagProduct(
        productCode,
        tagState
      );

    if (result.ok) {
      if (result.skipped || result.alreadyPresent) {
        alreadyDone++;
      } else {
        tagged++;
      }
    } else {
      blocked++;
    }

    console.log("");
  }

  // ----------------------------------------------------------
  // SUMMARY
  // ----------------------------------------------------------

  console.log("");
  console.log(
    "=============================================="
  );
  console.log(
    " WLG → AKL TAGGING COMPLETE"
  );
  console.log(
    "=============================================="
  );

  console.log(
    `Total WLG products: ${products.length}`
  );

  console.log(
    `Newly tagged:       ${tagged}`
  );

  console.log(
    `Already tagged:     ${alreadyDone}`
  );

  console.log(
    `Blocked/failed:     ${blocked}`
  );

  console.log("");

  console.log(
    `Required tag: ${REQUIRED_TAG}`
  );

  console.log(
    `Tag state saved to: ${TAG_STATE_FILE}`
  );

  console.log(
    "=============================================="
  );
}

// ============================================================
// RUN
// ============================================================

main().catch((err) => {
  console.error("");
  console.error(
    "=============================================="
  );
  console.error(
    " WLG → AKL TAGGING FAILED"
  );
  console.error(
    "=============================================="
  );

  console.error(
    err.stack ||
      err.message ||
      err
  );

  process.exit(1);
});