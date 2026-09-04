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

// Christchurch processed state
const CHCH_STATE_FILE = path.join(
  __dirname,
  "../json/CHCH/processed-state-chch.json"
);

// Separate state for this tagging operation
const TAG_STATE_FILE = path.join(
  __dirname,
  "../json/CHCH/chch-tag-akl-state.json"
);

const TV_API = "https://api.tradevine.com";

// Tag we want to add to the AKL Shopify tab
const REQUIRED_TAG = "Pre-Order-Christchurch";

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
// LOAD CHRISTCHURCH PROCESSED STATE
// ============================================================

function loadChristchurchState() {
  if (!fs.existsSync(CHCH_STATE_FILE)) {
    throw new Error(
      `Could not find Christchurch state file: ${CHCH_STATE_FILE}`
    );
  }

  try {
    return JSON.parse(
      fs.readFileSync(CHCH_STATE_FILE, "utf8")
    );
  } catch (err) {
    throw new Error(
      `Could not read Christchurch processed state: ${err.message}`
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
      fs.readFileSync(TAG_STATE_FILE, "utf8")
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
    JSON.stringify(state, null, 2)
  );
}

// ============================================================
// EXTRACT PRODUCT CODE FROM STATE KEY
// ============================================================

function extractProductCode(key) {
  if (!key) {
    return null;
  }

  // inv:PO1589:PR13374
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

  // title:PR13374
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
// EXTRACT PO NUMBER FROM INV KEY
// ============================================================

function extractPoNumber(key) {
  if (!key || !key.startsWith("inv:")) {
    return null;
  }

  const parts = key.split(":");

  if (parts.length >= 3) {
    return parts[1].trim();
  }

  return null;
}

// ============================================================
// CHILD PRODUCT CHECK
// ============================================================

function isChildProduct(productCode) {
  return /^PR\d+-[A-Z]$/i.test(
    String(productCode || "").trim()
  );
}

// ============================================================
// GET COMPLETED INVENTORY CYCLES
// ============================================================
//
// Example:
//
// inv:PO1589:PR13374
// inv:PO1595:PR13374
//
// Both remain in state.
//
// The newest completed inventory record is the
// current cycle.
// ============================================================

function getCompletedInventoryCycles(
  productCode,
  state
) {
  return Object.keys(state)
    .filter(
      (key) =>
        key.startsWith("inv:") &&
        key.endsWith(`:${productCode}`)
    )
    .map((key) => {
      const entry = state[key];

      return {
        key,
        poNumber: extractPoNumber(key),
        date:
          entry?.date ||
          entry?.processedDate ||
          "",
        supplier: entry?.supplier || "",
        entry,
      };
    })
    .filter(
      (cycle) =>
        cycle.entry?.done === true &&
        cycle.poNumber
    )
    .sort((a, b) => {
      const aTime = Date.parse(
        a.date || ""
      );

      const bTime = Date.parse(
        b.date || ""
      );

      return (
        (Number.isNaN(bTime)
          ? 0
          : bTime) -
        (Number.isNaN(aTime)
          ? 0
          : aTime)
      );
    });
}

// ============================================================
// GET CURRENT CYCLE FOR PRODUCT
// ============================================================

function getCurrentCycleForProduct(
  productCode,
  state
) {
  const cycles =
    getCompletedInventoryCycles(
      productCode,
      state
    );

  return cycles[0] || null;
}

// ============================================================
// GET CURRENT BOM CYCLE
// ============================================================
//
// BOM parents do not normally have their own inv:
// record.
//
// Example:
//
// inv:PO1589:PR15242-A
// inv:PO1589:PR15242-B
// bom:PR15242
//
// The BOM cycle is determined from the children.
//
// All children must have the same current PO.
// ============================================================

function getCurrentBomCycle(
  parentCode,
  state
) {
  const childCodes = Object.keys(state)
    .filter(
      (key) =>
        key.startsWith("inv:")
    )
    .map((key) =>
      extractProductCode(key)
    )
    .filter(Boolean)
    .filter(
      (code) =>
        isChildProduct(code) &&
        code.startsWith(
          `${parentCode}-`
        )
    );

  const uniqueChildCodes = [
    ...new Set(childCodes),
  ];

  if (
    uniqueChildCodes.length === 0
  ) {
    return {
      ready: false,
      reason: "no_bom_children_found",
      childCycles: [],
      poNumber: null,
    };
  }

  const childCycles = [];

  for (const childCode of uniqueChildCodes) {
    const cycle =
      getCurrentCycleForProduct(
        childCode,
        state
      );

    if (!cycle) {
      return {
        ready: false,
        reason: `no_completed_cycle_for_${childCode}`,
        childCycles,
        poNumber: null,
      };
    }

    childCycles.push({
      childCode,
      cycle,
    });
  }

  const poNumbers = [
    ...new Set(
      childCycles.map(
        (item) =>
          String(
            item.cycle.poNumber
          ).toUpperCase()
      )
    ),
  ];

  if (poNumbers.length !== 1) {
    return {
      ready: false,
      reason: "bom_children_different_cycles",
      childCycles,
      poNumber: null,
      poNumbers,
    };
  }

  return {
    ready: true,
    reason: null,
    childCycles,
    poNumber:
      childCycles[0].cycle.poNumber,
    poNumbers,
  };
}

// ============================================================
// BUILD CURRENT CHCH PRODUCT CYCLES
// ============================================================
//
// Returns only parent/standalone products.
//
// BOM children are excluded.
//
// Example result:
//
// [
//   {
//     productCode: "PR13374",
//     poNumber: "PO1595",
//     type: "standalone"
//   },
//   {
//     productCode: "PR15242",
//     poNumber: "PO1595",
//     type: "bom"
//   }
// ]
// ============================================================

function getCurrentChchProducts(
  state
) {
  const products = new Map();

  // ----------------------------------------------------------
  // STANDALONE PRODUCTS
  // ----------------------------------------------------------

  for (const key of Object.keys(state)) {
    if (!key.startsWith("inv:")) {
      continue;
    }

    const productCode =
      extractProductCode(key);

    if (!productCode) {
      continue;
    }

    // Children are handled through their BOM parent.
    if (
      isChildProduct(productCode)
    ) {
      continue;
    }

    const cycle =
      getCurrentCycleForProduct(
        productCode,
        state
      );

    if (!cycle) {
      continue;
    }

    products.set(
      productCode,
      {
        productCode,
        poNumber: cycle.poNumber,
        type: "standalone",
      }
    );
  }

  // ----------------------------------------------------------
  // BOM PARENTS
  // ----------------------------------------------------------

  for (const key of Object.keys(state)) {
    if (!key.startsWith("bom:")) {
      continue;
    }

    const parentCode =
      key.replace(/^bom:/i, "")
        .trim()
        .toUpperCase();

    if (!parentCode) {
      continue;
    }

    const bomCycle =
      getCurrentBomCycle(
        parentCode,
        state
      );

    if (!bomCycle.ready) {
      console.log(
        `${parentCode}: could not determine current BOM cycle — ${bomCycle.reason}`
      );

      continue;
    }

    products.set(
      parentCode,
      {
        productCode: parentCode,
        poNumber: bomCycle.poNumber,
        type: "bom",
      }
    );
  }

  return Array.from(
    products.values()
  );
}

// ============================================================
// GET TAG STATE KEY
// ============================================================
//
// IMPORTANT:
//
// Product alone is NOT enough.
//
// Cycle 1:
// tag:PO1589:PR13374
//
// Cycle 2:
// tag:PO1595:PR13374
// ============================================================

function getTagStateKey(
  productCode,
  poNumber
) {
  return `tag:${poNumber}:${productCode}`;
}

// ============================================================
// CHECK WHETHER CURRENT CYCLE WAS ALREADY TAGGED
// ============================================================

function isCycleAlreadyTagged(
  productCode,
  poNumber,
  tagState
) {
  const key =
    getTagStateKey(
      productCode,
      poNumber
    );

  return (
    tagState[key]?.done === true
  );
}

// ============================================================
// FIND AKL SHOPIFY PRODUCT RECORD
// ============================================================

async function findAklShopifyProduct(
  productCode
) {
  const url =
    `${TV_API}/v1/ShopifyProduct` +
    `?productCode=${encodeURIComponent(
      productCode
    )}` +
    `&pageSize=100`;

  console.log("");
  console.log("GET:");
  console.log(url);

  const result =
    await apiGet(url);

  console.log(
    `HTTP: ${result.status}`
  );

  if (
    result.status !== 200
  ) {
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

  return (
    list.find(
      (item) =>
        String(
          item.ProductCode || ""
        ).toUpperCase() ===
        String(
          productCode
        ).toUpperCase()
    ) || null
  );
}

// ============================================================
// BUILD TAG LIST
// ============================================================

function addChristchurchTag(
  existingTags
) {
  const tags = [];

  if (existingTags) {
    String(existingTags)
      .split(",")
      .map((tag) =>
        tag.trim()
      )
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

  if (
    !tags.some(
      (tag) =>
        tag.toLowerCase() ===
        REQUIRED_TAG.toLowerCase()
    )
  ) {
    tags.push(
      REQUIRED_TAG
    );
  }

  return tags.join(", ");
}

// ============================================================
// SAVE AKL SHOPIFY TAB
// ============================================================

async function saveAklShopifyProduct(
  shopifyProduct
) {
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

  const result =
    await apiPost(
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
        result.raw?.slice(
          0,
          500
        ) || ""
      }`
    );
  }

  return result;
}

// ============================================================
// VERIFY TAG
// ============================================================

async function verifyChristchurchTag(
  productCode
) {
  const fresh =
    await findAklShopifyProduct(
      productCode
    );

  if (!fresh) {
    throw new Error(
      "Could not reload ShopifyProduct after save"
    );
  }

  const tags =
    String(
      fresh.Tags || ""
    )
      .split(",")
      .map((tag) =>
        tag.trim().toLowerCase()
      )
      .filter(Boolean);

  if (
    !tags.includes(
      REQUIRED_TAG.toLowerCase()
    )
  ) {
    throw new Error(
      `${REQUIRED_TAG} was not found after reload`
    );
  }

  return fresh;
}

// ============================================================
// TAG ONE PRODUCT
// ============================================================

async function tagProduct(
  productCode,
  poNumber,
  type,
  tagState
) {
  console.log("");
  console.log(
    "========================================"
  );
  console.log(
    `PROCESSING ${productCode}`
  );
  console.log(
    `CURRENT CHCH CYCLE: ${poNumber}`
  );
  console.log(
    `TYPE: ${type}`
  );
  console.log(
    "========================================"
  );

  const tagStateKey =
    getTagStateKey(
      productCode,
      poNumber
    );

  // ----------------------------------------------------------
  // CYCLE-SPECIFIC STATE CHECK
  // ----------------------------------------------------------

  if (
    isCycleAlreadyTagged(
      productCode,
      poNumber,
      tagState
    )
  ) {
    console.log(
      `${productCode}: already tagged for ${poNumber} — SKIPPING`
    );

    return {
      ok: true,
      skipped: true,
    };
  }

  // ----------------------------------------------------------
  // FIND AKL SHOPIFY PRODUCT
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
      reason:
        "no_akl_shopify_record",
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
  // CHECK EXISTING TAG
  // ----------------------------------------------------------

  const existingTags =
    String(
      shopifyProduct.Tags || ""
    )
      .split(",")
      .map((tag) =>
        tag.trim().toLowerCase()
      )
      .filter(Boolean);

  if (
    existingTags.includes(
      REQUIRED_TAG.toLowerCase()
    )
  ) {
    console.log(
      `${productCode}: ${REQUIRED_TAG} already exists ✓`
    );

    tagState[tagStateKey] = {
      done: true,
      alreadyPresent: true,
      date:
        new Date().toISOString(),
      productCode,
      poNumber,
      type,
      shopifyProductId:
        String(
          shopifyProduct.ShopifyProductID
        ),
    };

    saveTagState(
      tagState
    );

    return {
      ok: true,
      alreadyPresent: true,
    };
  }

  // ----------------------------------------------------------
  // ADD TAG
  // ----------------------------------------------------------

  const newTags =
    addChristchurchTag(
      shopifyProduct.Tags
    );

  console.log("");
  console.log(
    `New tags: "${newTags}"`
  );

  shopifyProduct.Tags =
    newTags;

  // ----------------------------------------------------------
  // SAVE
  // ----------------------------------------------------------

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
      reason:
        "tag_save_failed",
      error: err.message,
    };
  }

  // ----------------------------------------------------------
  // VERIFY
  // ----------------------------------------------------------

  try {
    const fresh =
      await verifyChristchurchTag(
        productCode
      );

    console.log("");
    console.log(
      `${productCode}: ${REQUIRED_TAG} verified ✓`
    );

    console.log(
      `Final tags: "${fresh.Tags}"`
    );

    tagState[tagStateKey] = {
      done: true,
      date:
        new Date().toISOString(),
      productCode,
      poNumber,
      type,
      shopifyProductId:
        String(
          fresh.ShopifyProductID
        ),
      tags: fresh.Tags,
    };

    saveTagState(
      tagState
    );

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
      reason:
        "verification_failed",
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
    " CHCH → AKL SHOPIFY TAG AUTOMATION"
  );
  console.log(
    " + CYCLE 1 / CYCLE 2 SUPPORT"
  );
  console.log(
    "=============================================="
  );

  // ----------------------------------------------------------
  // ENV CHECK
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
  // LOAD STATE
  // ----------------------------------------------------------

  const chchState =
    loadChristchurchState();

  const products =
    getCurrentChchProducts(
      chchState
    );

  console.log("");
  console.log(
    `Found ${products.length} current CHCH product cycle(s) in processed state.`
  );

  if (
    products.length === 0
  ) {
    console.log(
      "Nothing to process."
    );

    return;
  }

  // ----------------------------------------------------------
  // DISPLAY CURRENT CYCLES
  // ----------------------------------------------------------

  console.log("");
  console.log(
    "Current CHCH cycles to check in AKL:"
  );

  for (const product of products) {
    console.log(
      `  - ${product.productCode} → ${product.poNumber} (${product.type})`
    );
  }

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

  for (const product of products) {
    try {
      const result =
        await tagProduct(
          product.productCode,
          product.poNumber,
          product.type,
          tagState
        );

      if (result.ok) {
        if (
          result.skipped ||
          result.alreadyPresent
        ) {
          alreadyDone++;
        } else {
          tagged++;
        }
      } else {
        blocked++;
      }
    } catch (err) {
      blocked++;

      console.log("");
      console.log(
        `${product.productCode}: ERROR`
      );

      console.log(
        err.message
      );
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
    " CHCH → AKL TAGGING COMPLETE"
  );
  console.log(
    "=============================================="
  );

  console.log(
    `Current CHCH products: ${products.length}`
  );

  console.log(
    `Newly tagged:          ${tagged}`
  );

  console.log(
    `Already tagged:        ${alreadyDone}`
  );

  console.log(
    `Blocked/failed:        ${blocked}`
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
    " CHCH → AKL TAGGING FAILED"
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

