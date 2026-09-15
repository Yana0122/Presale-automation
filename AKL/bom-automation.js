require("dotenv").config();
const fs = require("fs");
const path = require("path");

const LOG_FILE = "./automation.log";

function log(type, msg) {
  const entry = {
    time: new Date().toISOString(),
    type,
    msg
  };

  console.log(`[${type.toUpperCase()}] ${msg}`);
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
}

const OAuth = require("oauth-1.0a");
const crypto = require("crypto");
const JSONbig = require("json-bigint")({ storeAsString: true });

const oauth = OAuth({
  consumer: {
    key: process.env.TV_CONSUMER_KEY,
    secret: process.env.TV_CONSUMER_SECRET
  },
  signature_method: "HMAC-SHA1",
  hash_function: (base, key) =>
    crypto.createHmac("sha1", key).update(base).digest("base64"),
});

const token = {
  key: process.env.TV_ACCESS_TOKEN,
  secret: process.env.TV_ACCESS_TOKEN_SECRET
};

// const WAREHOUSE_ID = "3920199020988197194"; // Pre Order-1

const { getOrAssignWarehouse } = require("./warehouse-assignment");

// ============================================================
// PRESALE SETTINGS
// ============================================================

const PRESALE_QTY = 20;

// Product must have LESS THAN 20 real stock
// before presale automation is allowed to proceed.
const STOCK_THRESHOLD = 20;

// Blocked products are checked again after 7 days.
const STOCK_RECHECK_DAYS = 7;
const STOCK_RECHECK_MS =
  STOCK_RECHECK_DAYS * 24 * 60 * 60 * 1000;

const STATE_FILE = path.join(
  __dirname,
  "../json/AKL/processed-state.json"
);

// ============================================================
// STATE
// ============================================================

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};

  try {
    return JSON.parse(
      fs.readFileSync(STATE_FILE, "utf8")
    );
  } catch (err) {
    console.error("Could not read state file:", err);
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(state, null, 2)
  );
}

// ============================================================
// CYCLE-AWARE STATE HELPERS
// ============================================================

function isSameCycle(stateEntry, poNumber) {
  return (
    stateEntry &&
    String(stateEntry.poNumber || "").toUpperCase() ===
      String(poNumber || "").toUpperCase()
  );
}

// ============================================================
// GENERAL HELPERS
// ============================================================

function withDsPrefix(title) {
  return title.startsWith("DS ")
    ? title
    : `DS ${title}`;
}

function isExcludedByTitle(name) {
  return (name || "").toUpperCase().includes("NZ MADE");
}

function isChildCode(code) {
  return /^.+-[A-Za-z0-9]+$/.test(code);
}

function parentCodeFromChildCode(childCode) {
  return childCode.replace(/-[A-Za-z0-9]+$/, "");
}

// ============================================================
// TRADEVINE API
// ============================================================

async function apiGet(url) {
  const authHeader = oauth.toHeader(
    oauth.authorize(
      {
        url,
        method: "GET"
      },
      token
    )
  );

  const res = await fetch(url, {
    method: "GET",
    headers: {
      ...authHeader,
      Accept: "application/json"
    }
  });

  const text = await res.text();

  return {
    status: res.status,
    data: JSONbig.parse(text)
  };
}

async function apiPost(url, body) {
  const authHeader = oauth.toHeader(
    oauth.authorize(
      {
        url,
        method: "POST"
      },
      token
    )
  );

  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...authHeader,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();

  try {
    return {
      status: res.status,
      data: JSONbig.parse(text),
      raw: text
    };
  } catch {
    return {
      status: res.status,
      data: null,
      raw: text
    };
  }
}

// ============================================================
// PURCHASE ORDERS
// ============================================================

async function getAllAwaitingReceiptPOs() {
  const url =
    "https://api.tradevine.com/v1/PurchaseOrder?status=19001&pageSize=200";

  const { data } = await apiGet(url);

  return data.List || [];
}

// ============================================================
// PRODUCTS
// ============================================================

async function getProductByCode(code) {
  const url =
    `https://api.tradevine.com/v1/Product?code=${encodeURIComponent(code)}&pageSize=10`;

  const { data } = await apiGet(url);

  const list = data.List || data;

  return (
    list.find(
      (p) => p.Code === code
    ) || null
  );
}

async function getProductById(productId) {
  if (!productId) return null;

  const url =
    `https://api.tradevine.com/v1/Product/${productId}`;

  const { status, data } = await apiGet(url);

  if (status !== 200) {
    console.log(
      `    Could not retrieve full product inventory for ID ${productId}`
    );

    return null;
  }

  return data || null;
}
// ============================================================
// REAL STOCK — AISLE / WAREHOUSE CHECK
// ============================================================
//
// Only inventory locations matching this format are checked:
//
//   1-2-A-3
//   2-4-B-1
//   10-3-C-12
//
// Format:
//   number-number-letter-number
//
// RULE:
//
// If ANY matching aisle has stock >= 20
//     => BLOCK
//
// If ALL matching aisles have stock < 20
//     => ALLOW
//
// If NO matching aisle can be found
//     => BLOCK for safety
//
// ============================================================

function getRealStockFromAisles(product) {

  const AISLE_REGEX =
    /^\d{1,2}-\d{1,2}-[A-Za-z]-\d{1,2}$/;

  const inventory =
    product?.PerWarehouseInventory;

  if (!Array.isArray(inventory)) {

    console.log(
      `    ${product?.Code}: ` +
      `PerWarehouseInventory not found`
    );

    return {
      known: false,
      allowed: false,
      aisles: []
    };
  }

  const matchingAisles = [];

  for (const row of inventory) {

    const warehouseCode =
      String(
        row?.WarehouseCode || ""
      ).trim();

    // Only check aisle/location codes that match:
    // 1-2-A-3
    // 10-3-B-12
    if (!AISLE_REGEX.test(warehouseCode)) {
      continue;
    }

    const stock =
      Number(
        row?.QuantityInStockSnapshot
      );

    if (!Number.isFinite(stock)) {

      matchingAisles.push({
        aisle: warehouseCode,
        stock: null
      });

      continue;
    }

    matchingAisles.push({
      aisle: warehouseCode,
      stock
    });
  }

  // ----------------------------------------------------------
  // NO VALID AISLES FOUND
  // ----------------------------------------------------------

  if (matchingAisles.length === 0) {

    return {
      known: false,
      allowed: false,
      aisles: []
    };
  }

  // ----------------------------------------------------------
  // DISPLAY ALL MATCHING AISLES
  // ----------------------------------------------------------

  console.log(
    `    ${product.Code}: matching aisle inventory:`
  );

  for (const aisle of matchingAisles) {

    console.log(
      `      ${aisle.aisle} = ${aisle.stock}`
    );
  }

  // ----------------------------------------------------------
  // UNKNOWN STOCK ON ANY MATCHING AISLE
  // ----------------------------------------------------------

  const unknownAisle =
    matchingAisles.find(
      (row) => row.stock === null
    );

  if (unknownAisle) {

    return {
      known: false,
      allowed: false,
      aisles: matchingAisles
    };
  }

  // ----------------------------------------------------------
  // CRITICAL RULE
  //
  // ANY AISLE >= 20
  // => BLOCK
  // ----------------------------------------------------------

  const blockingAisle =
    matchingAisles.find(
      (row) =>
        row.stock >= STOCK_THRESHOLD
    );

  if (blockingAisle) {

    return {
      known: true,
      allowed: false,
      aisles: matchingAisles,
      blockingAisle
    };
  }

  // ----------------------------------------------------------
  // ALL AISLES ARE BELOW 20
  // => ALLOW
  // ----------------------------------------------------------

  return {
    known: true,
    allowed: true,
    aisles: matchingAisles
  };
}

// ============================================================
// STOCK BLOCK STATE
// ============================================================

function getStockBlockKey(poNumber, productCode) {
  return `blocked-stock:${poNumber}:${productCode}`;
}

function getStockBlock(state, poNumber, productCode) {

  const key =
    getStockBlockKey(
      poNumber,
      productCode
    );

  return state[key] || null;
}

function isStockRecheckDue(block) {

  if (!block) {
    return true;
  }

  if (!block.nextCheckAt) {
    return true;
  }

  const nextCheck =
    new Date(block.nextCheckAt).getTime();

  if (!Number.isFinite(nextCheck)) {
    return true;
  }

  return Date.now() >= nextCheck;
}

// ============================================================
// REAL STOCK SAFETY CHECK
// ============================================================
//
// RETURN:
// true  = allowed to continue with presale
// false = DO NOT action this product
//
// RULE:
//
// real stock < 20
//      => continue
//
// real stock >= 20
//      => block for 7 days
//
// unknown stock
//      => block for safety
// ============================================================

async function checkRealStockBeforePresale(
  product,
  poNumber,
  state,
  supplierName
) {

  const productCode =
    product.Code;

  const blockKey =
    getStockBlockKey(
      poNumber,
      productCode
    );

  const existingBlock =
    getStockBlock(
      state,
      poNumber,
      productCode
    );

  // ----------------------------------------------------------
  // STILL WITHIN 7-DAY WAITING PERIOD
  // ----------------------------------------------------------

  if (
    existingBlock &&
    !isStockRecheckDue(existingBlock)
  ) {

    console.log(
      `    ${productCode}: BLOCKED — ` +
      `waiting for next stock check`
    );

    console.log(
      `    Next check: ${existingBlock.nextCheckAt}`
    );

    return false;
  }

  // ----------------------------------------------------------
  // REFRESH PRODUCT
  // ----------------------------------------------------------

const freshProduct =
  await getProductById(
    product.ProductID
  );

  if (!freshProduct) {

    console.log(
      `    ${productCode}: BLOCKED — ` +
      `could not refresh product`
    );

    log(
      "warn",
      `${productCode} / ${poNumber} — ` +
      `could not refresh product for stock check`
    );

    state[blockKey] = {

      poNumber,

      productCode,

      supplier:
        supplierName || null,

      reason:
        "REAL_STOCK_CHECK_FAILED",

      blockedAt:
        existingBlock?.blockedAt ||
        new Date().toISOString(),

      lastCheckedAt:
        new Date().toISOString(),

      nextCheckAt:
        new Date(
          Date.now() +
          STOCK_RECHECK_MS
        ).toISOString()
    };

    saveState(state);

    return false;
  }

  // ----------------------------------------------------------
  // GET REAL STOCK
  // ----------------------------------------------------------
// ----------------------------------------------------------
// CHECK REAL STOCK BY AISLE
// ----------------------------------------------------------

const stockResult =
  getRealStockFromAisles(
    freshProduct
  );

// ----------------------------------------------------------
// UNKNOWN STOCK / NO AISLE
// ----------------------------------------------------------

if (!stockResult.known) {

  console.log(
    `    ${productCode}: BLOCKED — ` +
    `real stock could not be determined from aisle inventory`
  );

  console.log(
    `    NO presale inventory will be added`
  );

  const nextCheckAt =
    new Date(
      Date.now() +
      STOCK_RECHECK_MS
    ).toISOString();

  state[blockKey] = {

    poNumber,

    productCode,

    supplier:
      supplierName || null,

    reason:
      "REAL_STOCK_UNKNOWN",

    aisles:
      stockResult.aisles,

    blockedAt:
      existingBlock?.blockedAt ||
      new Date().toISOString(),

    lastCheckedAt:
      new Date().toISOString(),

    nextCheckAt
  };

  saveState(state);

  log(
    "warn",
    `${productCode} / ${poNumber} — ` +
    `REAL STOCK UNKNOWN — blocked for safety`
  );

  return false;
}

// ----------------------------------------------------------
// ANY AISLE >= 20
// => BLOCK
// ----------------------------------------------------------

if (!stockResult.allowed) {

  const blockingAisle =
    stockResult.blockingAisle;

  const nextCheckAt =
    new Date(
      Date.now() +
      STOCK_RECHECK_MS
    ).toISOString();

  console.log(
    `    ${productCode}: BLOCKED`
  );

  console.log(
    `    Aisle ${blockingAisle.aisle} ` +
    `has stock ${blockingAisle.stock} ` +
    `>= ${STOCK_THRESHOLD}`
  );

  console.log(
    `    NO DS / NO inventory / NO BOM action`
  );

  console.log(
    `    Next stock check: ${nextCheckAt}`
  );

  state[blockKey] = {

    poNumber,

    productCode,

    supplier:
      supplierName || null,

    reason:
      "AISLE_STOCK_20_OR_MORE",

    blockingAisle:
      blockingAisle.aisle,

    blockingStock:
      blockingAisle.stock,

    aisles:
      stockResult.aisles,

    blockedAt:
      existingBlock?.blockedAt ||
      new Date().toISOString(),

    lastCheckedAt:
      new Date().toISOString(),

    nextCheckAt
  };

  saveState(state);

  log(
    "warn",
    `${productCode} / ${poNumber} — ` +
    `BLOCKED because aisle ` +
    `${blockingAisle.aisle} has ` +
    `${blockingAisle.stock} stock. ` +
    `Next check ${nextCheckAt}`
  );

  return false;
}

// ----------------------------------------------------------
// ALL AISLES < 20
// => ALLOW PRESALE
// ----------------------------------------------------------

console.log(
  `    ${productCode}: ALL matching aisles have ` +
  `stock < ${STOCK_THRESHOLD} — PRESALE ALLOWED`
);

// If previously blocked, remove the block.
if (existingBlock) {

  delete state[blockKey];

  saveState(state);

  console.log(
    `    ${productCode}: STOCK BLOCK CLEARED`
  );

  log(
    "success",
    `${productCode} / ${poNumber} — ` +
    `all matching aisle stock is below ` +
    `${STOCK_THRESHOLD}; ` +
    `presale automation proceeding`
  );
}

return true;

  // ----------------------------------------------------------
  // UNKNOWN STOCK = SAFETY BLOCK
  // ----------------------------------------------------------

  if (realStock === null) {

    console.log(
      `    ${productCode}: BLOCKED — ` +
      `real stock could not be determined`
    );

    console.log(
      `    NO presale inventory will be added`
    );

    const nextCheckAt =
      new Date(
        Date.now() +
        STOCK_RECHECK_MS
      ).toISOString();

    state[blockKey] = {

      poNumber,

      productCode,

      supplier:
        supplierName || null,

      reason:
        "REAL_STOCK_UNKNOWN",

      realStock: null,

      blockedAt:
        existingBlock?.blockedAt ||
        new Date().toISOString(),

      lastCheckedAt:
        new Date().toISOString(),

      nextCheckAt
    };

    saveState(state);

    log(
      "warn",
      `${productCode} / ${poNumber} — ` +
      `REAL STOCK UNKNOWN — blocked for safety`
    );

    return false;
  }

  // ==========================================================
  // CRITICAL RULE
  //
  // REAL STOCK >= 20
  // => BLOCK
  // ==========================================================

  if (realStock >= STOCK_THRESHOLD) {

    const nextCheckAt =
      new Date(
        Date.now() +
        STOCK_RECHECK_MS
      ).toISOString();

    state[blockKey] = {

      poNumber,

      productCode,

      supplier:
        supplierName || null,

      reason:
        "REAL_STOCK_20_OR_MORE",

      realStock,

      blockedAt:
        existingBlock?.blockedAt ||
        new Date().toISOString(),

      lastCheckedAt:
        new Date().toISOString(),

      nextCheckAt
    };

    saveState(state);

    console.log(
      `    ${productCode}: BLOCKED`
    );

    console.log(
      `    Real stock ${realStock} >= ${STOCK_THRESHOLD}`
    );

    console.log(
      `    NO DS / NO inventory / NO BOM action`
    );

    console.log(
      `    Next stock check: ${nextCheckAt}`
    );

    log(
      "warn",
      `${productCode} / ${poNumber} — ` +
      `BLOCKED because real stock is ${realStock}. ` +
      `Next check ${nextCheckAt}`
    );

    return false;
  }

  // ==========================================================
  // REAL STOCK < 20
  // => ALLOW PRESALE
  // ==========================================================

  console.log(
    `    ${productCode}: REAL STOCK ${realStock} ` +
    `< ${STOCK_THRESHOLD} — PRESALE ALLOWED`
  );

  // If previously blocked, remove the block.
  if (existingBlock) {

    delete state[blockKey];

    saveState(state);

    console.log(
      `    ${productCode}: STOCK BLOCK CLEARED`
    );

    log(
      "success",
      `${productCode} / ${poNumber} — ` +
      `real stock dropped to ${realStock}; ` +
      `presale automation proceeding`
    );
  }

  return true;
}

// ============================================================
// ADD INVENTORY
// ============================================================

async function addInventory(
  productCode,
  quantity,
  warehouseCode
) {

  const url =
    "https://api.tradevine.com/v1/ProductInventory/MakeAdjustment";

  const body = {

    ProductCode:
      productCode,

    WarehouseCode:
      warehouseCode,

    InventoryType:
      36009,

    QuantityChange:
      quantity,

    ProductCostPrice:
      0.00,

    Notes:
      "Presale automation - initial stock"
  };

  const {
    status,
    raw
  } = await apiPost(
    url,
    body
  );

  log(
    status === 200
      ? "success"
      : "error",

    `Inventory +${quantity} on ${productCode}: ` +
    `${
      status === 200
        ? "OK"
        : "FAILED - " +
          raw.slice(0, 200)
    }`
  );

  return status === 200;
}

// ============================================================
// PREFIX TITLE
// ============================================================

async function prefixTitle(
  product,
  state,
  poNumber,
  supplierName
) {

  if (
    product.Name.startsWith("DS ")
  ) {

    console.log(
      `      Title already prefixed on ${product.Code}: ` +
      `"${product.Name}" — skipping`
    );

    return true;
  }

  const newName =
    withDsPrefix(
      product.Name
    );

  if (
    newName.length > 80
  ) {

    state[
      `blocked:${product.Code}`
    ] = {

      poNumber,

      supplier:
        supplierName,

      reason:
        "Title exceeds 80 chars",

      detectedAt:
        new Date().toISOString(),

      productCode:
        product.Code
    };

    saveState(state);

    log(
      "warn",
      `${product.Code} — ` +
      `title exceeds 80 chars, blocked`
    );

    return false;
  }

  const url =
    `https://api.tradevine.com/v1/Product/${product.ProductID}`;

  const {
    status,
    data,
    raw
  } = await apiPost(
    url,
    {
      ...product,
      Name: newName
    }
  );

  log(
    status === 200
      ? "success"
      : "error",

    `Title update on ${product.Code}: ` +
    `${
      status === 200
        ? `OK — "${data.Name}"`
        : "FAILED - " +
          raw.slice(0, 200)
    }`
  );

  return status === 200;
}

// ============================================================
// BOM
// ============================================================

async function linkChildrenToParent(
  parent,
  childProductIds
) {

  const existing =
    (parent.BoMComponents || [])
      .filter(
        (c) =>
          c.BoMComponentProductID
      );

  const existingIds =
    new Set(
      existing.map(
        (c) =>
          String(
            c.BoMComponentProductID
          )
      )
    );

  const newOnes =
    childProductIds.filter(
      (id) =>
        !existingIds.has(
          String(id)
        )
    );

  if (
    newOnes.length === 0
  ) {

    console.log(
      `      BOM link already complete for ${parent.Code}`
    );

    return true;
  }

  const merged = [

    ...existing.map(
      (c) => ({
        BoMComponentProductID:
          c.BoMComponentProductID,

        BoMComponentQuantity:
          c.BoMComponentQuantity || 1
      })
    ),

    ...newOnes.map(
      (id) => ({
        BoMComponentProductID:
          id,

        BoMComponentQuantity:
          1
      })
    )
  ];

  const url =
    `https://api.tradevine.com/v1/Product/SaveBoMComponents/${parent.ProductID}`;

  const {
    status,
    raw
  } = await apiPost(
    url,
    merged
  );

  console.log(
    `      BOM link for ${parent.Code}: ` +
    `${
      status === 200
        ? "OK"
        : "FAILED - " +
          raw.slice(0, 200)
    }`
  );

  return status === 200;
}

// ============================================================
// GRADUATED
// ============================================================

const GRADUATED_FILE =
  "./graduated-this-week.json";

function loadGraduated() {

  if (
    !fs.existsSync(
      GRADUATED_FILE
    )
  ) {
    return {};
  }

  try {

    return JSON.parse(
      fs.readFileSync(
        GRADUATED_FILE,
        "utf8"
      )
    );

  } catch {

    return {};
  }
}

function saveGraduated(data) {

  fs.writeFileSync(
    GRADUATED_FILE,

    JSON.stringify(
      data,
      null,
      2
    )
  );
}

// ============================================================
// PO CREATION CUTOFF
// ============================================================

const AUTOMATION_PO_CUTOFF_DATE =
  "2026-08-07";

function isPOEligible(po) {

  const createdDate =
    po.CreatedDate;

  if (!createdDate) {

    console.log(
      `⚠️ ${po.OrderNumber}: ` +
      `PO creation date missing — SKIPPING for safety`
    );

    return false;
  }

  const poDate =
    new Date(
      createdDate
    );

  const cutoffDate =
    new Date(
      `${AUTOMATION_PO_CUTOFF_DATE}T00:00:00`
    );

  if (
    Number.isNaN(
      poDate.getTime()
    )
  ) {

    console.log(
      `⚠️ ${po.OrderNumber}: ` +
      `Invalid PO creation date "${createdDate}" — SKIPPING`
    );

    return false;
  }

  if (
    poDate < cutoffDate
  ) {

    console.log(
      `⏭️ ${po.OrderNumber}: SKIPPED — ` +
      `created ${createdDate}, ` +
      `before cutoff ${AUTOMATION_PO_CUTOFF_DATE}`
    );

    return false;
  }

  return true;
}

// ============================================================
// RECORD GRADUATION
// ============================================================

function recordGraduation(
  productCode,
  extra = {}
) {

  const graduated =
    loadGraduated();

  graduated[productCode] = {

    productCode,

    date:
      new Date().toISOString(),

    ...extra
  };

  const cutoff =
    STOCK_RECHECK_DAYS * 24 * 60 * 60 * 1000;

  for (
    const [
      code,
      entry
    ] of Object.entries(
      graduated
    )
  ) {

    if (
      !entry.date ||
      new Date(
        entry.date
      ).getTime() < cutoff
    ) {

      delete graduated[code];
    }
  }

  saveGraduated(
    graduated
  );
}

// ============================================================
// MAIN
// ============================================================

async function main() {

  const state =
    loadState();

  const allPos =
    await getAllAwaitingReceiptPOs();

  console.log(
    `Found ${allPos.length} total Awaiting Receipt PO(s) on this account.`
  );

  // ----------------------------------------------------------
  // PO CUTOFF
  // ----------------------------------------------------------

  const eligiblePos =
    allPos.filter(
      isPOEligible
    );

  console.log(
    `PO cutoff: ${AUTOMATION_PO_CUTOFF_DATE}`
  );

  console.log(
    `Eligible POs after cutoff: ${eligiblePos.length}`
  );

  // ----------------------------------------------------------
  // PROCESS ALL ELIGIBLE POs
  // ----------------------------------------------------------
  //
  // No single-PO restriction.
  // Every Awaiting Receipt PO created on or after
  // the cutoff date will be processed.
  //

  const pos = eligiblePos;

  console.log(
    `Processing ALL eligible POs after cutoff date.`
  );

  console.log(
    `Total eligible POs to process: ${pos.length}`
  );

  console.log(
    `Will process: ${
      pos.map(
        (p) => p.OrderNumber
      ).join(", ") ||
      "(none matched — check PO status/cutoff)"
    }\n`
  );

  // ----------------------------------------------------------
  // EXCLUDED SUPPLIERS
  // ----------------------------------------------------------

  const EXCLUDED_SUPPLIERS = [
    "Parmco Ltd"
  ];

  // ----------------------------------------------------------
  // PROCESS POs
  // ----------------------------------------------------------

  for (
    const po of pos
  ) {

    const supplierName =
      po.Supplier?.Name || "";

    if (
      EXCLUDED_SUPPLIERS.some(
        (s) =>
          s.toLowerCase() ===
          supplierName.toLowerCase()
      )
    ) {

      console.log(
        `=== ${po.OrderNumber} — ` +
        `SKIPPED (excluded supplier: "${supplierName}") ===\n`
      );

      continue;
    }

    console.log(
      `=== ${po.OrderNumber} ` +
      `(Supplier: ${supplierName}) ===`
    );

    // --------------------------------------------------------
    // GROUP PRODUCTS
    // --------------------------------------------------------

    const childrenByParent = {};
    const standalone = [];

    for (
      const line of po.PurchaseOrderLines
    ) {

      const {
        data: product
      } = await apiGet(
        `https://api.tradevine.com/v1/Product/${line.productId || line.ProductID}`
      );

      if (
        isExcludedByTitle(
          product.Name
        )
      ) {

        console.log(
          `  ${product.Code}: ` +
          `title contains "NZ MADE" — excluded, skipping`
        );

        continue;
      }

      if (
        isChildCode(
          product.Code
        )
      ) {

        const parentCode =
          parentCodeFromChildCode(
            product.Code
          );

        if (
          !childrenByParent[
            parentCode
          ]
        ) {

          childrenByParent[
            parentCode
          ] = [];
        }

        childrenByParent[
          parentCode
        ].push(product);

      } else {

        standalone.push(
          product
        );
      }
    }

    // ========================================================
    // BOM PARENT GROUPS
    // ========================================================

    for (
      const parentCode of Object.keys(
        childrenByParent
      )
    ) {

      console.log(
        `  Parent group: ${parentCode}`
      );

      const children =
        childrenByParent[
          parentCode
        ];

      // ------------------------------------------------------
      // CHECK STOCK BEFORE DOING ANYTHING
      // ------------------------------------------------------

      let allChildrenAllowed =
        true;

      for (
        const child of children
      ) {

        const stockAllowed =
          await checkRealStockBeforePresale(
            child,
            po.OrderNumber,
            state,
            supplierName
          );

        if (
          !stockAllowed
        ) {

          allChildrenAllowed =
            false;

          console.log(
            `    ${child.Code}: ` +
            `presale actions skipped`
          );
        }
      }

      // ------------------------------------------------------
      // IMPORTANT:
      //
      // If ANY child has >=20 stock,
      // do NOT continue the BOM parent actions.
      // ------------------------------------------------------

      if (
        !allChildrenAllowed
      ) {

        console.log(
          `    ${parentCode}: ` +
          `BOM group BLOCKED because stock requirement was not met`
        );

        continue;
      }

      // ------------------------------------------------------
      // NOW it is safe to add presale inventory
      // ------------------------------------------------------

      for (
        const child of children
      ) {

        const invKey =
          `inv:${po.OrderNumber}:${child.Code}`;

        if (
          state[invKey]
        ) {

          console.log(
            `    ${child.Code}: ` +
            `inventory already added for this PO — skipping`
          );

          continue;
        }

        const warehouseCode =
          await getOrAssignWarehouse(
            child.Code,
            state
          );

        const ok =
          await addInventory(
            child.Code,
            PRESALE_QTY,
            warehouseCode
          );

        if (
          ok
        ) {

          state[invKey] = {

            done: true,

            date:
              new Date().toISOString(),

            supplier:
              supplierName || null
          };
        }
      }

      // ------------------------------------------------------
      // GET PARENT
      // ------------------------------------------------------

      const parent =
        await getProductByCode(
          parentCode
        );

      if (!parent) {

        console.log(
          `    BLOCKED: ` +
          `could not find parent product for code ${parentCode}`
        );

        continue;
      }

      if (
        isExcludedByTitle(
          parent.Name
        )
      ) {

        console.log(
          `    ${parent.Code}: ` +
          `title contains "NZ MADE" — excluded, skipping`
        );

        continue;
      }

      // ------------------------------------------------------
      // BOM LINK
      // ------------------------------------------------------

      const bomKey =
        `bom:${parentCode}`;

      if (
        !isSameCycle(
          state[bomKey],
          po.OrderNumber
        )
      ) {

        const ok =
          await linkChildrenToParent(
            parent,
            children.map(
              (c) => c.ProductID
            )
          );

        if (
          ok
        ) {

          state[bomKey] = {

            done: true,

            poNumber:
              po.OrderNumber,

            date:
              new Date().toISOString(),

            supplier:
              supplierName || null
          };
        }

      } else {

        console.log(
          `    BOM already recorded for ${parentCode} ` +
          `in ${po.OrderNumber} — skipping`
        );
      }

      // ------------------------------------------------------
      // TITLE
      // ------------------------------------------------------

      const titleKey =
        `title:${parentCode}`;

      if (
        !isSameCycle(
          state[titleKey],
          po.OrderNumber
        )
      ) {

        const freshParent =
          await getProductByCode(
            parentCode
          );

        const ok =
          await prefixTitle(
            freshParent,
            state,
            po.OrderNumber,
            supplierName
          );

        if (
          ok
        ) {

          state[titleKey] = {

            done: true,

            poNumber:
              po.OrderNumber,

            date:
              new Date().toISOString(),

            supplier:
              supplierName || null
          };
        }

      } else {

        console.log(
          `    Title already recorded for ${parentCode} ` +
          `in ${po.OrderNumber} — skipping`
        );
      }
    }

    // ========================================================
    // STANDALONE PRODUCTS
    // ========================================================

    for (
      const product of standalone
    ) {

      console.log(
        `  Standalone: ${product.Code}`
      );

      // ------------------------------------------------------
      // CHECK REAL STOCK FIRST
      // ------------------------------------------------------

      const stockAllowed =
        await checkRealStockBeforePresale(
          product,
          po.OrderNumber,
          state,
          supplierName
        );

      if (
        !stockAllowed
      ) {

        console.log(
          `    ${product.Code}: ` +
          `presale actions skipped because stock check blocked it`
        );

        continue;
      }

      // ------------------------------------------------------
      // NOW SAFE TO ADD PRESALE INVENTORY
      // ------------------------------------------------------

      const invKey =
        `inv:${po.OrderNumber}:${product.Code}`;

      if (
        !state[invKey]
      ) {

        const warehouseCode =
          await getOrAssignWarehouse(
            product.Code,
            state
          );

        const ok =
          await addInventory(
            product.Code,
            PRESALE_QTY,
            warehouseCode
          );

        if (
          ok
        ) {

          state[invKey] = {

            done: true,

            date:
              new Date().toISOString(),

            supplier:
              supplierName || null
          };
        }

      } else {

        console.log(
          `    Inventory already added for this PO — skipping`
        );
      }

      // ------------------------------------------------------
      // TITLE
      // ------------------------------------------------------

      const titleKey =
        `title:${product.Code}`;

      if (
        !isSameCycle(
          state[titleKey],
          po.OrderNumber
        )
      ) {

        const ok =
          await prefixTitle(
            product,
            state,
            po.OrderNumber,
            supplierName
          );

        if (
          ok
        ) {

          state[titleKey] = {

            done: true,

            poNumber:
              po.OrderNumber,

            date:
              new Date().toISOString(),

            supplier:
              supplierName || null
          };
        }

      } else {

        console.log(
          `    Title already recorded for ${product.Code} ` +
          `in ${po.OrderNumber} — skipping`
        );
      }
    }

    console.log("");
  }

  saveState(state);

  console.log(
    "Done. State saved to",
    STATE_FILE
  );
}

// ============================================================
// START
// ============================================================

main().catch(
  (err) =>
    console.error(
      "SCRIPT CRASHED:",
      err
    )
);