require("dotenv").config();

const fs = require("fs");
const path = require("path");
const OAuth = require("oauth-1.0a");
const crypto = require("crypto");
const JSONbig = require("json-bigint")({ storeAsString: true });

// ==================================================
// LOGGING
// ==================================================

const LOG_FILE = "./automation.log";

function log(type, msg) {
  const entry = {
    time: new Date().toISOString(),
    type,
    msg,
  };

  console.log(`[${type.toUpperCase()}] ${msg}`);
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
}

// ==================================================
// TRADEVINE OAUTH
// ==================================================

// WLG tradevine credentials — used ONLY for ShopifyProduct
const oauth = OAuth({
  consumer: {
    key: process.env.WLG_TV_CONSUMER_KEY,
    secret: process.env.WLG_TV_CONSUMER_SECRET,
  },
  signature_method: "HMAC-SHA1",
  hash_function: (base, key) =>
    crypto.createHmac("sha1", key).update(base).digest("base64"),
});

const token = {
  key: process.env.WLG_TV_ACCESS_TOKEN,
  secret: process.env.WLG_TV_ACCESS_TOKEN_SECRET,
};

// AKL tradevine credentials — used ONLY for ShopifyProduct
// (tag/title) cleanup, since Shopify is only enabled on AKL.
const aklOauth = OAuth({
  consumer: {
    key: process.env.TV_CONSUMER_KEY,
    secret: process.env.TV_CONSUMER_SECRET,
  },
  signature_method: "HMAC-SHA1",
  hash_function: (base, key) =>
    crypto.createHmac("sha1", key).update(base).digest("base64"),
});

const aklToken = {
  key: process.env.TV_ACCESS_TOKEN,
  secret: process.env.TV_ACCESS_TOKEN_SECRET,
};

// ==================================================
// FILES
// ==================================================

const STATE_FILE = path.join(__dirname, "../json/WLG/processed-state-wlg.json");
const GRADUATION_FILE = path.join(__dirname, "../json/WLG/graduated-this-week-wlg.json");

// ==================================================
// WLG SETTINGS
// ==================================================
const TV_API = "https://api.tradevine.com";

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = "2026-07";

const SHOPIFY_TAG = "Pre-Order-Wellington";
const SHOPIFY_METAFIELD_NAMESPACE = "stock";
const SHOPIFY_METAFIELD_KEY = "wlg_arriving_date";

// ==================================================
// REAL WAREHOUSE PATTERN
// ==================================================

const REAL_WAREHOUSE_PATTERN = /^\d{1,2}-\d{1,2}-[A-Za-z]-\d{1,2}$/;

// ==================================================
// EXCLUDED SUPPLIERS
// ==================================================

const EXCLUDED_SUPPLIERS = ["Parmco Ltd"];

// ==================================================
// EXCLUDED TITLE
// ==================================================

function isExcludedByTitle(name) {
  return (name || "").toUpperCase().includes("NZ MADE");
}

// ==================================================
// LOAD STATE
// ==================================================

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
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
// SAVE STATE
// ==================================================

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ==================================================
// LOAD GRADUATION HISTORY
// ==================================================

function loadGraduationHistory() {
  if (!fs.existsSync(GRADUATION_FILE)) {
    return [];
  }

  try {
    const data = JSON.parse(fs.readFileSync(GRADUATION_FILE, "utf8"));

    if (!Array.isArray(data)) {
      console.log(
        `WARNING: ${GRADUATION_FILE} is not an array. Starting with empty graduation history.`
      );
      return [];
    }

    return data;
  } catch (err) {
    console.error(`Could not read ${GRADUATION_FILE}:`, err.message);
    return [];
  }
}

// ==================================================
// SAVE GRADUATION HISTORY
// ==================================================

function saveGraduationHistory(history) {
  const directory = path.dirname(GRADUATION_FILE);

  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  fs.writeFileSync(GRADUATION_FILE, JSON.stringify(history, null, 2));
}

// ==================================================
// RECORD GRADUATION
// ==================================================

function recordGraduation(product, type) {
  if (!product) {
    return;
  }

  const productCode = String(product.Code || "").trim();

  if (!productCode) {
    console.log("    Cannot record graduation: product code missing");
    return;
  }

  const history = loadGraduationHistory();

  const filteredHistory = history.filter(
    (entry) =>
      String(entry.productCode || "").toUpperCase() !== productCode.toUpperCase()
  );

  const supplier =
    product.SupplierName || product.Supplier || product.Supplier?.Name || "";

  const record = {
    productCode,
    productName: String(product.Name || ""),
    date: new Date().toISOString(),
    supplier: String(supplier || ""),
    type,
  };

  if (product.PONumber || product.PurchaseOrderNumber) {
    record.poNumber = product.PONumber || product.PurchaseOrderNumber;
  }

  filteredHistory.push(record);
  saveGraduationHistory(filteredHistory);

  console.log("");
  console.log(`    ✓ ${productCode} saved to graduated-this-week-wlg.json`);
  log("success", `${productCode}: graduation recorded in graduated-this-week-wlg.json`);
}

// ==================================================
// CLEAN OLD GRADUATION HISTORY
// ==================================================

function cleanGraduationHistory() {
  const history = loadGraduationHistory();
  const now = Date.now();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;

  const cleaned = history.filter((entry) => {
    const timestamp = Date.parse(entry.date);
    if (Number.isNaN(timestamp)) {
      return false;
    }
    return now - timestamp <= sevenDays;
  });

  if (cleaned.length !== history.length) {
    saveGraduationHistory(cleaned);
    console.log(
      `Graduation history cleaned: ${history.length} → ${cleaned.length} record(s)`
    );
  }
}

// ==================================================
// SUPPLIER CHECK
// ==================================================

function isExcludedBySupplier(code, state) {
  const invKeys = Object.keys(state).filter(
    (key) => key.startsWith("inv:") && key.endsWith(`:${code}`)
  );

  return invKeys.some((key) => {
    const supplier = state[key]?.supplier;

    return (
      supplier &&
      EXCLUDED_SUPPLIERS.some(
        (excluded) => excluded.toLowerCase() === String(supplier).toLowerCase()
      )
    );
  });
}

// ==================================================
// BLOCK CHECK
// ==================================================

function isBlocked(code, state) {
  if (isExcludedBySupplier(code, state)) {
    console.log(`${code}: excluded supplier (Parmco Ltd) — skipping`);
    return true;
  }

  return false;
}

// ==================================================
// TRADEVINE GET
// ==================================================

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

// ==================================================
// TRADEVINE POST
// ==================================================

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
    body: JSONbig.stringify(body),
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

async function aklApiGet(url) {
  const authHeader = aklOauth.toHeader(
    aklOauth.authorize({ url, method: "GET" }, aklToken)
  );

  const res = await fetch(url, {
    method: "GET",
    headers: { ...authHeader, Accept: "application/json" },
  });

  const text = await res.text();

  try {
    return { status: res.status, data: JSONbig.parse(text), raw: text };
  } catch {
    return { status: res.status, data: null, raw: text };
  }
}

async function aklApiPost(url, body) {
  const authHeader = aklOauth.toHeader(
    aklOauth.authorize({ url, method: "POST" }, aklToken)
  );

  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...authHeader,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSONbig.stringify(body),
  });

  const text = await res.text();

  try {
    return { status: res.status, data: JSONbig.parse(text), raw: text };
  } catch {
    return { status: res.status, data: null, raw: text };
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

  const text = await res.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Shopify returned invalid JSON (${res.status}): ${text.slice(0, 500)}`
    );
  }

  if (data.errors) {
    console.log("Shopify GraphQL errors:", JSON.stringify(data.errors, null, 2));
  }

  return data;
}

// ==================================================
// GET PRODUCT BY CODE
// ==================================================

async function getProductByCode(code) {
  const url =
    `https://api.tradevine.com/v1/Product` +
    `?code=${encodeURIComponent(code)}` +
    `&pageSize=10`;

  const result = await apiGet(url);

  if (result.status !== 200 || !result.data) {
    console.log(
      `${code}: Tradevine Product lookup failed — HTTP ${result.status}`
    );

    console.log(
      (result.raw || "").slice(0, 500)
    );

    return null;
  }

  const list =
    result.data.List ||
    result.data.list ||
    result.data;

  if (!Array.isArray(list)) {
    console.log(
      `${code}: Tradevine Product response did not contain a product list`
    );

    return null;
  }

  const product = list.find(
    (item) =>
      String(item.Code || "").toUpperCase() ===
      String(code).toUpperCase()
  );

  if (!product) {
    console.log(
      `${code}: product not found in Tradevine`
    );

    return null;
  }

  return product;
}

// ==================================================
// GET ASSIGNED PRE-ORDER WAREHOUSE
// ==================================================

function getAssignedWarehouseCode(productCode, state) {
  const entry = state[`warehouse:${productCode}`];
  return entry ? entry.warehouseCode : null;
}

// ==================================================
// CLEAR PRE-ORDER STOCK
// ==================================================

async function zeroOutPreOrderStock(product, state) {
  const warehouseCode = getAssignedWarehouseCode(product.Code, state);

  if (!warehouseCode) {
    console.log(`    ${product.Code}: no stored pre-order warehouse assignment`);
    return false;
  }

  const preOrderLine = (product.PerWarehouseInventory || []).find(
    (warehouse) => warehouse.WarehouseCode === warehouseCode
  );

  const currentQty = preOrderLine
    ? Number(preOrderLine.QuantityInStockSnapshot)
    : 0;

  if (!currentQty || currentQty <= 0) {
    console.log(`    ${product.Code}: ${warehouseCode} stock already 0 ✓`);
    return true;
  }

  const url = "https://api.tradevine.com/v1/ProductInventory/MakeAdjustment";

  const body = {
    ProductCode: product.Code,
    WarehouseCode: warehouseCode,
    InventoryType: 36015,
    QuantityChange: currentQty,
    ProductCostPrice: 0,
    Notes:
      "Presale automation - real WLG stock arrived, clearing pre-order buffer",
  };

  const result = await apiPost(url, body);

  if (result.status === 200) {
    console.log(
      `    ${product.Code}: cleared ${warehouseCode} stock (-${currentQty}) ✓`
    );
    return true;
  }

  console.log(`    ${product.Code}: failed to clear ${warehouseCode} stock`);
  console.log(result.raw?.slice(0, 500));

  return false;
}

// ==================================================
// REMOVE DS FROM TRADEVINE TITLE
// ==================================================

async function stripDsPrefix(product) {
  if (!product) {
    return false;
  }

  const currentName = String(product.Name || "");

  if (!/^DS\s+/i.test(currentName)) {
    console.log(`    ${product.Code}: DS prefix already removed ✓`);
    return true;
  }

  const newName = currentName.replace(/^DS\s+/i, "");

  const url = `https://api.tradevine.com/v1/Product/${product.ProductID}`;

  const result = await apiPost(url, {
    ...product,
    Name: newName,
  });

  if (result.status === 200) {
    console.log(`    ${product.Code}: DS removed from title ✓`);
    return true;
  }

  console.log(`    ${product.Code}: FAILED to remove DS from title`);
  console.log(result.raw?.slice(0, 500));

  return false;
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
            sku
            product {
              id
              title
            }
          }
        }
      }
    }
  `;

  const result = await shopifyGraphQL(query, {
    query: `sku:${sku}`,
  });

  if (result.errors) {
    return null;
  }

  const edge = result.data?.productVariants?.edges?.[0];

  return edge ? edge.node.product : null;
}

// ==================================================
// GET SHOPIFY PRODUCT TAGS + METAFIELD
// ==================================================

async function getShopifyProductState(productGid) {
  const query = `
    query getProductState($id: ID!) {
      product(id: $id) {
        id
        title
        tags
        metafield(
          namespace: "stock"
          key: "wlg_arriving_date"
        ) {
          id
          namespace
          key
          value
        }
      }
    }
  `;

  const result = await shopifyGraphQL(query, {
    id: productGid,
  });

  if (result.errors) {
    return null;
  }

  return result.data?.product || null;
}
/* =========================================================
   REMOVE PRE-ORDER WELLINGTON TAG
========================================================= */

function removePreOrderTag(tagsString) {
  return (tagsString || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .filter(
      (tag) =>
        tag.toLowerCase() !==
        "pre-order-wellington"
    )
    .join(", ");
}

/* =========================================================
   FIND TRADEVINE SHOPIFY PRODUCT RECORD

   IMPORTANT:
   Search by ProductCode instead of Tradevine ProductID.
========================================================= */

async function getShopifyProductRecord(productCode) {
  const url =
    `${TV_API}/v1/ShopifyProduct` +
    `?productCode=${encodeURIComponent(productCode)}` +
    `&pageSize=100`;

  const result = await aklApiGet(url);

  if (result.status !== 200 || !result.data) {
    log("warn", `${productCode}: ShopifyProduct lookup failed (HTTP ${result.status})`);
    console.log((result.raw || "").slice(0, 500));
    return null;
  }

  const list =
    result.data.List ||
    result.data.list ||
    [];

  if (!Array.isArray(list)) {
    log("warn", `${productCode}: ShopifyProduct response did not contain a list`);
    return null;
  }

  const record = list.find(
    (item) =>
      String(item.ProductCode || "").toUpperCase() ===
      String(productCode).toUpperCase()
  );

  if (!record) {
    log("info", `${productCode}: no ShopifyProduct record found by ProductCode`);
    return null;
  }

  log(
    "info",
    `${productCode}: ShopifyProduct found — ShopifyProductID ${String(record.ShopifyProductID)}`
  );

  return record;
}
async function stripDsPrefixAndTagFromShopify(productCode) {
  const record =
    await getShopifyProductRecord(productCode);

  if (!record) {
    log(
      "info",
      `${productCode}: no ShopifyProduct record — skipping Shopify tab cleanup`
    );

    return true;
  }

  const updates = {};

  // Remove DS from Shopify tab title
  if (
    typeof record.Title === "string" &&
    /^DS\s+/i.test(record.Title)
  ) {
    updates.Title =
      record.Title.replace(/^DS\s+/i, "");
  }

  // Remove Pre-Order-Wellington
  const cleanedTags =
    removePreOrderTag(record.Tags);

  if (
    cleanedTags !==
    (record.Tags || "").trim()
  ) {
    updates.Tags = cleanedTags;
  }

  if (Object.keys(updates).length === 0) {
    log(
      "info",
      `${productCode}: Shopify tab already clean (title/tags)`
    );

    return true;
  }

  const shopifyProductId =
    String(record.ShopifyProductID);

  const url =
    `${TV_API}/v1/ShopifyProduct/${shopifyProductId}`;

  const body = {
    ...record,
    ...updates,
  };

  const result =
    await aklApiPost(url, body);

  if (result.status !== 200) {
    log(
      "error",
      `${productCode}: Shopify tab update FAILED — HTTP ${result.status}: ${
        result.raw || ""
      }`.slice(0, 500)
    );

    return false;
  }

  log(
    "success",
    `${productCode}: Shopify tab updated (${Object.keys(
      updates
    ).join(", ")})`
  );

  // Re-fetch from Tradevine to verify (this is the AKL-side ShopifyProduct record —
  // separate from the later Shopify-direct tag/metafield check in verifyShopifyCleanup)
  const verifiedRecord =
    await getShopifyProductRecord(productCode);

  if (!verifiedRecord) {
    log(
      "error",
      `${productCode}: could not verify Shopify tab after update`
    );

    return false;
  }

  const titleClean =
    !/^DS\s+/i.test(
      verifiedRecord.Title || ""
    );

  const tagList =
    (verifiedRecord.Tags || "")
      .split(",")
      .map((tag) =>
        tag.trim().toLowerCase()
      )
      .filter(Boolean);

  const tagClean =
    !tagList.includes(
      "pre-order-wellington"
    );

  if (!titleClean || !tagClean) {
    log(
      "error",
      `${productCode}: Shopify tab verification FAILED`
    );

    return false;
  }

  log(
    "success",
    `${productCode}: Shopify tab cleanup VERIFIED`
  );

  return true;
}
// ==================================================
// DELETE WLG ARRIVING DATE
// ==================================================

async function deleteWellingtonArrivingDate(productGid) {
  console.log(
    `    Deleting ${SHOPIFY_METAFIELD_NAMESPACE}.${SHOPIFY_METAFIELD_KEY}...`
  );

  const mutation = `
    mutation deleteWellingtonMetafield($metafields: [MetafieldIdentifierInput!]!) {
      metafieldsDelete(metafields: $metafields) {
        deletedMetafields {
          key
          namespace
          ownerId
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
        ownerId: productGid,
        namespace: SHOPIFY_METAFIELD_NAMESPACE,
        key: SHOPIFY_METAFIELD_KEY,
      },
    ],
  });

  if (result.errors) {
    console.log("    GraphQL mutation failed");
    console.log(JSON.stringify(result.errors, null, 2));
    return false;
  }

  const payload = result.data?.metafieldsDelete;
  const userErrors = payload?.userErrors || [];

  if (userErrors.length > 0) {
    console.log("    Metafield deletion returned errors:");
    console.log(JSON.stringify(userErrors, null, 2));
    return false;
  }

  const deleted = payload?.deletedMetafields || [];

  if (deleted.length > 0 && deleted[0]) {
    console.log(
      `    ${SHOPIFY_METAFIELD_NAMESPACE}.${SHOPIFY_METAFIELD_KEY} deleted ✓`
    );
  } else {
    console.log(
      `    ${SHOPIFY_METAFIELD_NAMESPACE}.${SHOPIFY_METAFIELD_KEY} was already absent ✓`
    );
  }

  return true;
}

// ==================================================
// VERIFY SHOPIFY CLEANUP
// ==================================================

async function verifyShopifyCleanup(productGid) {
  const product = await getShopifyProductState(productGid);

  if (!product) {
    console.log("    Shopify product verification failed");
    return false;
  }

  const tags = Array.isArray(product.tags)
    ? product.tags
    : [];

  // ----------------------------------------------
  // VERIFY WLG TAG
  // ----------------------------------------------

  const tagStillExists = tags.some(
    (tag) =>
      String(tag).trim().toLowerCase() ===
      "pre-order-wellington"
  );

  if (tagStillExists) {
    console.log(
      `    ${SHOPIFY_TAG} still exists on Shopify — verification FAILED`
    );

    return false;
  }

  console.log(
    `    ${SHOPIFY_TAG} removed ✓`
  );

  // ----------------------------------------------
  // VERIFY ARRIVING DATE METAFIELD
  // ----------------------------------------------

  const metafield = product.metafield;

  if (metafield) {
    console.log(
      `    ${SHOPIFY_METAFIELD_NAMESPACE}.${SHOPIFY_METAFIELD_KEY} still exists — verification FAILED`
    );

    console.log(
      `    Existing value: ${metafield.value}`
    );

    return false;
  }

  console.log(
    `    ${SHOPIFY_METAFIELD_NAMESPACE}.${SHOPIFY_METAFIELD_KEY} removed ✓`
  );

  return true;
}

/// ==================================================
// SHOPIFY GRADUATION CLEANUP
// ==================================================
//
// IMPORTANT:
// - Title + Pre-Order-Wellington tag are cleaned through
//   Tradevine /ShopifyProduct, matching the working
//   WLG → AKL tagging script.
// - The arriving-date metafield is cleaned through Shopify
//   GraphQL because it is a Shopify metafield.
// ==================================================

async function runShopifyCleanup(productCode) {
  console.log("");
  console.log(`    ${productCode}: starting Shopify cleanup`);

  // --------------------------------------------------
  // 1. CLEAN TRADEVINE SHOPIFY TAB
  // --------------------------------------------------
  //
  // This removes:
  // - DS from Shopify tab title
  // - Pre-Order-Wellington tag
  //
  // This uses the same method as the working
  // WLG → AKL tagging script.
  //

  const shopifyTabOk = await stripDsPrefixAndTagFromShopify(productCode);

  if (!shopifyTabOk) {
    console.log(
      `    ${productCode}: BLOCKED — Tradevine ShopifyProduct cleanup failed`
    );
    return false;
  }

  console.log(
    `    ${productCode}: Tradevine ShopifyProduct cleanup verified ✓`
  );

  // --------------------------------------------------
  // 2. FIND ACTUAL SHOPIFY PRODUCT
  // --------------------------------------------------
  //
  // We only use GraphQL here to obtain the Shopify
  // Product GID required for metafield deletion.
  //

  const shopifyProduct = await findShopifyProductBySku(productCode);

  if (!shopifyProduct) {
    console.log(
      `    ${productCode}: Shopify product could not be found for arriving-date cleanup`
    );
    return false;
  }

  console.log(`    Shopify product: ${shopifyProduct.title}`);
  console.log(`    Shopify ID: ${shopifyProduct.id}`);

  // --------------------------------------------------
  // 3. DELETE WELLINGTON ARRIVING DATE
  // --------------------------------------------------

  const metafieldOk = await deleteWellingtonArrivingDate(shopifyProduct.id);

  if (!metafieldOk) {
    console.log(
      `    ${productCode}: Shopify arriving-date deletion FAILED`
    );
    return false;
  }

  // --------------------------------------------------
  // 4. VERIFY ARRIVING DATE
  // --------------------------------------------------
  //
  // We deliberately verify only the metafield here.
  // The tag/title were already verified against the
  // Tradevine ShopifyProduct record above.
  //

  const verified = await verifyShopifyCleanup(shopifyProduct.id);

  if (!verified) {
    console.log(
      `    ${productCode}: Shopify arriving-date verification FAILED`
    );
    return false;
  }

  console.log(
    `    ${productCode}: Shopify cleanup fully verified ✓`
  );

  return true;
}
// ==================================================
// VERIFY SHOPIFY METAFIELD CLEANUP
// ==================================================

async function verifyShopifyMetafieldCleanup(productGid) {
  const product = await getShopifyProductState(productGid);

  if (!product) {
    console.log("    Shopify product verification failed");
    return false;
  }

  // ----------------------------------------------
  // VERIFY ARRIVING DATE METAFIELD
  // ----------------------------------------------

  const metafield = product.metafield;

  if (metafield) {
    console.log(
      `    ${SHOPIFY_METAFIELD_NAMESPACE}.${SHOPIFY_METAFIELD_KEY} still exists — verification FAILED`
    );
    console.log(`    Existing value: ${metafield.value}`);
    return false;
  }

  console.log(
    `    ${SHOPIFY_METAFIELD_NAMESPACE}.${SHOPIFY_METAFIELD_KEY} removed ✓`
  );

  return true;
}

// ==================================================
// CHECK REAL STOCK
// ==================================================

function hasRealWarehouseStock(product) {
  return (product.PerWarehouseInventory || []).some(
    (warehouse) =>
      REAL_WAREHOUSE_PATTERN.test(warehouse.WarehouseCode) &&
      Number(warehouse.QuantityInStockSnapshot) > 0
  );
}

// ==================================================
// PROCESS STANDALONE PRODUCT
// ==================================================

async function processStandaloneProduct(code, state) {
  console.log("");
  console.log("========================================");
  console.log(`CHECKING WLG PRODUCT: ${code}`);
  console.log("========================================");

  if (isBlocked(code, state)) {
    return;
  }

  let product = await getProductByCode(code);

  if (!product) {
    console.log(`${code}: product not found — skipping`);
    return;
  }

  if (isExcludedByTitle(product.Name)) {
    console.log(`${code}: title contains "NZ MADE" — excluded, skipping`);
    return;
  }

  const realStock = hasRealWarehouseStock(product);

  log("info", `${code}: hasRealStock = ${realStock}`);

  if (!realStock) {
    console.log(`  ${code}: still presale-only — no action`);
    return;
  }

  console.log(`  ${code}: REAL warehouse stock detected ✓`);

  const zeroOk = await zeroOutPreOrderStock(product, state);

  if (!zeroOk) {
    console.log(`  ${code}: graduation STOPPED — could not clear pre-order stock`);
    return;
  }

  product = await getProductByCode(code);

  const titleOk = await stripDsPrefix(product);

  if (!titleOk) {
    console.log(`  ${code}: cleanup STOPPED — DS title removal failed`);
    return;
  }

  const shopifyOk = await runShopifyCleanup(code);

  if (!shopifyOk) {
    console.log(`  ${code}: cleanup STOPPED — Shopify cleanup incomplete`);
    return;
  }

  product = await getProductByCode(code);

  recordGraduation(product, "standalone");

  delete state[`title:${code}`];
  delete state[`warehouse:${code}`];

  console.log(`  ${code}: WLG presale cleanup completed ✓`);
  log("success", `${code}: WLG presale cleanup completed`);
}

// ==================================================
// PROCESS BOM PARENT
// ==================================================

async function processBomParent(parentCode, state) {
  console.log("");
  console.log("========================================");
  console.log(`CHECKING WLG BOM PARENT: ${parentCode}`);
  console.log("========================================");

  if (isBlocked(parentCode, state)) {
    return;
  }

  let parent = await getProductByCode(parentCode);

  if (!parent) {
    console.log(`${parentCode}: parent not found — skipping`);
    return;
  }

  if (isExcludedByTitle(parent.Name)) {
    console.log(`${parentCode}: title contains "NZ MADE" — excluded, skipping`);
    return;
  }

  const components = (parent.BoMComponents || []).filter(
    (component) => component.BoMComponentProductCode
  );

  if (components.length === 0) {
    console.log(`${parentCode}: no BOM components found — skipping`);
    return;
  }

  console.log(`${parentCode}: checking ${components.length} child component(s)...`);

  const childProducts = [];
  let allChildrenReady = true;

  for (const component of components) {
    const childCode = component.BoMComponentProductCode;
    const child = await getProductByCode(childCode);

    if (!child) {
      console.log(`  ${childCode}: not found — not ready`);
      allChildrenReady = false;
      continue;
    }

    const childHasRealStock = hasRealWarehouseStock(child);

    console.log(`  ${childCode}: hasRealStock = ${childHasRealStock}`);
    childProducts.push(child);

    if (!childHasRealStock) {
      allChildrenReady = false;
    }
  }

  if (!allChildrenReady) {
    console.log(`  ${parentCode}: not all children have real stock yet — no action`);
    return;
  }

  console.log(`  ${parentCode}: all children have real stock ✓`);

  for (const child of childProducts) {
    const childZeroOk = await zeroOutPreOrderStock(child, state);

    if (!childZeroOk) {
      console.log(
        `  ${parentCode}: child ${child.Code} stock cleanup failed — stopping`
      );
      return;
    }
  }

  const freshParent = await getProductByCode(parentCode);
  const titleOk = await stripDsPrefix(freshParent);

  if (!titleOk) {
    console.log(`  ${parentCode}: DS removal failed — stopping`);
    return;
  }

  const shopifyOk = await runShopifyCleanup(parentCode);

  if (!shopifyOk) {
    console.log(`  ${parentCode}: Shopify cleanup incomplete — state retained`);
    return;
  }

  const finalParent = await getProductByCode(parentCode);

  recordGraduation(finalParent, "bom");

  delete state[`title:${parentCode}`];
  delete state[`bom:${parentCode}`];
  delete state[`warehouse:${parentCode}`];

  console.log(`  ${parentCode}: WLG BOM presale cleanup completed ✓`);
  log("success", `${parentCode}: WLG BOM presale cleanup completed`);
}

// ==================================================
// MAIN
// ==================================================

async function main() {
  console.log("");
  console.log("==============================================");
  console.log(" WLG PRESALE CLEANUP");
  console.log(" INVENTORY + TITLE + TAG + DELIVERY DATE");
  console.log(" + GRADUATION HISTORY");
  console.log("==============================================");
  console.log("");

  console.log("✓ WLG Tradevine credentials loaded");
  console.log("✓ WLG Shopify credentials loaded");
  console.log(`Shopify store: ${SHOPIFY_STORE}`);
  console.log(`Shopify tag: ${SHOPIFY_TAG}`);
  console.log(`Metafield: ${SHOPIFY_METAFIELD_NAMESPACE}.${SHOPIFY_METAFIELD_KEY}`);
  console.log(`Graduation file: ${GRADUATION_FILE}`);
  console.log("");

  cleanGraduationHistory();

  const state = loadState();

  const standaloneCodes = Object.keys(state)
    .filter((key) => key.startsWith("title:"))
    .map((key) => key.replace("title:", ""))
    .filter((code) => !state[`bom:${code}`]);

  console.log(
    `Found ${standaloneCodes.length} standalone WLG product(s): ${
      standaloneCodes.join(", ") || "none"
    }`
  );

  for (const code of standaloneCodes) {
    try {
      await processStandaloneProduct(code, state);
    } catch (err) {
      console.error(`${code}: ERROR — ${err.message}`);
      log("error", `${code}: ${err.message}`);
    }
  }

  const bomParentCodes = Object.keys(state)
    .filter((key) => key.startsWith("bom:"))
    .map((key) => key.replace("bom:", ""));

  console.log("");
  console.log(
    `Found ${bomParentCodes.length} WLG BOM parent(s): ${
      bomParentCodes.join(", ") || "none"
    }`
  );

  for (const parentCode of bomParentCodes) {
    try {
      await processBomParent(parentCode, state);
    } catch (err) {
      console.error(`${parentCode}: ERROR — ${err.message}`);
      log("error", `${parentCode}: ${err.message}`);
    }
  }

  saveState(state);

  console.log("");
  console.log("==============================================");
  console.log(" WLG PRESALE CLEANUP COMPLETE");
  console.log("==============================================");
  console.log("");
}

// ==================================================
// RUN
// ==================================================

main().catch((err) => {
  console.error("SCRIPT CRASHED:", err.message);
  console.error(err);
  process.exit(1);
});