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

// AKL credentials — used ONLY for ShopifyProduct tag/title cleanup
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

const STATE_FILE = path.join(
  __dirname,
  "../json/WLG/processed-state-wlg.json"
);

const GRADUATION_FILE = path.join(
  __dirname,
  "../json/WLG/graduated-this-week-wlg.json"
);

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
// CURRENT CYCLE HELPERS
// ==================================================
//
// IMPORTANT:
// inv:PO:PRODUCT records are historical records.
//
// Example:
// inv:PO1560:PR13374
// inv:PO1580:PR13374
//
// The newest completed inv record is considered
// the current cycle.
//
// We NEVER delete these inv records.

// ==================================================
// GET ALL COMPLETED CYCLES FOR PRODUCT
// ==================================================

function getCompletedCyclesForProduct(productCode, state) {
  const cycles = [];
  const targetCode = String(productCode).trim().toUpperCase();

  for (const [key, value] of Object.entries(state)) {
    if (!key.startsWith("inv:")) {
      continue;
    }

    const parts = key.split(":");

    // Expected: inv:PO1560:PR13374
    if (parts.length !== 3) {
      continue;
    }

    const poNumber = parts[1];
    const code = parts[2];

    if (String(code).trim().toUpperCase() !== targetCode) {
      continue;
    }

    if (value?.done !== true) {
      continue;
    }

    const date = value?.date || value?.processedDate || null;

    cycles.push({
      productCode: code,
      poNumber,
      date,
      supplier: value?.supplier || "",
      stateKey: key,
    });
  }

  // Newest first
  cycles.sort((a, b) => {
    const aTime = Date.parse(a.date || "");
    const bTime = Date.parse(b.date || "");
    return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
  });

  return cycles;
}

// ==================================================
// GET CURRENT CYCLE FOR STANDALONE PRODUCT
// ==================================================

function getCurrentCycleForProduct(productCode, state) {
  const cycles = getCompletedCyclesForProduct(productCode, state);

  if (cycles.length === 0) {
    return null;
  }

  return cycles[0];
}

// ==================================================
// CHECK IF PRODUCT + PO ALREADY GRADUATED
// ==================================================

function hasGraduatedCycle(productCode, poNumber) {
  const history = loadGraduationHistory();

  return history.some((entry) => {
    const sameProduct =
      String(entry.productCode || "").trim().toUpperCase() ===
      String(productCode || "").trim().toUpperCase();

    const samePO =
      String(entry.poNumber || "").trim().toUpperCase() ===
      String(poNumber || "").trim().toUpperCase();

    return sameProduct && samePO;
  });
}

// ==================================================
// RECORD GRADUATION
// ==================================================

function recordGraduation(product, type, poNumber) {
  if (!product) {
    return;
  }

  const productCode = String(product.Code || "").trim();

  if (!productCode) {
    console.log("    Cannot record graduation: product code missing");
    return;
  }

  const history = loadGraduationHistory();

  // Do not overwrite another PO cycle.
  // Cycle 1: PR13374 + PO1560
  // Cycle 2: PR13374 + PO1580
  // Both are retained.

  const alreadyExists = history.some((entry) => {
    const sameProduct =
      String(entry.productCode || "").toUpperCase() === productCode.toUpperCase();

    const samePO =
      String(entry.poNumber || "").toUpperCase() ===
      String(poNumber || "").toUpperCase();

    return sameProduct && samePO;
  });

  if (alreadyExists) {
    console.log(`    ${productCode} / ${poNumber}: graduation already recorded`);
    return;
  }

  const supplier =
    product.SupplierName || product.Supplier || product.Supplier?.Name || "";

  const record = {
    productCode,
    productName: String(product.Name || ""),
    date: new Date().toISOString(),
    supplier: String(supplier || ""),
    type,
    poNumber: poNumber || product.PONumber || product.PurchaseOrderNumber || null,
  };

  history.push(record);
  saveGraduationHistory(history);

  console.log("");
  console.log(
    `    ✓ ${productCode} / ${record.poNumber || "UNKNOWN PO"} saved to graduated-this-week-wlg.json`
  );

  log(
    "success",
    `${productCode} / ${record.poNumber || "UNKNOWN PO"}: graduation recorded`
  );
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

// ==================================================
// AKL TRADEVINE GET
// ==================================================

async function aklApiGet(url) {
  const authHeader = aklOauth.toHeader(
    aklOauth.authorize(
      {
        url,
        method: "GET",
      },
      aklToken
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
// AKL TRADEVINE POST
// ==================================================

async function aklApiPost(url, body) {
  const authHeader = aklOauth.toHeader(
    aklOauth.authorize(
      {
        url,
        method: "POST",
      },
      aklToken
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
    `${TV_API}/v1/Product` +
    `?code=${encodeURIComponent(code)}` +
    `&pageSize=10`;

  const result = await apiGet(url);

  if (result.status !== 200 || !result.data) {
    console.log(`${code}: Tradevine Product lookup failed — HTTP ${result.status}`);
    console.log((result.raw || "").slice(0, 500));
    return null;
  }

  const list = result.data.List || result.data.list || result.data;

  if (!Array.isArray(list)) {
    console.log(`${code}: Tradevine Product response did not contain a product list`);
    return null;
  }

  const product = list.find(
    (item) =>
      String(item.Code || "").toUpperCase() === String(code).toUpperCase()
  );

  if (!product) {
    console.log(`${code}: product not found in Tradevine`);
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

  const url = `${TV_API}/v1/ProductInventory/MakeAdjustment`;

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

  const url = `${TV_API}/v1/Product/${product.ProductID}`;

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

// ==================================================
// REMOVE PRE-ORDER WELLINGTON TAG
// ==================================================

function removePreOrderTag(tagsString) {
  return (tagsString || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .filter((tag) => tag.toLowerCase() !== "pre-order-wellington")
    .join(", ");
}

// ==================================================
// FIND TRADEVINE SHOPIFY PRODUCT RECORD
// ==================================================

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

  const list = result.data.List || result.data.list || [];

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
    `${productCode}: ShopifyProduct found — ShopifyProductID ${String(
      record.ShopifyProductID
    )}`
  );

  return record;
}

// ==================================================
// CLEAN TRADEVINE SHOPIFY PRODUCT
// ==================================================

async function stripDsPrefixAndTagFromShopify(productCode) {
  const record = await getShopifyProductRecord(productCode);

  if (!record) {
    log(
      "info",
      `${productCode}: no ShopifyProduct record — skipping Shopify tab cleanup`
    );
    return true;
  }

  const updates = {};

  // Remove DS from Shopify tab title
  if (typeof record.Title === "string" && /^DS\s+/i.test(record.Title)) {
    updates.Title = record.Title.replace(/^DS\s+/i, "");
  }

  // Remove WLG tag
  const cleanedTags = removePreOrderTag(record.Tags);

  if (cleanedTags !== (record.Tags || "").trim()) {
    updates.Tags = cleanedTags;
  }

  if (Object.keys(updates).length === 0) {
    log("info", `${productCode}: Shopify tab already clean (title/tags)`);
    return true;
  }

  const shopifyProductId = String(record.ShopifyProductID);
  const url = `${TV_API}/v1/ShopifyProduct/${shopifyProductId}`;

  const body = {
    ...record,
    ...updates,
  };

  const result = await aklApiPost(url, body);

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
    `${productCode}: Shopify tab updated (${Object.keys(updates).join(", ")})`
  );

  // Verify
  const verifiedRecord = await getShopifyProductRecord(productCode);

  if (!verifiedRecord) {
    log("error", `${productCode}: could not verify Shopify tab after update`);
    return false;
  }

  const titleClean = !/^DS\s+/i.test(verifiedRecord.Title || "");
  const tagList = (verifiedRecord.Tags || "")
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);

  const tagClean = !tagList.includes("pre-order-wellington");

  if (!titleClean || !tagClean) {
    log("error", `${productCode}: Shopify tab verification FAILED`);
    return false;
  }

  log("success", `${productCode}: Shopify tab cleanup VERIFIED`);
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

  const tags = Array.isArray(product.tags) ? product.tags : [];

  // Verify WLG tag
  const tagStillExists = tags.some(
    (tag) =>
      String(tag).trim().toLowerCase() === "pre-order-wellington"
  );

  if (tagStillExists) {
    console.log(`    ${SHOPIFY_TAG} still exists on Shopify — verification FAILED`);
    return false;
  }

  console.log(`${SHOPIFY_TAG} removed ✓`);

  // Verify metafield
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
// SHOPIFY GRADUATION CLEANUP
// ==================================================

async function runShopifyCleanup(productCode) {
  console.log("");
  console.log(`    ${productCode}: starting Shopify cleanup`);

  // 1. TRADEVINE SHOPIFY TAB
  const shopifyTabOk = await stripDsPrefixAndTagFromShopify(productCode);

  if (!shopifyTabOk) {
    console.log(
      `    ${productCode}: BLOCKED — Tradevine ShopifyProduct cleanup failed`
    );
    return false;
  }

  console.log(`    ${productCode}: Tradevine ShopifyProduct cleanup verified ✓`);

  // 2. FIND ACTUAL SHOPIFY PRODUCT
  const shopifyProduct = await findShopifyProductBySku(productCode);

  if (!shopifyProduct) {
    console.log(
      `    ${productCode}: Shopify product could not be found for arriving-date cleanup`
    );
    return false;
  }

  console.log(`    Shopify product: ${shopifyProduct.title}`);
  console.log(`    Shopify ID: ${shopifyProduct.id}`);

  // 3. DELETE WELLINGTON ARRIVING DATE
  const metafieldOk = await deleteWellingtonArrivingDate(shopifyProduct.id);

  if (!metafieldOk) {
    console.log(`    ${productCode}: Shopify arriving-date deletion FAILED`);
    return false;
  }

  // 4. FINAL VERIFICATION
  const verified = await verifyShopifyCleanup(shopifyProduct.id);

  if (!verified) {
    console.log(`    ${productCode}: Shopify arriving-date verification FAILED`);
    return false;
  }

  console.log(`    ${productCode}: Shopify cleanup fully verified ✓`);
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

  // Current cycle
  const currentCycle = getCurrentCycleForProduct(code, state);

  if (!currentCycle) {
    console.log(`${code}: no completed inventory cycle found — skipping`);
    log("info", `${code}: no completed inventory cycle found`);
    return;
  }

  const currentPO = currentCycle.poNumber;

  console.log(`    Current presale cycle: ${currentPO}`);
  log("info", `${code}: current cycle = ${currentPO}`);

  // Already graduated?
  if (hasGraduatedCycle(code, currentPO)) {
    console.log(`    ${code}: already graduated for ${currentPO} — skipping`);
    log("info", `${code} / ${currentPO}: already graduated`);
    return;
  }

  // Get product
  let product = await getProductByCode(code);

  if (!product) {
    console.log(`${code}: product not found — skipping`);
    return;
  }

  // NZ MADE
  if (isExcludedByTitle(product.Name)) {
    console.log(`${code}: title contains "NZ MADE" — excluded, skipping`);
    return;
  }

  // Real stock
  const realStock = hasRealWarehouseStock(product);

  log("info", `${code}: current cycle ${currentPO}, hasRealStock = ${realStock}`);

  if (!realStock) {
    console.log(`  ${code}: still presale-only — no action`);
    return;
  }

  console.log(`  ${code}: REAL warehouse stock detected ✓`);

  // Clear pre-order stock
  const zeroOk = await zeroOutPreOrderStock(product, state);

  if (!zeroOk) {
    console.log(`  ${code}: graduation STOPPED — could not clear pre-order stock`);
    return;
  }

  // Refresh product
  product = await getProductByCode(code);

  if (!product) {
    console.log(`  ${code}: product could not be reloaded after stock cleanup`);
    return;
  }

  // Remove DS
  const titleOk = await stripDsPrefix(product);

  if (!titleOk) {
    console.log(`  ${code}: cleanup STOPPED — DS title removal failed`);
    return;
  }

  // Shopify cleanup
  const shopifyOk = await runShopifyCleanup(code);

  if (!shopifyOk) {
    console.log(`  ${code}: cleanup STOPPED — Shopify cleanup incomplete`);
    return;
  }

  // Final refresh
  product = await getProductByCode(code);

  if (!product) {
    console.log(`  ${code}: final product lookup failed`);
    return;
  }

  // Record graduation
  //
  // IMPORTANT:
  // Record product + CURRENT PO.

  recordGraduation(product, "standalone", currentPO);

  // Remove temporary state
  //
  // DO NOT REMOVE inv:PO:PRODUCT

  delete state[`title:${code}`];
  delete state[`warehouse:${code}`];

  console.log(`  ${code}: WLG presale cleanup completed for ${currentPO} ✓`);
  log("success", `${code} / ${currentPO}: WLG presale cleanup completed`);
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

  // NZ MADE
  if (isExcludedByTitle(parent.Name)) {
    console.log(`${parentCode}: title contains "NZ MADE" — excluded, skipping`);
    return;
  }

  // KEEP EXISTING WORKING BOM LOGIC
  //
  // IMPORTANT:
  // Do NOT change this to another guessed field.
  //
  // Your working API returns:
  //
  // parent.BoMComponents
  //
  // and each component contains:
  //
  // component.BoMComponentProductCode

  const components = (parent.BoMComponents || []).filter(
    (component) => component.BoMComponentProductCode
  );

  if (components.length === 0) {
    console.log(`${parentCode}: no BOM components found — skipping`);
    return;
  }

  console.log(`${parentCode}: checking ${components.length} child component(s)...`);

  // DETERMINE CURRENT BOM CYCLE
  //
  // Each child has:
  //
  // inv:PO:CHILD
  //
  // We use the newest completed cycle for each child.
  //
  // All children must belong to the same PO.

  const childCycles = [];

  for (const component of components) {
    const childCode = component.BoMComponentProductCode;

    const childCycle = getCurrentCycleForProduct(childCode, state);

    if (!childCycle) {
      console.log(`  ${childCode}: no completed inventory cycle found`);
      return;
    }

    childCycles.push({
      childCode,
      cycle: childCycle,
    });
  }

  const childPOs = [...new Set(childCycles.map((item) => String(item.cycle.poNumber)))];

  if (childPOs.length !== 1) {
    console.log(
      `  ${parentCode}: BLOCKED — BOM children belong to different PO cycles: ${childPOs.join(
        ", "
      )}`
    );

    log("warn", `${parentCode}: BOM children have mixed PO cycles`);
    return;
  }

  const currentPO = childPOs[0];

  console.log(`    Current BOM presale cycle: ${currentPO}`);
  log("info", `${parentCode}: current BOM cycle = ${currentPO}`);

  // Already graduated?
  if (hasGraduatedCycle(parentCode, currentPO)) {
    console.log(`    ${parentCode}: already graduated for ${currentPO} — skipping`);
    log("info", `${parentCode} / ${currentPO}: already graduated`);
    return;
  }

  // Fetch child products
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

    // Supplier protection
    if (isBlocked(childCode, state)) {
      allChildrenReady = false;
      continue;
    }

    // NZ MADE protection
    if (isExcludedByTitle(child.Name)) {
      console.log(`  ${childCode}: NZ MADE — not ready`);
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

  // All children must have real stock
  if (!allChildrenReady) {
    console.log(`  ${parentCode}: not all children have real stock yet — no action`);
    return;
  }

  console.log(`  ${parentCode}: all children have real stock ✓`);

  // Clear pre-order stock on children
  for (const child of childProducts) {
    const childZeroOk = await zeroOutPreOrderStock(child, state);

    if (!childZeroOk) {
      console.log(
        `  ${parentCode}: child ${child.Code} stock cleanup failed — stopping`
      );
      return;
    }
  }

  // Refresh parent
  const freshParent = await getProductByCode(parentCode);

  if (!freshParent) {
    console.log(`  ${parentCode}: parent could not be reloaded`);
    return;
  }

  // Remove DS from parent
  const titleOk = await stripDsPrefix(freshParent);

  if (!titleOk) {
    console.log(`  ${parentCode}: DS removal failed — stopping`);
    return;
  }

  // Shopify cleanup
  //
  // Only parent gets Shopify cleanup.
  //
  // Children remain protected as BOM components.

  const shopifyOk = await runShopifyCleanup(parentCode);

  if (!shopifyOk) {
    console.log(`  ${parentCode}: Shopify cleanup incomplete — state retained`);
    return;
  }

  // Final parent refresh
  const finalParent = await getProductByCode(parentCode);

  if (!finalParent) {
    console.log(`  ${parentCode}: final parent lookup failed`);
    return;
  }

  // Record BOM graduation
  //
  // IMPORTANT:
  // Product + PO.

  recordGraduation(finalParent, "bom", currentPO);

  // Remove temporary parent state
  //
  // DO NOT REMOVE inv:PO:CHILD.

  delete state[`title:${parentCode}`];
  delete state[`bom:${parentCode}`];
  delete state[`warehouse:${parentCode}`];

  console.log(`  ${parentCode}: WLG BOM presale cleanup completed for ${currentPO} ✓`);
  log("success", `${parentCode} / ${currentPO}: WLG BOM presale cleanup completed`);
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
  console.log(" + CYCLE 1 / CYCLE 2 SUPPORT");
  console.log("==============================================");
  console.log("");

  console.log("✓ WLG Tradevine credentials loaded");
  console.log("✓ WLG Shopify credentials loaded");
  console.log(`Shopify store: ${SHOPIFY_STORE}`);
  console.log(`Shopify tag: ${SHOPIFY_TAG}`);
  console.log(`Metafield: ${SHOPIFY_METAFIELD_NAMESPACE}.${SHOPIFY_METAFIELD_KEY}`);
  console.log(`Graduation file: ${GRADUATION_FILE}`);
  console.log("");

  // Clean old graduation history
  cleanGraduationHistory();

  // Load state
  const state = loadState();

  // Standalone products
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

  // BOM parents
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

  // Save state
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