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
  "../json/CHCH/processed-state-chch.json"
);

const METAFIELD_RESULTS_FILE = path.join(
  __dirname,
  "../json/CHCH/delivery-metafield-results-chch.json"
);

// ==================================================
// TRADEVINE OAUTH
// ==================================================

const oauth = OAuth({
  consumer: {
    key: process.env.CHCH_TV_CONSUMER_KEY,
    secret: process.env.CHCH_TV_CONSUMER_SECRET,
  },

  signature_method: "HMAC-SHA1",

  hash_function: (base, key) =>
    crypto
      .createHmac("sha1", key)
      .update(base)
      .digest("base64"),
});

const token = {
  key: process.env.CHCH_TV_ACCESS_TOKEN,
  secret: process.env.CHCH_TV_ACCESS_TOKEN_SECRET,
};

// ==================================================
// SHOPIFY
// ==================================================

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

const API_VERSION = "2026-07";

const METAFIELD_NAMESPACE = "stock";
const METAFIELD_KEY = "chch_arriving_date";

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
      "User-Agent": "TSB-Living-CHCH",
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
    throw new Error(
      "SHOPIFY_STORE is missing from .env"
    );
  }

  if (!SHOPIFY_TOKEN) {
    throw new Error(
      "SHOPIFY_ACCESS_TOKEN is missing from .env"
    );
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
      JSON.stringify(
        data.errors,
        null,
        2
      )
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
    throw new Error(
      `Invalid date: ${dateStr}`
    );
  }

  d.setDate(
    d.getDate() + days
  );

  return d
    .toISOString()
    .slice(0, 10);
}

// ==================================================
// CHILD PRODUCT CHECK
// ==================================================
//
// Example:
// PR15242-A
// PR15242-B
//
// BOM children must NOT receive their own
// delivery metafield.
// ==================================================

function isChildProduct(productCode) {
  return /^PR\d+-[A-Z]$/i.test(
    String(productCode || "").trim()
  );
}

// ==================================================
// PARENT CODE FROM CHILD
// ==================================================

function getParentCodeFromChild(childCode) {
  const match =
    String(childCode || "")
      .trim()
      .toUpperCase()
      .match(/^(.+)-[A-Z]$/);

  return match
    ? match[1]
    : null;
}

// ==================================================
// LOAD PROCESSED STATE
// ==================================================

function loadProcessedState() {
  if (
    !fs.existsSync(
      PROCESSED_STATE_FILE
    )
  ) {
    console.log(
      `ERROR: ${PROCESSED_STATE_FILE} not found.`
    );

    return {};
  }

  try {
    const data =
      JSON.parse(
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
        "ERROR: CHCH processed state must contain an object."
      );

      return {};
    }

    return data;
  } catch (err) {
    console.error(
      "Could not read CHCH processed state:",
      err.message
    );

    return {};
  }
}

// ==================================================
// GET COMPLETED INVENTORY CYCLES
// ==================================================
//
// Reads:
//
// inv:PO1589:PR13374
// inv:PO1590:PR13374
//
// Only done === true records count.
//
// Historical cycles are preserved.
//
// The newest cycle is selected by the recorded date.
// ==================================================

function getCompletedInventoryCycles(
  productCode,
  state
) {
  const cycles = [];

  const wantedCode =
    String(productCode || "")
      .trim()
      .toUpperCase();

  for (
    const [key, value] of Object.entries(state)
  ) {
    if (
      !value ||
      value.done !== true
    ) {
      continue;
    }

    if (
      !key.startsWith("inv:")
    ) {
      continue;
    }

    const parts =
      key.split(":");

    if (
      parts.length < 3
    ) {
      continue;
    }

    const poNumber =
      parts[1]
        .trim()
        .toUpperCase();

    const code =
      parts
        .slice(2)
        .join(":")
        .trim()
        .toUpperCase();

    if (
      code !== wantedCode
    ) {
      continue;
    }

    cycles.push({
      productCode: wantedCode,
      poNumber,
      processedDate:
        value.date ||
        value.processedDate ||
        null,
    });
  }

  return cycles;
}

// ==================================================
// GET CURRENT CYCLE FOR STANDALONE PRODUCT
// ==================================================

function getCurrentCycleForProduct(
  productCode,
  state
) {
  const cycles =
    getCompletedInventoryCycles(
      productCode,
      state
    );

  if (
    cycles.length === 0
  ) {
    return null;
  }

  cycles.sort(
    (a, b) => {
      const dateA =
        a.processedDate
          ? new Date(
              a.processedDate
            ).getTime()
          : 0;

      const dateB =
        b.processedDate
          ? new Date(
              b.processedDate
            ).getTime()
          : 0;

      return dateB - dateA;
    }
  );

  return cycles[0];
}

// ==================================================
// GET CURRENT BOM CYCLE
// ==================================================
//
// A BOM parent does not receive inventory.
//
// Its cycle is determined from its children.
//
// Example:
//
// PR15242-A → PO1589
// PR15242-B → PO1589
//
// Therefore:
//
// PR15242 → PO1589
//
// All current children must belong to the
// same PO.
//
// If children are on different current POs,
// the BOM is blocked rather than guessing.
// ==================================================

function getCurrentBomCycle(
  parentCode,
  state
) {
  const prefix =
    `${String(parentCode || "")
      .trim()
      .toUpperCase()}-`;

  const childCycles = [];

  for (
    const [key, value] of Object.entries(state)
  ) {
    if (
      !value ||
      value.done !== true
    ) {
      continue;
    }

    if (
      !key.startsWith("inv:")
    ) {
      continue;
    }

    const parts =
      key.split(":");

    if (
      parts.length < 3
    ) {
      continue;
    }

    const poNumber =
      parts[1]
        .trim()
        .toUpperCase();

    const productCode =
      parts
        .slice(2)
        .join(":")
        .trim()
        .toUpperCase();

    if (
      !productCode.startsWith(
        prefix
      )
    ) {
      continue;
    }

    if (
      !isChildProduct(
        productCode
      )
    ) {
      continue;
    }

    const cycles =
      getCompletedInventoryCycles(
        productCode,
        state
      );

    if (
      cycles.length === 0
    ) {
      continue;
    }

    const currentCycle =
      getCurrentCycleForProduct(
        productCode,
        state
      );

    if (!currentCycle) {
      continue;
    }

    childCycles.push({
      childCode: productCode,
      poNumber:
        currentCycle.poNumber,
      processedDate:
        currentCycle.processedDate,
    });
  }

  if (
    childCycles.length === 0
  ) {
    return null;
  }

  // ------------------------------------------------
  // Remove duplicate child entries
  // ------------------------------------------------

  const uniqueChildren =
    new Map();

  for (
    const child of childCycles
  ) {
    uniqueChildren.set(
      child.childCode,
      child
    );
  }

  const children =
    Array.from(
      uniqueChildren.values()
    );

  // ------------------------------------------------
  // All children must be on the same PO
  // ------------------------------------------------

  const poNumbers =
    [
      ...new Set(
        children.map(
          (child) =>
            child.poNumber
        )
      ),
    ];

  if (
    poNumbers.length !== 1
  ) {
    console.log(
      `${parentCode}: BLOCKED — BOM children have different current POs`
    );

    children.forEach(
      (child) => {
        console.log(
          `  ${child.childCode} → ${child.poNumber}`
        );
      }
    );

    return {
      blocked: true,
      reason:
        "bom_children_different_pos",
      children,
    };
  }

  const poNumber =
    poNumbers[0];

  const latestDate =
    children
      .map(
        (child) =>
          child.processedDate
      )
      .filter(Boolean)
      .sort()
      .pop() || null;

  return {
    productCode:
      String(parentCode)
        .trim()
        .toUpperCase(),

    poNumber,

    processedDate:
      latestDate,

    children,
  };
}

// ==================================================
// GET CURRENT CHCH PRODUCTS
// ==================================================
//
// Standalone:
//   inv:PO:PR
//
// BOM parent:
//   bom:PR
//   with current cycle derived from children
//
// Children are never returned directly.
// ==================================================

function getCurrentProducts(
  state
) {
  const products =
    new Map();

  // ------------------------------------------------
  // 1. Standalone products
  // ------------------------------------------------

  for (
    const [key, value] of Object.entries(state)
  ) {
    if (
      !value ||
      value.done !== true
    ) {
      continue;
    }

    if (
      !key.startsWith("inv:")
    ) {
      continue;
    }

    const parts =
      key.split(":");

    if (
      parts.length < 3
    ) {
      continue;
    }

    const productCode =
      parts
        .slice(2)
        .join(":")
        .trim()
        .toUpperCase();

    if (!productCode) {
      continue;
    }

    if (
      isChildProduct(
        productCode
      )
    ) {
      continue;
    }

    const currentCycle =
      getCurrentCycleForProduct(
        productCode,
        state
      );

    if (!currentCycle) {
      continue;
    }

    products.set(
      productCode,
      {
        productCode,
        poNumber:
          currentCycle.poNumber,
        processedDate:
          currentCycle.processedDate,
        type: "standalone",
      }
    );
  }

  // ------------------------------------------------
  // 2. BOM parents
  // ------------------------------------------------
  //
  // bom:PR15242
  //
  // The BOM state itself is not used to decide
  // the PO. The children determine the current PO.
  // ------------------------------------------------

  for (
    const [key, value] of Object.entries(state)
  ) {
    if (
      !value ||
      value.done !== true
    ) {
      continue;
    }

    if (
      !key.startsWith("bom:")
    ) {
      continue;
    }

    const parentCode =
      key
        .slice(4)
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

    if (
      !bomCycle
    ) {
      continue;
    }

    if (
      bomCycle.blocked
    ) {
      products.set(
        parentCode,
        {
          productCode:
            parentCode,
          poNumber: null,
          processedDate: null,
          type: "bom",
          blocked: true,
          reason:
            bomCycle.reason,
        }
      );

      continue;
    }

    products.set(
      parentCode,
      {
        productCode:
          parentCode,
        poNumber:
          bomCycle.poNumber,
        processedDate:
          bomCycle.processedDate,
        type: "bom",
      }
    );
  }

  return Array.from(
    products.values()
  );
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

  const result =
    await tvApiGet(url);

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
// FIND EXACT PO
// ==================================================

function findPOByNumber(
  poNumber,
  awaitingPOs
) {
  const wanted =
    String(
      poNumber || ""
    )
      .trim()
      .toUpperCase();

  return (
    awaitingPOs.find(
      (po) => {
        const current =
          getPONumber(po);

        return (
          current &&
          String(current)
            .trim()
            .toUpperCase() ===
            wanted
        );
      }
    ) || null
  );
}

// ==================================================
// FIND SHOPIFY PRODUCT BY SKU
// ==================================================

async function findShopifyProductBySku(
  sku
) {
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

  const data =
    await shopifyGraphQL(
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
// SET CHCH DELIVERY METAFIELD
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

  const result =
    await shopifyGraphQL(
      mutation,
      {
        metafields: [
          {
            ownerId:
              shopifyProductGid,

            namespace:
              METAFIELD_NAMESPACE,

            key:
              METAFIELD_KEY,

            type:
              "date",

            value:
              dateValue,
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
    `Current CHCH cycle: ${
      statePONumber || "UNKNOWN"
    }`
  );

  console.log(
    `Product type: ${
      product.type
    }`
  );

  // ------------------------------------------------
  // BOM STATE ERROR
  // ------------------------------------------------

  if (
    product.blocked
  ) {
    console.log(
      `${productCode}: BLOCKED — ${product.reason}`
    );

    return {
      productCode,
      status: "blocked",
      reason:
        product.reason,
    };
  }

  // ------------------------------------------------
  // SAFETY — CHILD
  // ------------------------------------------------

  if (
    isChildProduct(
      productCode
    )
  ) {
    console.log(
      `${productCode}: SKIPPED — BOM child product`
    );

    return {
      productCode,
      status: "skipped",
      reason:
        "bom_child",
    };
  }

  // ------------------------------------------------
  // CURRENT PO MUST EXIST
  // ------------------------------------------------

  if (!statePONumber) {
    console.log(
      `${productCode}: BLOCKED — no current CHCH PO cycle`
    );

    return {
      productCode,
      status: "blocked",
      reason:
        "no_current_po",
    };
  }

  // ------------------------------------------------
  // FIND EXACT CURRENT PO
  // ------------------------------------------------

  const po =
    findPOByNumber(
      statePONumber,
      awaitingPOs
    );

  if (!po) {
    console.log(
      `${productCode}: BLOCKED — PO ${statePONumber} was not found in Awaiting Receipt POs`
    );

    return {
      productCode,
      status: "blocked",
      reason:
        "po_not_found",
      poNumber:
        statePONumber,
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
      error:
        err.message,
    };
  }

  console.log(
    `CHCH arriving date: ${arrivingDate}`
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
      `${productCode}: BLOCKED — product not found in AKL Shopify`
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
      errors:
        userErrors,
    };
  }

  console.log(
    `${productCode}: ✓ ${METAFIELD_KEY} saved`
  );

  return {
    productCode,
    status: "updated",
    reason: null,
    poNumber,
    requiredDeliveryDate,
    arrivingDate,
    shopifyProductId:
      shopifyProduct.id,
    shopifyProductTitle:
      shopifyProduct.title,
    metafield:
      `${METAFIELD_NAMESPACE}.${METAFIELD_KEY}`,
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
      "Could not read CHCH delivery metafield results:",
      err.message
    );

    return [];
  }
}

// ==================================================
// SAVE RESULTS
// ==================================================

function saveResults(
  results
) {
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
    "=============================================="
  );
  console.log(
    " CHCH DELIVERY METAFIELD AUTOMATION"
  );
  console.log(
    " + CYCLE 1 / CYCLE 2 SUPPORT"
  );
  console.log(
    "=============================================="
  );
  console.log("");

  // ------------------------------------------------
  // CHECK TRADEVINE CREDENTIALS
  // ------------------------------------------------

  if (
    !process.env.CHCH_TV_CONSUMER_KEY ||
    !process.env.CHCH_TV_CONSUMER_SECRET ||
    !process.env.CHCH_TV_ACCESS_TOKEN ||
    !process.env.CHCH_TV_ACCESS_TOKEN_SECRET
  ) {
    throw new Error(
      "CHCH Tradevine credentials are missing from .env"
    );
  }

  console.log(
    "✓ CHCH Tradevine credentials loaded"
  );

  // ------------------------------------------------
  // CHECK SHOPIFY CREDENTIALS
  // ------------------------------------------------

  if (
    !SHOPIFY_STORE ||
    !SHOPIFY_TOKEN
  ) {
    throw new Error(
      "Shopify credentials are missing from .env"
    );
  }

  console.log(
    "✓ AKL Shopify credentials loaded"
  );

  console.log(
    `Shopify store: ${SHOPIFY_STORE}`
  );

  console.log(
    `Metafield: ${METAFIELD_NAMESPACE}.${METAFIELD_KEY}`
  );

  console.log("");

  // ------------------------------------------------
  // 1. LOAD PROCESSED STATE
  // ------------------------------------------------

  const processedState =
    loadProcessedState();

  const products =
    getCurrentProducts(
      processedState
    );

  console.log(
    `Found ${products.length} current CHCH product cycle(s).`
  );

  if (
    products.length === 0
  ) {
    console.log(
      "No eligible current CHCH product cycles found."
    );

    return;
  }

  console.log("");

  console.log(
    "Current CHCH cycles:"
  );

  products.forEach(
    (product) => {
      console.log(
        `  - ${product.productCode} → ${
          product.poNumber ||
          "BLOCKED"
        } (${product.type})`
      );
    }
  );

  console.log("");

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
  // 3. PROCESS PRODUCTS
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
          product.poNumber ||
          null,
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
  // 4. SAVE HISTORY
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
  // 5. SUMMARY
  // ------------------------------------------------

  console.log("");
  console.log(
    "=============================================="
  );
  console.log(
    " CHCH DELIVERY METAFIELD RUN COMPLETE"
  );
  console.log(
    "=============================================="
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
    "=============================================="
  );
}

// ==================================================
// RUN
// ==================================================

main().catch(
  (err) => {
    console.error("");
    console.error(
      "=============================================="
    );
    console.error(
      " CHCH DELIVERY METAFIELD FAILED"
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
  }
);

