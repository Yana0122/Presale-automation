require("dotenv").config();

const fs = require("fs");
const path = require("path");
const OAuth = require("oauth-1.0a");
const crypto = require("crypto");
const JSONbig = require("json-bigint")({ storeAsString: true });

const LOG_FILE = "./automation.log";

// --------------------------------------------------
// LOGGING
// --------------------------------------------------

function log(type, msg) {
  const entry = {
    time: new Date().toISOString(),
    type,
    msg,
  };

  console.log(`[${type.toUpperCase()}] ${msg}`);
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
}

// --------------------------------------------------
// TRADEVINE AUTH
// --------------------------------------------------

const oauth = OAuth({
  consumer: {
    key: process.env.CHCH_TV_CONSUMER_KEY,
    secret: process.env.CHCH_TV_CONSUMER_SECRET,
  },
  signature_method: "HMAC-SHA1",
  hash_function: (base, key) =>
    crypto.createHmac("sha1", key).update(base).digest("base64"),
});

const token = {
  key: process.env.CHCH_TV_ACCESS_TOKEN,
  secret: process.env.CHCH_TV_ACCESS_TOKEN_SECRET,
};

// --------------------------------------------------
// SHARED WAREHOUSE ASSIGNMENT
// --------------------------------------------------

const { getOrAssignWarehouse } = require("../AKL/warehouse-assignment");

const PRESALE_QTY = 5;

// --------------------------------------------------
// CHCH STATE FILE
// --------------------------------------------------

const STATE_FILE = path.join(
  __dirname,
  "..",
  "json",
  "CHCH",
  "processed-state-chch.json"
);

// --------------------------------------------------
// SETTINGS
// --------------------------------------------------

const EXCLUDED_SUPPLIERS = ["Parmco Ltd"];

// --------------------------------------------------
// REAL STOCK SETTINGS
// --------------------------------------------------

const STOCK_THRESHOLD = 20;

const STOCK_RECHECK_DAYS = 7;

const STOCK_RECHECK_MS =
  STOCK_RECHECK_DAYS * 24 * 60 * 60 * 1000;

// Valid real warehouse / aisle format:
//
// 5-36-A-1
// 4-35-A-3
// 12-10-B-4
//
const REAL_AISLE_REGEX =
  /^\d{1,2}-\d{1,2}-[A-Za-z]-\d{1,2}$/;

// --------------------------------------------------
// PO CREATION CUTOFF
// --------------------------------------------------

const AUTOMATION_PO_CUTOFF_DATE = "2026-09-07";

function isPOEligible(po) {
  const createdDate = po.CreatedDate;

  if (!createdDate) {
    console.log(
      `⚠️ ${po.OrderNumber}: PO creation date missing — SKIPPING for safety`
    );

    return false;
  }

  const poDate = new Date(createdDate);

  const cutoffDate = new Date(
    `${AUTOMATION_PO_CUTOFF_DATE}T00:00:00`
  );

  if (Number.isNaN(poDate.getTime())) {
    console.log(
      `⚠️ ${po.OrderNumber}: Invalid PO creation date "${createdDate}" — SKIPPING`
    );

    return false;
  }

  if (poDate < cutoffDate) {
    console.log(
      `⏭️ ${po.OrderNumber}: SKIPPED — created ${createdDate}, before cutoff ${AUTOMATION_PO_CUTOFF_DATE}`
    );

    return false;
  }

  return true;
}

// // Keep restricted while testing.
// const ALLOWED_PO_NUMBERS = ["PO1589"];

// --------------------------------------------------
// STATE
// --------------------------------------------------

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
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

function saveState(state) {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(state, null, 2)
  );
}

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function withDsPrefix(title) {
  return /^DS\s+/i.test(title)
    ? title
    : `DS ${title}`;
}

function isExcludedByTitle(name) {
  return (name || "")
    .toUpperCase()
    .includes("NZ MADE");
}

function isChildCode(code) {
  return /^.+-[A-Za-z0-9]+$/.test(code);
}

function parentCodeFromChildCode(childCode) {
  return childCode.replace(
    /-[A-Za-z0-9]+$/,
    ""
  );
}

// --------------------------------------------------
// SUPPLIER CHECK
// --------------------------------------------------

function isExcludedSupplier(supplierName) {
  return EXCLUDED_SUPPLIERS.some(
    (excluded) =>
      excluded.toLowerCase() ===
      String(supplierName || "")
        .trim()
        .toLowerCase()
  );
}

// --------------------------------------------------
// COMPLETED INVENTORY CYCLE HELPERS
// --------------------------------------------------

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
      const parts = key.split(":");

      const poNumber = parts[1];
      const entry = state[key];

      return {
        key,
        poNumber,
        date:
          entry?.date ||
          entry?.processedDate ||
          "",
        supplier:
          entry?.supplier || "",
        entry,
      };
    })
    .filter(
      (cycle) =>
        cycle.entry?.done === true
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

// --------------------------------------------------
// CHECK WHETHER PRODUCT ALREADY HAS CURRENT CYCLE
// --------------------------------------------------

function hasInventoryForCycle(
  productCode,
  poNumber,
  state
) {
  const key =
    `inv:${poNumber}:${productCode}`;

  return state[key]?.done === true;
}

// --------------------------------------------------
// REQUIRED PRODUCT DATA CHECK
// --------------------------------------------------

function hasRequiredProductData(product) {
  const description = String(
    product.Description ??
      product.DescriptionHtml ??
      ""
  ).trim();

  const price = Number(
    product.Price ??
      product.SellingPrice ??
      product.RetailPrice ??
      0
  );

  return {
    valid:
      description.length > 0 &&
      price > 0,

    hasDescription:
      description.length > 0,

    hasPrice:
      price > 0,
  };
}

// --------------------------------------------------
// BLOCK MISSING PRODUCT DATA
// --------------------------------------------------

function blockMissingProductData(
  product,
  state,
  poNumber,
  supplierName
) {
  const check =
    hasRequiredProductData(product);

  if (check.valid) {
    return false;
  }

  const missing = [];

  if (!check.hasDescription) {
    missing.push("description");
  }

  if (!check.hasPrice) {
    missing.push("price");
  }

  const reason =
    `Missing ${missing.join(" and ")}`;

  const blockKey =
    `blocked:${poNumber}:${product.Code}`;

  state[blockKey] = {
    poNumber,
    supplier: supplierName,
    reason,
    detectedAt:
      new Date().toISOString(),
    productCode:
      product.Code,
  };

  saveState(state);

  log(
    "warn",
    `${product.Code} — BLOCKED for ${poNumber}: ${reason}`
  );

  console.log(
    `    ${product.Code}: BLOCKED — ${reason}`
  );

  return true;
}

// ==================================================
// REAL STOCK SAFETY CHECK
// ==================================================
//
// RULE:
//
// REAL STOCK >= 20
//      => STOP PRESALE
//
// REAL STOCK < 20
//      => ALLOW PRESALE
//
// UNKNOWN STOCK
//      => STOP PRESALE FOR SAFETY
//
// If blocked because stock >= 20,
// check again after 7 days.
//
// IMPORTANT:
// nextCheckAt only records when the next check is due.
// The script itself must run again after that time.
//

function getStockBlockKey(
  poNumber,
  productCode
) {
  return `blocked-stock:${poNumber}:${productCode}`;
}

function getStockBlock(
  state,
  poNumber,
  productCode
) {
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
    new Date(
      block.nextCheckAt
    ).getTime();

  if (!Number.isFinite(nextCheck)) {
    return true;
  }

  return (
    Date.now() >= nextCheck
  );
}

// --------------------------------------------------
// GET REAL WAREHOUSE / AISLE STOCK
// --------------------------------------------------

function getRealWarehouseStock(
  product
) {
  const rows =
    product?.PerWarehouseInventory;

  if (!Array.isArray(rows)) {
    return null;
  }

  const realAisles = [];

  for (const row of rows) {
    const warehouseCode =
      String(
        row?.WarehouseCode ??
          row?.warehouseCode ??
          row?.Code ??
          row?.code ??
          row?.WarehouseName ??
          row?.warehouseName ??
          ""
      ).trim();

    // Ignore presale warehouses and other
    // non-real-stock locations.
    if (
      !REAL_AISLE_REGEX.test(
        warehouseCode
      )
    ) {
      continue;
    }

    const quantity =
      Number(
        row?.QuantityInStockSnapshot
      );

    if (!Number.isFinite(quantity)) {
      return null;
    }

    realAisles.push({
      warehouseCode,
      quantity,
    });
  }

  if (realAisles.length === 0) {
    return null;
  }

  return realAisles;
}

// --------------------------------------------------
// CHECK REAL STOCK BEFORE PRESALE
// --------------------------------------------------

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

  // ------------------------------------------------
  // STILL WITHIN 7-DAY WAITING PERIOD
  // ------------------------------------------------

  if (
    existingBlock &&
    !isStockRecheckDue(
      existingBlock
    )
  ) {
    console.log(
      `    ${productCode}: BLOCKED — ` +
      `waiting for next real stock check`
    );

    console.log(
      `    Previous real stock: ${
        existingBlock.realStock
      }`
    );

    console.log(
      `    Next check: ${
        existingBlock.nextCheckAt
      }`
    );

    return false;
  }

  // ------------------------------------------------
  // REFRESH PRODUCT FROM TRADEVINE
  // ------------------------------------------------

  const freshProduct =
    await getProductByCode(
      productCode
    );

  if (!freshProduct) {
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
        "REAL_STOCK_CHECK_FAILED",

      blockedAt:
        existingBlock?.blockedAt ||
        new Date().toISOString(),

      lastCheckedAt:
        new Date().toISOString(),

      nextCheckAt,
    };

    saveState(state);

    console.log(
      `    ${productCode}: BLOCKED — ` +
      `could not refresh Tradevine product`
    );

    log(
      "warn",
      `${productCode} / ${poNumber} — ` +
      `could not refresh product for stock check`
    );

    return false;
  }

  // ------------------------------------------------
  // GET REAL WAREHOUSE STOCK
  // ------------------------------------------------

  const realAisles =
    getRealWarehouseStock(
      freshProduct
    );

  // ------------------------------------------------
  // UNKNOWN STOCK
  // ------------------------------------------------

  if (
    realAisles === null
  ) {
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

      nextCheckAt,
    };

    saveState(state);

    console.log(
      `    ${productCode}: BLOCKED — ` +
      `real warehouse stock could not be determined`
    );

    console.log(
      `    NO presale inventory will be added`
    );

    log(
      "warn",
      `${productCode} / ${poNumber} — ` +
      `REAL STOCK UNKNOWN — blocked for safety`
    );

    return false;
  }

  // ------------------------------------------------
  // DISPLAY REAL AISLE STOCK
  // ------------------------------------------------

  console.log(
    `    ${productCode}: real warehouse stock:`
  );

  for (const aisle of realAisles) {
    console.log(
      `      ${aisle.warehouseCode}: ${aisle.quantity}`
    );
  }

  // ------------------------------------------------
  // CRITICAL RULE
  //
  // ANY REAL AISLE >= 20
  // => BLOCK
  // ------------------------------------------------

  const blockedAisle =
    realAisles.find(
      (aisle) =>
        aisle.quantity >=
        STOCK_THRESHOLD
    );

  if (blockedAisle) {
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

      realStock:
        blockedAisle.quantity,

      blockedWarehouse:
        blockedAisle.warehouseCode,

      allRealAisles:
        realAisles,

      blockedAt:
        existingBlock?.blockedAt ||
        new Date().toISOString(),

      lastCheckedAt:
        new Date().toISOString(),

      nextCheckAt,
    };

    saveState(state);

    console.log("");
    console.log(
      `    ${productCode}: BLOCKED`
    );

    console.log(
      `    Real stock at ${blockedAisle.warehouseCode}: ` +
      `${blockedAisle.quantity} >= ${STOCK_THRESHOLD}`
    );

    console.log(
      `    NO DS / NO inventory / NO BOM action`
    );

    console.log(
      `    Next real stock check: ${nextCheckAt}`
    );

    log(
      "warn",
      `${productCode} / ${poNumber} — ` +
      `BLOCKED because real stock at ` +
      `${blockedAisle.warehouseCode} is ` +
      `${blockedAisle.quantity}. ` +
      `Next check ${nextCheckAt}`
    );

    return false;
  }

  // ------------------------------------------------
  // REAL STOCK < 20
  // => ALLOW PRESALE
  // ------------------------------------------------

  console.log("");
  console.log(
    `    ${productCode}: ALL REAL STOCK < ${STOCK_THRESHOLD} — PRESALE ALLOWED`
  );

  // ------------------------------------------------
  // CLEAR PREVIOUS STOCK BLOCK
  // ------------------------------------------------

  if (existingBlock) {
    delete state[blockKey];

    saveState(state);

    console.log(
      `    ${productCode}: STOCK BLOCK CLEARED`
    );

    log(
      "success",
      `${productCode} / ${poNumber} — ` +
      `real stock dropped below ${STOCK_THRESHOLD}; ` +
      `presale automation proceeding`
    );
  }

  return true;
}

// ==================================================
// TRADEVINE GET
// ==================================================

async function apiGet(url) {
  const requestData = {
    url,
    method: "GET",
  };

  const authHeader =
    oauth.toHeader(
      oauth.authorize(
        requestData,
        token
      )
    );

  const response =
    await fetch(url, {
      method: "GET",
      headers: {
        Authorization:
          authHeader.Authorization,
        Accept:
          "application/json",
      },
    });

  const raw =
    await response.text();

  let data = null;

  try {
    data =
      JSONbig.parse(raw);
  } catch {
    data = null;
  }

  return {
    status:
      response.status,
    data,
    raw,
  };
}

// ==================================================
// TRADEVINE POST
// ==================================================

async function apiPost(
  url,
  body
) {
  const requestData = {
    url,
    method: "POST",
  };

  const authHeader =
    oauth.toHeader(
      oauth.authorize(
        requestData,
        token
      )
    );

  const response =
    await fetch(url, {
      method: "POST",
      headers: {
        Authorization:
          authHeader.Authorization,
        "Content-Type":
          "application/json",
        Accept:
          "application/json",
      },
      body: JSON.stringify(body),
    });

  const raw =
    await response.text();

  let data = null;

  try {
    data =
      JSONbig.parse(raw);
  } catch {
    data = null;
  }

  return {
    status:
      response.status,
    data,
    raw,
  };
}

// ==================================================
// GET ALL AWAITING RECEIPT POs
// ==================================================

async function getAllAwaitingReceiptPOs() {
  const url =
    "https://api.tradevine.com/v1/PurchaseOrder";

  const result =
    await apiGet(
      `${url}?StatusID=19001&PageSize=200`
    );

  if (
    result.status !== 200
  ) {
    throw new Error(
      `Failed to fetch Purchase Orders: HTTP ${result.status}`
    );
  }

  return (
    result.data?.Items ||
    result.data ||
    []
  );
}

// ==================================================
// GET PRODUCT BY CODE
// ==================================================

async function getProductByCode(
  productCode
) {
  const url =
    `https://api.tradevine.com/v1/Product?Code=${encodeURIComponent(
      productCode
    )}`;

  const result =
    await apiGet(url);

  if (
    result.status !== 200
  ) {
    return null;
  }

  if (
    Array.isArray(
      result.data?.Items
    )
  ) {
    return (
      result.data.Items[0] ||
      null
    );
  }

  if (
    Array.isArray(
      result.data
    )
  ) {
    return (
      result.data[0] ||
      null
    );
  }

  return (
    result.data || null
  );
}

// ==================================================
// ADD INVENTORY
// ==================================================

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
      0,

    Notes:
      "CHCH Presale automation - adding pre-order stock",
  };

  const result =
    await apiPost(
      url,
      body
    );

  if (
    result.status === 200
  ) {
    console.log(
      `    ${productCode}: +${quantity} presale inventory added to ${warehouseCode} ✓`
    );

    return true;
  }

  console.log(
    `    ${productCode}: FAILED to add presale inventory`
  );

  console.log(
    result.raw?.slice(0, 500)
  );

  return false;
}

// ==================================================
// PREFIX DS
// ==================================================

async function prefixTitle(
  product,
  state,
  poNumber,
  supplierName
) {
  if (!product) {
    return false;
  }

  const currentName =
    String(
      product.Name || ""
    );

  if (
    /^DS\s+/i.test(
      currentName
    )
  ) {
    console.log(
      `    ${product.Code}: DS prefix already present ✓`
    );

    return true;
  }

  const newName =
    withDsPrefix(
      currentName
    );

  const url =
    `https://api.tradevine.com/v1/Product/${product.ProductID}`;

  const result =
    await apiPost(
      url,
      {
        ...product,
        Name: newName,
      }
    );

  if (
    result.status === 200
  ) {
    console.log(
      `    ${product.Code}: DS prefix added ✓`
    );

    return true;
  }

  console.log(
    `    ${product.Code}: FAILED to add DS prefix`
  );

  console.log(
    result.raw?.slice(0, 500)
  );

  return false;
}

// ==================================================
// PROCESS BOM PARENT
// ==================================================

async function processBomParent(
  parentCode,
  children,
  po,
  state
) {
  const poNumber =
    po.OrderNumber;

  const supplierName =
    po.Supplier?.Name || "";

  // ------------------------------------------------
  // CRITICAL:
  // CHECK ALL CHILDREN BEFORE ANY ACTION
  // ------------------------------------------------

  console.log(
    `    Checking real stock for all BOM children before processing ${parentCode}...`
  );

  for (const child of children) {
    const stockAllowed =
      await checkRealStockBeforePresale(
        child,
        poNumber,
        state,
        supplierName
      );

    if (!stockAllowed) {
      console.log("");
      console.log(
        `    ${parentCode}: BOM BLOCKED because child ${child.Code} failed real stock check`
      );

      log(
        "warn",
        `${parentCode} / ${poNumber} — BOM blocked because child ${child.Code} failed real stock check`
      );

      return;
    }
  }

  // ------------------------------------------------
  // CHECK CHILD PRODUCT DATA
  // ------------------------------------------------

  for (const child of children) {
    if (
      blockMissingProductData(
        child,
        state,
        poNumber,
        supplierName
      )
    ) {
      console.log(
        `    ${parentCode}: BOM blocked because child ${child.Code} has missing product data`
      );

      return;
    }
  }

  // ------------------------------------------------
  // ADD CHILD INVENTORY
  // ------------------------------------------------

  for (const child of children) {
    if (
      hasInventoryForCycle(
        child.Code,
        poNumber,
        state
      )
    ) {
      console.log(
        `    ${child.Code}: inventory already added for ${poNumber} — skipping`
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

    if (!ok) {
      console.log(
        `    ${parentCode}: child inventory failed for ${child.Code} — stopping BOM`
      );

      return;
    }

    state[
      `inv:${poNumber}:${child.Code}`
    ] = {
      done: true,
      date:
        new Date().toISOString(),
      supplier:
        supplierName || null,
    };

    saveState(state);
  }

  // ------------------------------------------------
  // PARENT BOM STATE
  // ------------------------------------------------

  state[
    `bom:${parentCode}`
  ] = {
    done: true,
    date:
      new Date().toISOString(),
    supplier:
      supplierName || null,
    poNumber,
  };

  saveState(state);

  // ------------------------------------------------
  // PARENT TITLE
  // ------------------------------------------------

  const titleKey =
    `title:${parentCode}`;

  const existingTitleState =
    state[titleKey];

  if (
    existingTitleState?.done === true &&
    String(
      existingTitleState.poNumber || ""
    ).toUpperCase() ===
      String(
        poNumber
      ).toUpperCase()
  ) {
    console.log(
      `    Title already recorded as done for ${parentCode} on ${poNumber}`
    );
  } else {
    const freshParent =
      await getProductByCode(
        parentCode
      );

    if (!freshParent) {
      console.log(
        `    ${parentCode}: parent not found before title update — stopping`
      );

      return;
    }

    const ok =
      await prefixTitle(
        freshParent,
        state,
        poNumber,
        supplierName
      );

    if (!ok) {
      console.log(
        `    ${parentCode}: title update failed — state not recorded`
      );

      return;
    }

    state[titleKey] = {
      done: true,
      date:
        new Date().toISOString(),
      supplier:
        supplierName || null,
      poNumber,
    };

    saveState(state);

    console.log(
      `    ${parentCode}: title state recorded for ${poNumber} ✓`
    );
  }

  console.log(
    `  ${parentCode}: CHCH BOM cycle ${poNumber} processed ✓`
  );

  log(
    "success",
    `${parentCode}: CHCH BOM cycle ${poNumber} processed`
  );
}

// ==================================================
// PROCESS STANDALONE PRODUCT
// ==================================================

async function processStandaloneProduct(
  product,
  po,
  state
) {
  const poNumber =
    po.OrderNumber;

  const supplierName =
    po.Supplier?.Name || "";

  console.log(
    `  Standalone: ${product.Code}`
  );

  // ------------------------------------------------
  // REAL STOCK CHECK FIRST
  // ------------------------------------------------

  const stockAllowed =
    await checkRealStockBeforePresale(
      product,
      poNumber,
      state,
      supplierName
    );

  if (!stockAllowed) {
    console.log(
      `    ${product.Code}: presale actions skipped because real stock check blocked it`
    );

    return;
  }

  // ------------------------------------------------
  // PRODUCT DATA
  // ------------------------------------------------

  if (
    blockMissingProductData(
      product,
      state,
      poNumber,
      supplierName
    )
  ) {
    return;
  }

  const invKey =
    `inv:${poNumber}:${product.Code}`;

  // ------------------------------------------------
  // INVENTORY
  // ------------------------------------------------

  if (
    !hasInventoryForCycle(
      product.Code,
      poNumber,
      state
    )
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

    if (ok) {
      state[invKey] = {
        done: true,
        date:
          new Date().toISOString(),
        supplier:
          supplierName || null,
      };

      saveState(state);
    }
  } else {
    console.log(
      `    Inventory already added for ${poNumber} — skipping`
    );
  }

  // ------------------------------------------------
  // TITLE
  // ------------------------------------------------

  const titleKey =
    `title:${product.Code}`;

  const existingTitleState =
    state[titleKey];

  if (
    existingTitleState?.done === true &&
    String(
      existingTitleState.poNumber || ""
    ).toUpperCase() ===
      String(
        poNumber
      ).toUpperCase()
  ) {
    console.log(
      `    Title already recorded as done for ${product.Code} on ${poNumber}`
    );

    return;
  }

  const freshProduct =
    await getProductByCode(
      product.Code
    );

  if (!freshProduct) {
    console.log(
      `    ${product.Code}: could not refresh product before title update`
    );

    return;
  }

  const ok =
    await prefixTitle(
      freshProduct,
      state,
      poNumber,
      supplierName
    );

  if (ok) {
    state[titleKey] = {
      done: true,
      date:
        new Date().toISOString(),
      supplier:
        supplierName || null,
      poNumber,
    };

    saveState(state);

    console.log(
      `    ${product.Code}: title state recorded for ${poNumber} ✓`
    );
  }
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
    " CHCH BOM / PRESALE AUTOMATION"
  );

  console.log(
    " INVENTORY + BOM + TITLE"
  );

  console.log(
    " + REAL STOCK SAFETY CHECK"
  );

  console.log(
    " + 7-DAY STOCK RECHECK"
  );

  console.log(
    "=============================================="
  );

  console.log("");

  const state =
    loadState();

  const allPos =
    await getAllAwaitingReceiptPOs();

  console.log(
    `Found ${allPos.length} total Awaiting Receipt PO(s) on this account.`
  );

  // ------------------------------------------------
  // PO CREATION CUTOFF
  // ------------------------------------------------

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

  // ------------------------------------------------
  // PROCESS ALL ELIGIBLE POs
  // ------------------------------------------------
  //
  // No single-PO restriction.
  // Every Awaiting Receipt PO created on or after
  // the cutoff date will be processed.
  //
  // Additional safety checks still apply:
  // - Excluded suppliers
  // - NZ MADE products
  // - Real stock >= 20
  // - Unknown real stock
  // - Missing product data
  //
  // ------------------------------------------------

  const pos = eligiblePos;

  console.log(
    `Processing ALL eligible POs after cutoff.`
  );

  console.log(
    `Total eligible POs to process: ${pos.length}`
  );

  console.log(
    `Will process: ${
      pos
        .map(
          (p) =>
            p.OrderNumber
        )
        .join(", ") ||
      "(none matched — check PO status/cutoff)"
    }\n`
  );

  // ------------------------------------------------
  // PROCESS POs
  // ------------------------------------------------

  for (const po of pos) {
    const supplierName =
      po.Supplier?.Name || "";

    if (
      isExcludedSupplier(
        supplierName
      )
    ) {
      console.log(
        `=== ${po.OrderNumber} — SKIPPED (excluded supplier: "${supplierName}") ===\n`
      );

      continue;
    }

    console.log(
      `=== ${po.OrderNumber} (Supplier: ${supplierName}) ===`
    );

    const childrenByParent =
      {};

    const standalone =
      [];

    // ------------------------------------------------
    // READ PO PRODUCTS
    // ------------------------------------------------

    for (
      const line of
        po.PurchaseOrderLines || []
    ) {
      const productId =
        line.productId ||
        line.ProductID;

      if (!productId) {
        console.log(
          "  PO line has no product ID — skipping"
        );

        continue;
      }

      const result =
        await apiGet(
          `https://api.tradevine.com/v1/Product/${productId}`
        );

      if (
        result.status !== 200 ||
        !result.data
      ) {
        console.log(
          `  Product lookup failed for PO line product ${productId}`
        );

        continue;
      }

      const product =
        result.data;

      if (
        isExcludedByTitle(
          product.Name
        )
      ) {
        console.log(
          `  ${product.Code}: title contains "NZ MADE" — excluded, skipping`
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

    // ------------------------------------------------
    // BOM PARENT GROUPS
    // ------------------------------------------------

    for (
      const parentCode of
        Object.keys(
          childrenByParent
        )
    ) {
      try {
        console.log(
          `  Parent group: ${parentCode}`
        );

        const children =
          childrenByParent[
            parentCode
          ];

        if (
          !children ||
          children.length === 0
        ) {
          console.log(
            `    ${parentCode}: no child products found — skipping`
          );

          continue;
        }

        await processBomParent(
          parentCode,
          children,
          po,
          state
        );
      } catch (err) {
        console.error(
          `${parentCode}: ERROR — ${err.message}`
        );

        log(
          "error",
          `${parentCode}: ${err.message}`
        );
      }
    }

    // ------------------------------------------------
    // STANDALONE PRODUCTS
    // ------------------------------------------------

    for (
      const product of
        standalone
    ) {
      try {
        await processStandaloneProduct(
          product,
          po,
          state
        );
      } catch (err) {
        console.error(
          `${product.Code}: ERROR — ${err.message}`
        );

        log(
          "error",
          `${product.Code}: ${err.message}`
        );
      }
    }

    console.log("");
  }

  // ------------------------------------------------
  // SAVE STATE
  // ------------------------------------------------

  saveState(state);

  console.log(
    "Done. State saved to",
    STATE_FILE
  );
}

// ==================================================
// RUN
// ==================================================

main().catch(
  (err) => {
    console.error(
      "SCRIPT CRASHED:",
      err.message
    );

    console.error(err);

    process.exit(1);
  }
);