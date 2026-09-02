require("dotenv").config();

const fs = require("fs");
const path = require("path");
const OAuth = require("oauth-1.0a");
const crypto = require("crypto");
const JSONbig = require("json-bigint")({ storeAsString: true });

// ==================================================
// FILES
// ==================================================

const LISTING_RESULTS_FILE = path.join(
  __dirname,
  "../json/AKL/shopify-listing-results.json"
);

const METAFIELD_RESULTS_FILE = path.join(
  __dirname,
  "../json/AKL/delivery-metafield-results.json"
);

const STATE_FILE = path.join(
  __dirname,
  "../json/AKL/processed-state.json"
);

const GRADUATION_FILE = path.join(
  __dirname,
  "../json/AKL/graduated-this-week.json"
);

// ==================================================
// TRADEVINE OAUTH
// ==================================================

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
  const url = `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`;

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

  const data = await res.json();

  if (data.errors) {
    console.log("GraphQL errors:", JSON.stringify(data.errors, null, 2));
  }

  return data;
}

// ==================================================
// ADD DAYS
// ==================================================
//
// Required Delivery Date is treated as a DATE,
// not a timestamp.
//
// Using UTC here prevents NZ/local timezone
// conversion from changing the date.

function addDays(dateStr, days) {
  if (!dateStr) {
    return null;
  }

  const cleanDate = String(dateStr).trim().slice(0, 10);
  const parts = cleanDate.split("-");

  if (parts.length !== 3) {
    return null;
  }

  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);

  if (!year || !month || !day) {
    return null;
  }

  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + days);

  return d.toISOString().slice(0, 10);
}

// ==================================================
// CHILD PRODUCT CHECK
// ==================================================
//
// PR15242-A
// PR15242-B
// ...
//
// These are BOM children and must NOT receive
// independent Shopify/metafield processing.

function isChildProduct(productCode) {
  return /^PR\d+-[A-Z]$/i.test(String(productCode || "").trim());
}

// ==================================================
// LOAD SHOPIFY LISTING RESULTS
// ==================================================

function loadListingResults() {
  if (!fs.existsSync(LISTING_RESULTS_FILE)) {
    console.log(`ERROR: ${LISTING_RESULTS_FILE} not found.`);
    return [];
  }

  try {
    const data = JSON.parse(fs.readFileSync(LISTING_RESULTS_FILE, "utf8"));

    if (!Array.isArray(data)) {
      console.log("ERROR: shopify-listing-results.json is not an array.");
      return [];
    }

    return data;
  } catch (err) {
    console.error("Could not read shopify-listing-results.json:", err.message);
    return [];
  }
}

// ==================================================
// LOAD ACTIVE PRESALE STATE
// ==================================================

function loadProcessedState() {
  if (!fs.existsSync(STATE_FILE)) {
    console.log(`ERROR: ${STATE_FILE} not found.`);
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (err) {
    console.error(`Could not read ${STATE_FILE}:`, err.message);
    return {};
  }
}

// ==================================================
// LOAD GRADUATION HISTORY
// ==================================================

function loadGraduationHistory() {
  if (!fs.existsSync(GRADUATION_FILE)) {
    return {};
  }

  try {
    const data = JSON.parse(fs.readFileSync(GRADUATION_FILE, "utf8"));
    return data || {};
  } catch (err) {
    console.error(`Could not read ${GRADUATION_FILE}:`, err.message);
    return {};
  }
}

// ==================================================
// GET ACTIVE PO FOR PRODUCT
// ==================================================
//
// The active PO comes from processed-state.json.
//
// Example:
//
// title:PR13374
// {
//   done: true,
//   poNumber: "PO4447"
// }
//
// This is the PO that the metafield script must use.

function getActivePOForProduct(productCode, state) {
  const normalizedCode = String(productCode || "").trim().toUpperCase();

  const possibleKeys = [
    `title:${normalizedCode}`,
    `bom:${normalizedCode}`,
  ];

  for (const key of possibleKeys) {
    const entry = state[key];

    if (entry && entry.done === true && entry.poNumber) {
      return {
        poNumber: String(entry.poNumber).trim().toUpperCase(),
        stateKey: key,
        stateEntry: entry,
      };
    }
  }

  return null;
}

// ==================================================
// GET AWAITING RECEIPT POS
// ==================================================
//
// IMPORTANT:
//
// Tradevine uses:
//
// /v1/PurchaseOrder
//
// NOT:
//
// /TSB-Living-Ltd---Auckland/v1/PurchaseOrder
//
// Status 19001 = Awaiting Receipt.

async function getAwaitingReceiptPOs() {
  const url =
    "https://api.tradevine.com" +
    "/v1/PurchaseOrder" +
    "?status=19001&pageSize=200";

  console.log("Retrieving Awaiting Receipt POs from Tradevine...");

  const response = await tvApiGet(url);

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Tradevine returned HTTP ${response.status}: ${
        response.raw || "No response body"
      }`
    );
  }

  const data = response.data;

  // Normal Tradevine response
  if (data && Array.isArray(data.List)) {
    console.log(`Found ${data.List.length} Awaiting Receipt PO(s).`);
    return data.List;
  }

  // Fallback response formats
  if (Array.isArray(data)) {
    console.log(`Found ${data.length} Awaiting Receipt PO(s).`);
    return data;
  }

  const possibleArrays = [
    data?.Items,
    data?.items,
    data?.Results,
    data?.results,
    data?.PurchaseOrders,
    data?.purchaseOrders,
    data?.Data,
    data?.data,
  ];

  for (const list of possibleArrays) {
    if (Array.isArray(list)) {
      console.log(`Found ${list.length} Awaiting Receipt PO(s).`);
      return list;
    }
  }

  console.log("Tradevine returned no Awaiting Receipt PO array.");
  console.log("Tradevine response:");
  console.log(JSON.stringify(data, null, 2));

  return [];
}

// ==================================================
// FIND EXACT ACTIVE PO FOR PRODUCT
// ==================================================
//
// We ONLY accept the PO that matches the current
// active presale cycle.
//
// Example:
//
// Active cycle:
//
// PR13374 + PO4447
//
// Even if PR13374 also exists on PO4550,
// PO4550 must NOT be used.

async function findPOForProduct(productCode, activePO, awaitingPOs) {
  const normalizedProductCode = String(productCode || "")
    .trim()
    .toUpperCase();

  const normalizedActivePO = String(activePO || "")
    .trim()
    .toUpperCase();

  // Check whether this is a BOM parent.
  // Example:
  // PR15242 -> BOM parent
  // PR15242-A -> child
  const isBomParent = !isChildProduct(normalizedProductCode);

  for (const po of awaitingPOs) {
    if (!po) {
      continue;
    }

    const poNumber =
      po.OrderNumber ||
      po.PONumber ||
      po.Number ||
      null;

    if (!poNumber) {
      continue;
    }

    const normalizedPONumber = String(poNumber)
      .trim()
      .toUpperCase();

    // PO must match the active presale cycle.
    if (normalizedPONumber !== normalizedActivePO) {
      continue;
    }

    // --------------------------------------------------
    // Check PurchaseOrderLines
    // --------------------------------------------------

    const possibleLines = [
      ...(Array.isArray(po.Lines) ? po.Lines : []),
      ...(Array.isArray(po.Items) ? po.Items : []),
      ...(Array.isArray(po.Products) ? po.Products : []),
      ...(Array.isArray(po.PurchaseOrderLines)
        ? po.PurchaseOrderLines
        : []),
    ];

    for (const line of possibleLines) {
      if (!line) {
        continue;
      }

      const possibleCodes = [
        line.ProductCode,
        line.Code,
        line.SKU,
        line.Sku,
        line.Product?.ProductCode,
        line.Product?.Code,
      ]
        .filter(Boolean)
        .map((code) =>
          String(code).trim().toUpperCase()
        );

      // -----------------------------------------------
      // Exact product match
      // -----------------------------------------------

      if (possibleCodes.includes(normalizedProductCode)) {
        console.log(
          `${normalizedProductCode}: exact PO line match found in ${normalizedPONumber}`
        );

        return po;
      }

      // -----------------------------------------------
      // BOM parent match
      //
      // PR15242
      //     ↓
      // PR15242-A
      // PR15242-B
      // -----------------------------------------------

      if (isBomParent) {
        const bomChildPrefix =
          `${normalizedProductCode}-`;

        const hasBomChild = possibleCodes.some(
          (code) =>
            code.startsWith(bomChildPrefix)
        );

        if (hasBomChild) {
          console.log(
            `${normalizedProductCode}: BOM child PO line found in ${normalizedPONumber}`
          );

          return po;
        }
      }
    }
  }

  return null;
}

// ==================================================
// GET SUCCESSFUL SHOPIFY LISTINGS
// ==================================================
//
// IMPORTANT:
//
// We DO NOT use a Map keyed only by product code.
//
// A product can have multiple historical cycles:
//
// PR13374 + PO4447
// PR13374 + PO4550
//
// Therefore PO number must remain attached to
// every listing record.

function getListedProducts(listingResults) {
  const products = [];

  for (const run of listingResults) {
    if (!run || !Array.isArray(run.products)) {
      continue;
    }

    for (const product of run.products) {
      if (!product || !product.productCode) {
        continue;
      }

      const productCode = String(product.productCode).trim().toUpperCase();

      // Ignore BOM children
      if (isChildProduct(productCode)) {
        continue;
      }

      // Only successful Shopify listings
      const isListed =
        product.isListed === true || product.result?.isListed === true;

      if (!isListed) {
        continue;
      }

      // Preserve PO number
      const poNumber =
        product.poNumber || product.result?.poNumber || run.poNumber || null;

      products.push({
        productCode,
        poNumber: poNumber
          ? String(poNumber).trim().toUpperCase()
          : null,
        runId: run.runId || null,
        date: product.date || run.date || null,
        result: product.result || null,
      });
    }
  }

  return products;
}

// ==================================================
// GET PRODUCTS FOR CURRENT ACTIVE CYCLES
// ==================================================
//
// This is important.
//
// shopify-listing-results.json contains HISTORY.
//
// We only want products whose successful Shopify
// listing belongs to the CURRENT active PO.
//
// Therefore:
//
// processed-state.json
//        +
// shopify-listing-results.json
//        ↓
// current active products only

function getCurrentCycleProducts(listedProducts, state) {
  const products = [];
  const seen = new Set();

  for (const listing of listedProducts) {
    if (!listing) {
      continue;
    }

    const productCode = String(listing.productCode || "").trim().toUpperCase();

    if (!productCode) {
      continue;
    }

    if (isChildProduct(productCode)) {
      continue;
    }

    const activeCycle = getActivePOForProduct(productCode, state);

    if (!activeCycle) {
      continue;
    }

    const listedPO = listing.poNumber
      ? String(listing.poNumber).trim().toUpperCase()
      : null;

    // Listing must belong to current active PO
    if (!listedPO || listedPO !== activeCycle.poNumber) {
      continue;
    }

    const key = `${productCode}|${activeCycle.poNumber}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    products.push({
      productCode,
      poNumber: activeCycle.poNumber,
      listingRecord: listing,
    });
  }

  return products;
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
          }
        }
      }
    }
  `;

  const data = await shopifyGraphQL(query, {
    query: `sku:${sku}`,
  });

  const edge = data.data?.productVariants?.edges?.[0];

  return edge ? edge.node.product : null;
}

// ==================================================
// SET DELIVERY METAFIELD
// ==================================================

async function setDeliveryDateMetafield(shopifyProductGid, dateValue) {
  const mutation = `
    mutation setMetafield($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
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

  const result = await shopifyGraphQL(mutation, {
    metafields: [
      {
        ownerId: shopifyProductGid,
        namespace: "stock",
        key: "akl_arriving_date",
        type: "date",
        value: dateValue,
      },
    ],
  });

  return result;
}

// ==================================================
// PROCESS ONE PRODUCT
// ==================================================

async function processProduct(
  productCode,
  awaitingPOs,
  state,
  graduationHistory,
  listedProducts
) {
  console.log("");
  console.log("----------------------------------------");
  console.log(`PROCESSING ${productCode}`);
  console.log("----------------------------------------");

  // Safety
  if (isChildProduct(productCode)) {
    console.log(`${productCode}: SKIPPED — BOM child product`);

    return {
      productCode,
      status: "skipped",
      reason: "bom_child",
    };
  }

  // Find current active presale cycle
  const activeCycle = getActivePOForProduct(productCode, state);

  if (!activeCycle) {
    console.log(`${productCode}: SKIPPED — no active presale cycle`);

    return {
      productCode,
      status: "skipped",
      reason: "no_active_presale_cycle",
    };
  }

  const activePO = activeCycle.poNumber;

  console.log(`Active presale cycle: ${activePO}`);
  console.log(`Active state key: ${activeCycle.stateKey}`);

  // Check exact PO graduation
  const graduationEntries = Array.isArray(graduationHistory)
    ? graduationHistory
    : Object.values(graduationHistory || {});

  const normalizedProductCode = String(productCode).trim().toUpperCase();

  const alreadyGraduated = graduationEntries.some((entry) => {
    if (!entry) {
      return false;
    }

    const entryCode = String(
      entry.productCode || entry.code || entry.ProductCode || ""
    )
      .trim()
      .toUpperCase();

    const entryPO = String(
      entry.poNumber || entry.OrderNumber || entry.PONumber || ""
    )
      .trim()
      .toUpperCase();

    return entryCode === normalizedProductCode && entryPO === activePO;
  });

  if (alreadyGraduated) {
    console.log(
      `${productCode}: SKIPPED — active PO ${activePO} is already recorded as graduated`
    );

    return {
      productCode,
      status: "skipped",
      reason: "already_graduated",
      poNumber: activePO,
    };
  }

  // Find successful Shopify listing
  //
  // IMPORTANT:
  //
  // Product code AND PO must match.
  //
  // Historical listing for another PO is not valid.

  const listingRecord = listedProducts.find(
    (item) =>
      String(item.productCode || "").trim().toUpperCase() ===
        normalizedProductCode &&
      String(item.poNumber || "").trim().toUpperCase() === activePO
  );

  if (!listingRecord) {
    console.log(
      `${productCode}: BLOCKED — no successful Shopify listing for active PO ${activePO}`
    );

    return {
      productCode,
      status: "blocked",
      reason: "not_listed_on_shopify_for_active_cycle",
      poNumber: activePO,
    };
  }

  console.log(
    `${productCode}: Shopify listing confirmed for active PO ${activePO} ✓`
  );

  // Find exact active PO
  const po = await findPOForProduct(productCode, activePO, awaitingPOs);

  if (!po) {
    console.log(
      `${productCode}: BLOCKED — active PO ${activePO} could not be found in Awaiting Receipt POs`
    );

    return {
      productCode,
      status: "blocked",
      reason: "po_not_found",
      poNumber: activePO,
      missing: ["active purchase order"],
    };
  }

  const poNumber = po.OrderNumber || po.PONumber || po.Number || null;

  console.log(`PO: ${poNumber || "unknown"}`);
  console.log(`Required Delivery Date: ${po.RequiredDeliveryDate || "NOT SET"}`);

  // Safety: PO must match active PO
  if (String(poNumber || "").trim().toUpperCase() !== activePO) {
    console.log(`${productCode}: BLOCKED — Tradevine PO does not match active PO`);

    return {
      productCode,
      status: "blocked",
      reason: "po_mismatch",
      poNumber,
      activePO,
    };
  }

  // Required Delivery Date
  if (!po.RequiredDeliveryDate) {
    console.log(`${productCode}: BLOCKED — PO has no Required Delivery Date`);

    return {
      productCode,
      status: "blocked",
      reason: "missing_required_delivery_date",
      poNumber,
      missing: ["Required Delivery Date"],
    };
  }

  // Calculate arriving date
  const arrivingDate = addDays(po.RequiredDeliveryDate, 11);

  if (!arrivingDate) {
    console.log(`${productCode}: BLOCKED — invalid Required Delivery Date`);

    return {
      productCode,
      status: "blocked",
      reason: "invalid_required_delivery_date",
      poNumber,
      requiredDeliveryDate: po.RequiredDeliveryDate,
    };
  }

  console.log(`Required Delivery Date: ${po.RequiredDeliveryDate}`);
  console.log(`+ 11 days`);
  console.log(`akl_arriving_date: ${arrivingDate}`);

  // Find existing Shopify product
  const shopifyProduct = await findShopifyProductBySku(productCode);

  if (!shopifyProduct) {
    console.log(`${productCode}: BLOCKED — product not found in Shopify`);

    return {
      productCode,
      status: "blocked",
      reason: "shopify_product_not_found",
      poNumber,
      arrivingDate,
    };
  }

  console.log(`Shopify product: ${shopifyProduct.title}`);
  console.log(`Shopify ID: ${shopifyProduct.id}`);

  // Set metafield
  const result = await setDeliveryDateMetafield(shopifyProduct.id, arrivingDate);

  const metafieldResult = result.data?.metafieldsSet;
  const userErrors = metafieldResult?.userErrors || [];

  if (userErrors.length > 0) {
    console.log(`${productCode}: BLOCKED — metafield update failed`);
    console.log(JSON.stringify(userErrors, null, 2));

    return {
      productCode,
      status: "blocked",
      reason: "metafield_update_failed",
      poNumber,
      arrivingDate,
      errors: userErrors,
    };
  }

  // Success
  console.log(`${productCode}: ✓ akl_arriving_date saved`);
  console.log(`${productCode}: ✓ Active cycle ${activePO}`);

  return {
    productCode,
    status: "updated",
    reason: null,
    poNumber,
    requiredDeliveryDate: po.RequiredDeliveryDate,
    arrivingDate,
    shopifyProductId: shopifyProduct.id,
    shopifyProductTitle: shopifyProduct.title,
    metafield: "stock.akl_arriving_date",
  };
}

// ==================================================
// LOAD PREVIOUS METAFIELD RESULTS
// ==================================================

function loadPreviousResults() {
  if (!fs.existsSync(METAFIELD_RESULTS_FILE)) {
    return [];
  }

  try {
    const data = JSON.parse(fs.readFileSync(METAFIELD_RESULTS_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error("Could not read delivery-metafield-results.json:", err.message);
    return [];
  }
}

// ==================================================
// SAVE RESULTS
// ==================================================

function saveResults(results) {
  fs.writeFileSync(METAFIELD_RESULTS_FILE, JSON.stringify(results, null, 2));
}

// ==================================================
// MAIN
// ==================================================

async function main() {
  console.log("");
  console.log("========================================");
  console.log(" AKL DELIVERY METAFIELD");
  console.log("========================================");
  console.log("");

  // 1. Load files
  const listingResults = loadListingResults();
  const state = loadProcessedState();
  const graduationHistory = loadGraduationHistory();

  // 2. Get successful Shopify listings
  const listedProducts = getListedProducts(listingResults);

  console.log(
    `Found ${listedProducts.length} successful historical Shopify listing record(s).`
  );

  // 3. Only use current active cycles
  const products = getCurrentCycleProducts(listedProducts, state);

  console.log(
    `Found ${products.length} product(s) belonging to current active presale cycle(s).`
  );

  if (products.length === 0) {
    console.log("");
    console.log("No products require delivery metafield processing.");
    return;
  }

  console.log("");

  // 4. Get Awaiting Receipt POs once
  let awaitingPOs;

  try {
    awaitingPOs = await getAwaitingReceiptPOs();
  } catch (err) {
    console.error("FAILED to retrieve Awaiting Receipt POs:");
    console.error(err.message);
    process.exit(1);
  }

  console.log("");

  // 5. Process products
  const now = new Date().toISOString();
  const runId = now.replace(/[:.]/g, "-");

  const runResults = [];

  let updatedCount = 0;
  let blockedCount = 0;
  let skippedCount = 0;

  for (const product of products) {
    const productCode = product.productCode;

    try {
      const result = await processProduct(
        productCode,
        awaitingPOs,
        state,
        graduationHistory,
        listedProducts
      );

      runResults.push({
        runId,
        date: now,
        ...result,
      });

      if (result.status === "updated") {
        updatedCount++;
      } else if (result.status === "blocked") {
        blockedCount++;
      } else if (result.status === "skipped") {
        skippedCount++;
      }
    } catch (err) {
      console.error(`${productCode}: ERROR — ${err.message}`);
      blockedCount++;

      runResults.push({
        runId,
        date: now,
        productCode,
        status: "blocked",
        reason: "script_error",
        error: err.message,
      });
    }

    console.log("");
  }

  // 6. Save history
  const previousResults = loadPreviousResults();

  previousResults.push({
    runId,
    date: now,
    summary: {
      total: products.length,
      updated: updatedCount,
      blocked: blockedCount,
      skipped: skippedCount,
    },
    products: runResults,
  });

  saveResults(previousResults);

  // 7. Summary
  console.log("");
  console.log("========================================");
  console.log(" DELIVERY METAFIELD RUN COMPLETE");
  console.log("========================================");
  console.log(`Total:    ${products.length}`);
  console.log(`Updated:  ${updatedCount}`);
  console.log(`Blocked:  ${blockedCount}`);
  console.log(`Skipped:  ${skippedCount}`);
  console.log("");
  console.log(`Results saved to: ${METAFIELD_RESULTS_FILE}`);
  console.log("========================================");
}

// ==================================================
// RUN
// ==================================================

main().catch((err) => {
  console.error("SCRIPT CRASHED:", err.message);
  console.error(err);
  process.exit(1);
});