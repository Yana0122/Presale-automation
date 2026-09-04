require("dotenv").config();

const fs = require("fs");
const path = require("path");
const OAuth = require("oauth-1.0a");
const crypto = require("crypto");
const JSONbig = require("json-bigint")({
  storeAsString: true,
});

// ==================================================
// FILES
// ==================================================

const PROCESSED_STATE_FILE = path.join(
  __dirname,
  "../json/WLG/processed-state-wlg.json"
);

const METAFIELD_RESULTS_FILE = path.join(
  __dirname,
  "../json/WLG/delivery-metafield-results-wlg.json"
);

// ==================================================
// TRADEVINE OAUTH
// ==================================================

const oauth = OAuth({
  consumer: {
    key: process.env.WLG_TV_CONSUMER_KEY,
    secret: process.env.WLG_TV_CONSUMER_SECRET,
  },

  signature_method: "HMAC-SHA1",

  hash_function: (base, key) =>
    crypto
      .createHmac("sha1", key)
      .update(base)
      .digest("base64"),
});

const token = {
  key: process.env.WLG_TV_ACCESS_TOKEN,
  secret: process.env.WLG_TV_ACCESS_TOKEN_SECRET,
};

// ==================================================
// SHOPIFY
// ==================================================

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

const API_VERSION = "2026-07";

// ==================================================
// TRADEVINE GET
// ==================================================

async function tvApiGet(url) {
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
      "User-Agent": "TSB-Living-WLG",
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

// ==================================================
// SHOPIFY GRAPHQL
// ==================================================

async function shopifyGraphQL(query, variables = {}) {
  if (!SHOPIFY_STORE) {
    throw new Error("SHOPIFY_STORE is missing from .env");
  }

  if (!SHOPIFY_TOKEN) {
    throw new Error("SHOPIFY_ACCESS_TOKEN is missing from .env");
  }

  const url =
    `https://${SHOPIFY_STORE}` +
    `/admin/api/${API_VERSION}/graphql.json`;

  const res = await fetch(url, {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_TOKEN,
    },

    body: JSON.stringify({
      query,
      variables,
    }),
  });

  const text = await res.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Shopify returned invalid JSON (HTTP ${res.status}): ${text.slice(
        0,
        1000
      )}`
    );
  }

  if (!res.ok) {
    throw new Error(
      `Shopify GraphQL HTTP ${res.status}: ${text.slice(
        0,
        1000
      )}`
    );
  }

  if (data.errors) {
    console.log(
      "GraphQL errors:",
      JSON.stringify(data.errors, null, 2)
    );
  }

  return data;
}

// ==================================================
// ADD DAYS
// ==================================================

function addDays(dateStr, days) {
  const d = new Date(dateStr);

  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${dateStr}`);
  }

  d.setDate(d.getDate() + days);

  return d.toISOString().slice(0, 10);
}

// ==================================================
// CHILD PRODUCT CHECK
// ==================================================
//
// PR15242-A
// PR15242-B
//
// These are BOM children and must NOT receive
// their own delivery metafield.
// ==================================================

function isChildProduct(productCode) {
  return /^PR\d+-[A-Z]$/i.test(
    String(productCode || "").trim()
  );
}

// ==================================================
// LOAD PROCESSED STATE
// ==================================================

function loadProcessedState() {
  if (!fs.existsSync(PROCESSED_STATE_FILE)) {
    console.log(
      `ERROR: ${PROCESSED_STATE_FILE} not found.`
    );

    return {};
  }

  try {
    const data = JSON.parse(
      fs.readFileSync(
        PROCESSED_STATE_FILE,
        "utf8"
      )
    );

    if (
      !data ||
      Array.isArray(data) ||
      typeof data !== "object"
    ) {
      console.log(
        "ERROR: processed-state-wlg.json must contain an object."
      );

      return {};
    }

    return data;
  } catch (err) {
    console.error(
      "Could not read processed-state-wlg.json:",
      err.message
    );

    return {};
  }
}

// ==================================================
// GET COMPLETED INVENTORY CYCLES
// ==================================================
//
// We intentionally keep ALL completed inventory records.
//
// Example:
//
// inv:PO1560:PR13374
// inv:PO1620:PR13374
//
// These represent two separate cycles.
//
// We do NOT use productCode as the unique key here.
// ==================================================

function getCompletedInventoryCycles(state) {
  const cycles = [];

  for (const [key, value] of Object.entries(state)) {
    // ------------------------------------------------
    // Must be completed
    // ------------------------------------------------

    if (!value || value.done !== true) {
      continue;
    }

    // ------------------------------------------------
    // Only inventory records
    // ------------------------------------------------

    if (!key.startsWith("inv:")) {
      continue;
    }

    const parts = key.split(":");

    if (parts.length < 3) {
      console.log(
        `Ignoring invalid state key: ${key}`
      );

      continue;
    }

    // ------------------------------------------------
    // Extract PO
    // ------------------------------------------------

    const poNumber = parts[1]
      .trim()
      .toUpperCase();

    // ------------------------------------------------
    // Extract product code
    // ------------------------------------------------

    const productCode = parts
      .slice(2)
      .join(":")
      .trim()
      .toUpperCase();

    if (!poNumber || !productCode) {
      continue;
    }

    // ------------------------------------------------
    // Ignore BOM children
    // ------------------------------------------------

    if (isChildProduct(productCode)) {
      console.log(
        `Ignoring BOM child: ${productCode}`
      );

      continue;
    }

    // ------------------------------------------------
    // Store complete cycle
    // ------------------------------------------------

    cycles.push({
      productCode,
      poNumber,
      processedDate: value.date || null,
    });
  }

  return cycles;
}

// ==================================================
// GET AWAITING RECEIPT POs
// ==================================================

async function getAwaitingReceiptPOs() {
  console.log(
    "Retrieving Awaiting Receipt POs..."
  );

  const url =
    "https://api.tradevine.com/v1/PurchaseOrder" +
    "?status=19001&pageSize=200";

  const result = await tvApiGet(url);

  if (
    result.status !== 200 ||
    !result.data
  ) {
    throw new Error(
      `Could not retrieve Awaiting Receipt POs (${result.status})`
    );
  }

  const list =
    result.data.List ||
    result.data.list ||
    [];

  console.log(
    `Found ${list.length} Awaiting Receipt PO(s).`
  );

  return list;
}

// ==================================================
// GET PO NUMBER
// ==================================================

function getPONumber(po) {
  return (
    po.OrderNumber ||
    po.PONumber ||
    po.Number ||
    po.PurchaseOrderNumber ||
    null
  );
}

// ==================================================
// BUILD ACTIVE PRODUCT CYCLES
// ==================================================
//
// This is the important Cycle 1 / Cycle 2 logic.
//
// For every completed inventory record:
//
// 1. Check whether its PO is currently Awaiting Receipt.
// 2. Group by product.
// 3. If the same product exists on multiple active POs,
//    use the newest completed inventory record.
//
// Example:
//
// Cycle 1:
// inv:PO1560:PR13374
//
// Cycle 2:
// inv:PO1620:PR13374
//
// If PO1620 is currently Awaiting Receipt,
// PO1620 wins.
//
// ==================================================

function getActiveProductCycles(
  completedCycles,
  awaitingPOs
) {
  // ------------------------------------------------
  // Build quick lookup of active Awaiting Receipt POs
  // ------------------------------------------------

  const activePOs = new Map();

  for (const po of awaitingPOs) {
    const poNumber = getPONumber(po);

    if (!poNumber) {
      continue;
    }

    const normalized = String(poNumber)
      .trim()
      .toUpperCase();

    activePOs.set(normalized, po);
  }

  // ------------------------------------------------
  // Keep only completed cycles whose PO is active
  // ------------------------------------------------

  const activeCycles = completedCycles.filter(
    (cycle) => {
      return activePOs.has(cycle.poNumber);
    }
  );

  // ------------------------------------------------
  // Group by product
  // ------------------------------------------------

  const byProduct = new Map();

  for (const cycle of activeCycles) {
    if (!byProduct.has(cycle.productCode)) {
      byProduct.set(cycle.productCode, []);
    }

    byProduct
      .get(cycle.productCode)
      .push(cycle);
  }

  // ------------------------------------------------
  // Select newest active cycle per product
  // ------------------------------------------------

  const selected = [];

  for (const [
    productCode,
    cycles,
  ] of byProduct.entries()) {
    cycles.sort((a, b) => {
      const dateA = a.processedDate
        ? new Date(a.processedDate).getTime()
        : 0;

      const dateB = b.processedDate
        ? new Date(b.processedDate).getTime()
        : 0;

      return dateB - dateA;
    });

    const currentCycle = cycles[0];

    selected.push(currentCycle);

    if (cycles.length > 1) {
      console.log("");
      console.log(
        `Cycle history detected for ${productCode}:`
      );

      cycles.forEach((cycle, index) => {
        console.log(
          `  ${index + 1}. ${cycle.poNumber} → ${
            cycle.processedDate || "no date"
          }`
        );
      });

      console.log(
        `  → CURRENT ACTIVE CYCLE: ${currentCycle.poNumber}`
      );
    }
  }

  return selected;
}

// ==================================================
// FIND SHOPIFY PRODUCT BY SKU
// ==================================================

async function findShopifyProductBySku(sku) {
  const query = `
    query findBySku($query: String!) {
      productVariants(first: 1, query: $query) {
        edges {
          node {
            product {
              id
              title
            }
            sku
          }
        }
      }
    }
  `;

  const data = await shopifyGraphQL(
    query,
    {
      query: `sku:${sku}`,
    }
  );

  const edge =
    data.data
      ?.productVariants
      ?.edges?.[0];

  return edge
    ? edge.node.product
    : null;
}

// ==================================================
// SET WLG DELIVERY METAFIELD
// ==================================================

async function setDeliveryDateMetafield(
  shopifyProductGid,
  dateValue
) {
  const mutation = `
    mutation setMetafield(
      $metafields: [MetafieldsSetInput!]!
    ) {
      metafieldsSet(
        metafields: $metafields
      ) {
        metafields {
          id
          namespace
          key
          value
        }

        userErrors {
          field
          message
        }
      }
    }
  `;

  const result = await shopifyGraphQL(
    mutation,
    {
      metafields: [
        {
          ownerId: shopifyProductGid,

          namespace: "stock",

          key: "wlg_arriving_date",

          type: "date",

          value: dateValue,
        },
      ],
    }
  );

  return result;
}

// ==================================================
// PROCESS ONE PRODUCT
// ==================================================

async function processProduct(
  product,
  awaitingPOs
) {
  const productCode =
    product.productCode;

  const statePONumber =
    product.poNumber;

  console.log("");
  console.log(
    "----------------------------------------"
  );
  console.log(
    `PROCESSING ${productCode}`
  );
  console.log(
    "----------------------------------------"
  );

  console.log(
    `Current active PO cycle: ${statePONumber}`
  );

  // ------------------------------------------------
  // SAFETY
  // ------------------------------------------------

  if (
    isChildProduct(productCode)
  ) {
    console.log(
      `${productCode}: SKIPPED — BOM child product`
    );

    return {
      productCode,
      status: "skipped",
      reason: "bom_child",
    };
  }

  // ------------------------------------------------
  // FIND EXACT ACTIVE PO
  // ------------------------------------------------

  const po =
    awaitingPOs.find(
      (candidate) => {
        const current =
          getPONumber(candidate);

        return (
          current &&
          String(current)
            .trim()
            .toUpperCase() ===
            String(statePONumber)
              .trim()
              .toUpperCase()
        );
      }
    ) || null;

  if (!po) {
    console.log(
      `${productCode}: BLOCKED — PO ${statePONumber} was not found in Awaiting Receipt POs`
    );

    return {
      productCode,
      status: "blocked",
      reason: "po_not_found",
      poNumber: statePONumber,
      missing: [
        "purchase order",
      ],
    };
  }

  const poNumber =
    getPONumber(po);

  console.log(
    `PO found: ${poNumber}`
  );

  // ------------------------------------------------
  // REQUIRED DELIVERY DATE
  // ------------------------------------------------

  const requiredDeliveryDate =
    po.RequiredDeliveryDate;

  console.log(
    `Required Delivery Date: ${
      requiredDeliveryDate ||
      "NOT SET"
    }`
  );

  if (
    !requiredDeliveryDate
  ) {
    console.log(
      `${productCode}: BLOCKED — PO has no Required Delivery Date`
    );

    return {
      productCode,
      status: "blocked",
      reason:
        "missing_required_delivery_date",
      poNumber,
      missing: [
        "Required Delivery Date",
      ],
    };
  }

  // ------------------------------------------------
  // ADD 11 DAYS
  // ------------------------------------------------

  let arrivingDate;

  try {
    arrivingDate =
      addDays(
        requiredDeliveryDate,
        11
      );
  } catch (err) {
    console.log(
      `${productCode}: BLOCKED — invalid Required Delivery Date`
    );

    return {
      productCode,
      status: "blocked",
      reason:
        "invalid_required_delivery_date",
      poNumber,
      requiredDeliveryDate,
      error: err.message,
    };
  }

  console.log(
    `WLG arriving date: ${arrivingDate}`
  );

  // ------------------------------------------------
  // FIND SHOPIFY PRODUCT
  // ------------------------------------------------

  const shopifyProduct =
    await findShopifyProductBySku(
      productCode
    );

  if (!shopifyProduct) {
    console.log(
      `${productCode}: BLOCKED — product not found in WLG Shopify`
    );

    return {
      productCode,
      status: "blocked",
      reason:
        "shopify_product_not_found",
      poNumber,
      requiredDeliveryDate,
      arrivingDate,
    };
  }

  console.log(
    `Shopify product: ${shopifyProduct.title}`
  );

  console.log(
    `Shopify ID: ${shopifyProduct.id}`
  );

  // ------------------------------------------------
  // SET METAFIELD
  // ------------------------------------------------

  const result =
    await setDeliveryDateMetafield(
      shopifyProduct.id,
      arrivingDate
    );

  const metafieldResult =
    result.data
      ?.metafieldsSet;

  const userErrors =
    metafieldResult
      ?.userErrors ||
    [];

  if (
    userErrors.length > 0
  ) {
    console.log(
      `${productCode}: BLOCKED — metafield update failed`
    );

    console.log(
      JSON.stringify(
        userErrors,
        null,
        2
      )
    );

    return {
      productCode,
      status: "blocked",
      reason:
        "metafield_update_failed",
      poNumber,
      requiredDeliveryDate,
      arrivingDate,
      errors: userErrors,
    };
  }

  console.log(
    `${productCode}: ✓ wlg_arriving_date saved`
  );

  return {
    productCode,
    status: "updated",
    reason: null,

    // ------------------------------------------------
    // CYCLE INFORMATION
    // ------------------------------------------------

    cyclePO: poNumber,

    processedDate:
      product.processedDate,

    requiredDeliveryDate,

    arrivingDate,

    shopifyProductId:
      shopifyProduct.id,

    shopifyProductTitle:
      shopifyProduct.title,

    metafield:
      "stock.wlg_arriving_date",
  };
}

// ==================================================
// LOAD PREVIOUS RESULTS
// ==================================================

function loadPreviousResults() {
  if (
    !fs.existsSync(
      METAFIELD_RESULTS_FILE
    )
  ) {
    return [];
  }

  try {
    const data =
      JSON.parse(
        fs.readFileSync(
          METAFIELD_RESULTS_FILE,
          "utf8"
        )
      );

    return Array.isArray(data)
      ? data
      : [];
  } catch (err) {
    console.error(
      "Could not read delivery-metafield-results-wlg.json:",
      err.message
    );

    return [];
  }
}

// ==================================================
// SAVE RESULTS
// ==================================================

function saveResults(results) {
  fs.writeFileSync(
    METAFIELD_RESULTS_FILE,
    JSON.stringify(
      results,
      null,
      2
    )
  );
}

// ==================================================
// MAIN
// ==================================================

async function main() {
  console.log("");
  console.log(
    "========================================"
  );
  console.log(
    " WLG DELIVERY METAFIELD"
  );
  console.log(
    " CYCLE 1 / CYCLE 2"
  );
  console.log(
    "========================================"
  );
  console.log("");

  // ------------------------------------------------
  // CHECK CREDENTIALS
  // ------------------------------------------------

  if (
    !process.env.WLG_TV_CONSUMER_KEY ||
    !process.env.WLG_TV_CONSUMER_SECRET ||
    !process.env.WLG_TV_ACCESS_TOKEN ||
    !process.env.WLG_TV_ACCESS_TOKEN_SECRET
  ) {
    throw new Error(
      "WLG Tradevine credentials are missing from .env"
    );
  }

  console.log(
    "✓ WLG Tradevine credentials loaded"
  );

  if (
    !SHOPIFY_STORE ||
    !SHOPIFY_TOKEN
  ) {
    throw new Error(
      "WLG Shopify credentials are missing from .env"
    );
  }

  console.log(
    "✓ WLG Shopify credentials loaded"
  );

  console.log(
    `Shopify store: ${SHOPIFY_STORE}`
  );

  console.log(
    "Metafield: stock.wlg_arriving_date"
  );

  console.log("");

  // ------------------------------------------------
  // 1. LOAD PROCESSED STATE
  // ------------------------------------------------

  const processedState =
    loadProcessedState();

  const completedCycles =
    getCompletedInventoryCycles(
      processedState
    );

  console.log(
    `Found ${completedCycles.length} completed inventory cycle record(s).`
  );

  if (
    completedCycles.length === 0
  ) {
    console.log(
      "No completed inventory records found."
    );

    return;
  }

  // ------------------------------------------------
  // 2. GET AWAITING RECEIPT POS
  // ------------------------------------------------

  let awaitingPOs;

  try {
    awaitingPOs =
      await getAwaitingReceiptPOs();
  } catch (err) {
    console.error(
      "FAILED to retrieve Awaiting Receipt POs:"
    );

    console.error(
      err.message
    );

    process.exit(1);
  }

  console.log("");

  // ------------------------------------------------
  // 3. SELECT CURRENT ACTIVE CYCLE
  // ------------------------------------------------

  const products =
    getActiveProductCycles(
      completedCycles,
      awaitingPOs
    );

  console.log("");
  console.log(
    `Found ${products.length} product(s) in an active Awaiting Receipt cycle.`
  );

  if (
    products.length === 0
  ) {
    console.log(
      "No eligible active product cycles found."
    );

    return;
  }

  console.log("");
  console.log(
    "Current active product cycles:"
  );

  products.forEach(
    (product) => {
      console.log(
        `  ✓ ${product.productCode} → ${product.poNumber}`
      );
    }
  );

  console.log("");

  // ------------------------------------------------
  // 4. PROCESS PRODUCTS
  // ------------------------------------------------

  const now =
    new Date().toISOString();

  const runId =
    now.replace(
      /[:.]/g,
      "-"
    );

  const runResults = [];

  let updatedCount = 0;
  let blockedCount = 0;
  let skippedCount = 0;

  for (
    const product of products
  ) {
    try {
      const result =
        await processProduct(
          product,
          awaitingPOs
        );

      runResults.push({
        runId,
        date: now,
        ...result,
      });

      if (
        result.status ===
        "updated"
      ) {
        updatedCount++;
      } else if (
        result.status ===
        "blocked"
      ) {
        blockedCount++;
      } else if (
        result.status ===
        "skipped"
      ) {
        skippedCount++;
      }
    } catch (err) {
      console.error(
        `${product.productCode}: ERROR — ${err.message}`
      );

      blockedCount++;

      runResults.push({
        runId,
        date: now,

        productCode:
          product.productCode,

        poNumber:
          product.poNumber,

        status: "blocked",

        reason:
          "script_error",

        error:
          err.message,
      });
    }

    console.log("");
  }

  // ------------------------------------------------
  // 5. SAVE HISTORY
  // ------------------------------------------------

  const previousResults =
    loadPreviousResults();

  previousResults.push({
    runId,
    date: now,

    summary: {
      total:
        products.length,

      updated:
        updatedCount,

      blocked:
        blockedCount,

      skipped:
        skippedCount,
    },

    products:
      runResults,
  });

  saveResults(
    previousResults
  );

  // ------------------------------------------------
  // 6. SUMMARY
  // ------------------------------------------------

  console.log("");
  console.log(
    "========================================"
  );
  console.log(
    " WLG DELIVERY METAFIELD RUN COMPLETE"
  );
  console.log(
    "========================================"
  );

  console.log(
    `Total:    ${products.length}`
  );

  console.log(
    `Updated:  ${updatedCount}`
  );

  console.log(
    `Blocked:  ${blockedCount}`
  );

  console.log(
    `Skipped:  ${skippedCount}`
  );

  console.log("");

  console.log(
    `Results saved to: ${METAFIELD_RESULTS_FILE}`
  );

  console.log(
    "========================================"
  );
}

// ==================================================
// RUN
// ==================================================

main().catch(
  (err) => {
    console.error("");
    console.error(
      "========================================"
    );
    console.error(
      " WLG DELIVERY METAFIELD FAILED"
    );
    console.error(
      "========================================"
    );

    console.error(
      err.stack ||
      err.message ||
      err
    );

    process.exit(1);
  }
);