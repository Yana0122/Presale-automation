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

const SHOPIFY_STORE =
  process.env.SHOPIFY_STORE;

const SHOPIFY_TOKEN =
  process.env.SHOPIFY_ACCESS_TOKEN;

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

async function shopifyGraphQL(
  query,
  variables = {}
) {
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
      "X-Shopify-Access-Token":
        SHOPIFY_TOKEN,
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
//
// ../json/WLG/../json/WLG/../json/WLG/processed-state-wlg.json is an OBJECT:
//
// {
//   "inv:PO1560:PR13374": {
//     "done": true
//   }
// }
//
// We do NOT modify this file.
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
        "ERROR: ../json/WLG/processed-state-wlg.json must contain an object."
      );

      return {};
    }

    return data;
  } catch (err) {
    console.error(
      "Could not read ../json/WLG/processed-state-wlg.json:",
      err.message
    );

    return {};
  }
}

// ==================================================
// GET PROCESSED PRODUCTS
// ==================================================
//
// ONLY:
//
//   inv:PO:PR
//
// AND:
//
//   done === true
//
// are eligible.
//
// Example:
//
// "inv:PO1560:PR13374": {
//   "done": true
// }
//
// becomes:
//
// productCode = PR13374
// poNumber    = PO1560
// ==================================================

function getProcessedProducts(
  state
) {
  const products = new Map();

  for (
    const [key, value]
    of Object.entries(state)
  ) {
    // ------------------------------------------------
    // Must be completed
    // ------------------------------------------------

    if (
      !value ||
      value.done !== true
    ) {
      continue;
    }

    // ------------------------------------------------
    // Only inventory records
    // ------------------------------------------------

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
      console.log(
        `Ignoring invalid state key: ${key}`
      );

      continue;
    }

    // ------------------------------------------------
    // Extract PO
    // ------------------------------------------------

    const poNumber =
      parts[1]
        .trim()
        .toUpperCase();

    // ------------------------------------------------
    // Extract Product Code
    // ------------------------------------------------

    const productCode =
      parts
        .slice(2)
        .join(":")
        .trim()
        .toUpperCase();

    if (!productCode) {
      continue;
    }

    // ------------------------------------------------
    // Ignore BOM children
    // ------------------------------------------------

    if (
      isChildProduct(
        productCode
      )
    ) {
      console.log(
        `Ignoring BOM child: ${productCode}`
      );

      continue;
    }

    // ------------------------------------------------
    // Store product
    // ------------------------------------------------

    products.set(
      productCode,
      {
        productCode,
        poNumber,
        processedDate:
          value.date ||
          null,
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
// FIND PO DIRECTLY FROM PROCESSED STATE
// ==================================================
//
// ../json/WLG/../json/WLG/../json/WLG/processed-state-wlg.json already tells us:
//
// inv:PO1560:PR13374
//
// Therefore we use PO1560 directly.
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

  const result =
    await shopifyGraphQL(
      mutation,
      {
        metafields: [
          {
            ownerId:
              shopifyProductGid,

            namespace:
              "stock",

            key:
              "wlg_arriving_date",

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
    `Processed state: done = true`
  );

  console.log(
    `PO from ../json/WLG/processed-state-wlg.json: ${statePONumber}`
  );

  // ------------------------------------------------
  // SAFETY
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
      reason: "bom_child",
    };
  }

  // ------------------------------------------------
  // FIND EXACT PO
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
      reason: "po_not_found",
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
      errors:
        userErrors,
    };
  }

  console.log(
    `${productCode}: ✓ wlg_arriving_date saved`
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
      "Could not read ../json/WLG/delivery-metafield-results-wlg.json:",
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
    "========================================"
  );
  console.log(
    " WLG DELIVERY METAFIELD"
  );
  console.log(
    " PROCESSED STATE"
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

  const products =
    getProcessedProducts(
      processedState
    );

  console.log(
    `Found ${products.length} product(s) with done = true in ../json/WLG/processed-state-wlg.json.`
  );

  if (
    products.length === 0
  ) {
    console.log(
      "No eligible processed products found."
    );

    return;
  }

  console.log("");

  console.log(
    "Eligible products:"
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