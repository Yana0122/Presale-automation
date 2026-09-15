require("dotenv").config();

const fs = require("fs");
const path = require("path");
const OAuth = require("oauth-1.0a");
const crypto = require("crypto");
const JSONbig = require("json-bigint")({
  storeAsString: true,
});

const LOG_FILE = "./automation.log";

// --------------------------------------------------
// STOCK CONTROL
// --------------------------------------------------

const PRESALE_QTY = 5;

// Maximum real warehouse stock allowed for presale.
// If real stock is ABOVE this number, presale is stopped.
const REAL_STOCK_LIMIT = 20;

// After this many days, real warehouse stock is checked again.
const STOCK_RECHECK_DAYS = 7;

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

// --------------------------------------------------
// CONFIG
// --------------------------------------------------

const { getOrAssignWarehouse } = require("../AKL/warehouse-assignment");

const STATE_FILE = path.join(
  __dirname,
  "..",
  "json",
  "WLG",
  "processed-state-wlg.json"
);

const EXCLUDED_SUPPLIERS = ["Parmco Ltd"];

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

// --------------------------------------------------
// SAFETY RESTRICTION WHILE TESTING
// --------------------------------------------------

// const ALLOWED_PO_NUMBERS = ["PO1560"];

// --------------------------------------------------
// STATE
// --------------------------------------------------

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (err) {
    log(
      "error",
      `Could not read ${STATE_FILE}: ${err.message}`
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
// CYCLE-AWARE STATE KEYS
// --------------------------------------------------

function makeStateKey(type, poNumber, productCode) {
  const po = String(poNumber || "").trim().toUpperCase();
  const code = String(productCode || "").trim().toUpperCase();

  return `${type}:${po}:${code}`;
}

// Examples:
//
// inv:PO1560:PR13374-A
// title:PO1560:PR13374
// bom:PO1560:PR13374
// blocked:PO1560:PR13374
// stockcheck:PO1560:PR13374-A
//
// The stockcheck key is also PO/product specific so the
// same product can enter presale again on a future PO.

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function withDsPrefix(title) {
  return title.startsWith("DS ")
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
// PRODUCT DATA VALIDATION
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

  const blockedKey = makeStateKey(
    "blocked",
    poNumber,
    product.Code
  );

  state[blockedKey] = {
    poNumber,
    supplier: supplierName,
    reason,
    detectedAt: new Date().toISOString(),
    productCode: product.Code,
  };

  saveState(state);

  log(
    "warn",
    `${product.Code} + ${poNumber} — BLOCKED: ${reason}`
  );

  console.log(
    `    ${product.Code}: BLOCKED — ${reason}`
  );

  return true;
}

// --------------------------------------------------
// API
// --------------------------------------------------

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

  return {
    status: res.status,
    data: JSONbig.parse(text),
  };
}

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

// --------------------------------------------------
// REAL WAREHOUSE STOCK
// --------------------------------------------------

async function getRealWarehouseStock(
  productCode,
  warehouseCode
) {
  if (!warehouseCode) {
    log(
      "error",
      `${productCode}: No warehouse code available — cannot safely check real stock`
    );

    return null;
  }

  const url =
    `https://api.tradevine.com/v1/Product?code=${encodeURIComponent(
      productCode
    )}&pageSize=10`;

  const { data } = await apiGet(url);

  const list =
    data.List || data;

  const product =
    list.find(
      (p) => p.Code === productCode
    ) || null;

  if (!product) {
    log(
      "error",
      `${productCode}: Could not retrieve product while checking warehouse stock`
    );

    return null;
  }

  const warehouses =
    product.PerWarehouseInventory || [];

  const warehouse =
    warehouses.find(
      (w) =>
        String(w.WarehouseCode || "")
          .trim()
          .toUpperCase() ===
        String(warehouseCode || "")
          .trim()
          .toUpperCase()
    );

  if (!warehouse) {
    log(
      "warn",
      `${productCode}: Warehouse ${warehouseCode} not found in PerWarehouseInventory`
    );

    return 0;
  }

  const stock = Number(
    warehouse.QuantityInStockSnapshot ?? 0
  );

  if (Number.isNaN(stock)) {
    log(
      "error",
      `${productCode}: Invalid warehouse stock returned for ${warehouseCode}`
    );

    return null;
  }

  return stock;
}

// --------------------------------------------------
// STOCK CHECK
// --------------------------------------------------

function daysSince(dateString) {
  if (!dateString) {
    return Infinity;
  }

  const date = new Date(dateString);

  if (Number.isNaN(date.getTime())) {
    return Infinity;
  }

  const diff =
    Date.now() - date.getTime();

  return diff / (
    1000 *
    60 *
    60 *
    24
  );
}

// --------------------------------------------------
// CHECK WHETHER REAL STOCK ALLOWS PRESALE
// --------------------------------------------------

async function canContinuePresale(
  product,
  state,
  poNumber,
  supplierName,
  warehouseCode
) {
  const stockKey = makeStateKey(
    "stockcheck",
    poNumber,
    product.Code
  );

  const existingCheck =
    state[stockKey];

  // ------------------------------------------------
  // FIRST CHECK
  // ------------------------------------------------

  if (!existingCheck) {
    console.log(
      `    ${product.Code}: Checking real ${warehouseCode} warehouse stock...`
    );

    const realStock =
      await getRealWarehouseStock(
        product.Code,
        warehouseCode
      );

    if (realStock === null) {
      console.log(
        `    ${product.Code}: REAL STOCK CHECK FAILED — skipping presale for safety`
      );

      return false;
    }

    state[stockKey] = {
      productCode: product.Code,
      poNumber,
      supplier: supplierName || null,
      warehouseCode,
      realStock,
      checkedAt:
        new Date().toISOString(),
      status:
        realStock > REAL_STOCK_LIMIT
          ? "STOPPED_HIGH_REAL_STOCK"
          : "PRESALE_ALLOWED",
    };

    saveState(state);

    if (realStock > REAL_STOCK_LIMIT) {
      console.log(
        `    ${product.Code}: REAL STOCK ${realStock} > ${REAL_STOCK_LIMIT} — STOPPING PRESALE`
      );

      log(
        "warn",
        `${product.Code} + ${poNumber}: real ${warehouseCode} stock is ${realStock}, above limit ${REAL_STOCK_LIMIT} — presale stopped`
      );

      return false;
    }

    console.log(
      `    ${product.Code}: REAL STOCK ${realStock} <= ${REAL_STOCK_LIMIT} — presale allowed`
    );

    return true;
  }

  // ------------------------------------------------
  // 7-DAY RECHECK
  // ------------------------------------------------

  const elapsedDays =
    daysSince(
      existingCheck.checkedAt
    );

  if (
    elapsedDays >=
    STOCK_RECHECK_DAYS
  ) {
    console.log(
      `    ${product.Code}: 7+ days since last stock check — rechecking real ${warehouseCode} stock...`
    );

    const previousStock =
      Number(
        existingCheck.realStock
      );

    const currentStock =
      await getRealWarehouseStock(
        product.Code,
        warehouseCode
      );

    if (currentStock === null) {
      console.log(
        `    ${product.Code}: REAL STOCK RECHECK FAILED — skipping presale for safety`
      );

      return false;
    }

    const decreased =
      currentStock < previousStock;

    state[stockKey] = {
      ...existingCheck,
      previousRealStock:
        previousStock,
      realStock:
        currentStock,
      previousCheckedAt:
        existingCheck.checkedAt,
      checkedAt:
        new Date().toISOString(),
      stockDecreased:
        decreased,
      status:
        currentStock > REAL_STOCK_LIMIT
          ? "STOPPED_HIGH_REAL_STOCK"
          : "PRESALE_ALLOWED",
    };

    saveState(state);

    console.log(
      `    ${product.Code}: previous real stock ${previousStock} → current real stock ${currentStock}`
    );

    if (decreased) {
      log(
        "info",
        `${product.Code} + ${poNumber}: real warehouse stock decreased from ${previousStock} to ${currentStock}`
      );
    } else {
      log(
        "info",
        `${product.Code} + ${poNumber}: real warehouse stock did not decrease (${previousStock} → ${currentStock})`
      );
    }

    if (
      currentStock > REAL_STOCK_LIMIT
    ) {
      console.log(
        `    ${product.Code}: REAL STOCK ${currentStock} > ${REAL_STOCK_LIMIT} — STOPPING PRESALE`
      );

      return false;
    }

    console.log(
      `    ${product.Code}: REAL STOCK ${currentStock} <= ${REAL_STOCK_LIMIT} — presale allowed`
    );

    return true;
  }

  // ------------------------------------------------
  // EXISTING CHECK STILL VALID
  // ------------------------------------------------

  if (
    Number(existingCheck.realStock) >
    REAL_STOCK_LIMIT
  ) {
    console.log(
      `    ${product.Code}: Previous real stock check was ${existingCheck.realStock} > ${REAL_STOCK_LIMIT} — presale remains stopped`
    );

    return false;
  }

  console.log(
    `    ${product.Code}: Real stock check still valid (${existingCheck.realStock}) — presale allowed`
  );

  return true;
}

// --------------------------------------------------
// GET ALL AWAITING RECEIPT POS
// --------------------------------------------------

async function getAllAwaitingReceiptPOs() {
  const url =
    "https://api.tradevine.com/v1/PurchaseOrder?status=19001&pageSize=200";

  const { data } = await apiGet(url);

  return data.List || [];
}

// --------------------------------------------------
// GET PRODUCT
// --------------------------------------------------

async function getProductByCode(code) {
  const url =
    `https://api.tradevine.com/v1/Product?code=${encodeURIComponent(
      code
    )}&pageSize=10`;

  const { data } = await apiGet(url);

  const list =
    data.List || data;

  return (
    list.find(
      (p) => p.Code === code
    ) || null
  );
}

// --------------------------------------------------
// ADD INVENTORY
// --------------------------------------------------

async function addInventory(
  productCode,
  quantity,
  warehouseCode
) {
  const url =
    "https://api.tradevine.com/v1/ProductInventory/MakeAdjustment";

  const body = {
    ProductCode: productCode,
    WarehouseCode: warehouseCode,
    InventoryType: 36009,
    QuantityChange: quantity,
    ProductCostPrice: 0.0,
    Notes: "Presale automation - initial stock",
  };

  const {
    status,
    raw,
  } = await apiPost(url, body);

  log(
    status === 200
      ? "success"
      : "error",

    `Inventory +${quantity} on ${productCode}: ${
      status === 200
        ? "OK"
        : "FAILED - " +
          raw.slice(0, 200)
    }`
  );

  return status === 200;
}

// --------------------------------------------------
// PREFIX DS TITLE
// --------------------------------------------------

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
      `      Title already prefixed on ${product.Code}: "${product.Name}" — skipping`
    );

    return true;
  }

  const newName =
    withDsPrefix(product.Name);

  if (newName.length > 80) {
    const blockedKey = makeStateKey(
      "blocked",
      poNumber,
      product.Code
    );

    state[blockedKey] = {
      poNumber,
      supplier: supplierName,
      reason: "Title exceeds 80 chars",
      detectedAt:
        new Date().toISOString(),
      productCode: product.Code,
    };

    saveState(state);

    log(
      "warn",
      `${product.Code} + ${poNumber} — title exceeds 80 chars, blocked`
    );

    return false;
  }

  const url =
    `https://api.tradevine.com/v1/Product/${product.ProductID}`;

  const {
    status,
    data,
    raw,
  } = await apiPost(
    url,
    {
      ...product,
      Name: newName,
    }
  );

  log(
    status === 200
      ? "success"
      : "error",

    `Title update on ${product.Code}: ${
      status === 200
        ? `OK — "${data.Name}"`
        : "FAILED - " +
          raw.slice(0, 200)
    }`
  );

  return status === 200;
}

// --------------------------------------------------
// LINK BOM CHILDREN
// --------------------------------------------------

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

  if (newOnes.length === 0) {
    console.log(
      `      BOM link already complete for ${parent.Code}`
    );

    return true;
  }

  const merged = [
    ...existing.map((c) => ({
      BoMComponentProductID:
        c.BoMComponentProductID,

      BoMComponentQuantity:
        c.BoMComponentQuantity || 1,
    })),

    ...newOnes.map((id) => ({
      BoMComponentProductID: id,
      BoMComponentQuantity: 1,
    })),
  ];

  const url =
    `https://api.tradevine.com/v1/Product/SaveBoMComponents/${parent.ProductID}`;

  const {
    status,
    raw,
  } = await apiPost(
    url,
    merged
  );

  console.log(
    `      BOM link for ${parent.Code}: ${
      status === 200
        ? "OK"
        : "FAILED - " +
          raw.slice(0, 200)
    }`
  );

  return status === 200;
}

// --------------------------------------------------
// MAIN
// --------------------------------------------------

async function main() {
  const state = loadState();

  const allPos =
    await getAllAwaitingReceiptPOs();

  console.log(
    `Found ${allPos.length} total Awaiting Receipt PO(s) on this account.`
  );

  // --------------------------------------------------
  // PO CREATION CUTOFF
  // --------------------------------------------------

  const eligiblePos =
    allPos.filter(isPOEligible);

  console.log(
    `PO cutoff: ${AUTOMATION_PO_CUTOFF_DATE}`
  );

  console.log(
    `Eligible POs after cutoff: ${eligiblePos.length}`
  );

  // --------------------------------------------------
  // PROCESS ALL ELIGIBLE POs
  // --------------------------------------------------
  //
  // No single-PO restriction.
  // Every Awaiting Receipt PO created on or after
  // the cutoff date will be processed.
  //
  // Additional safety checks still apply:
  // - Excluded suppliers
  // - NZ MADE products
  // - Real stock > 20
  // - Failed/unknown real stock checks
  // - Missing product data
  //
  // --------------------------------------------------

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
          (p) => p.OrderNumber
        )
        .join(", ") ||
      "(none matched — check PO status/cutoff)"
    }\n`
  );

  // --------------------------------------------------
  // PROCESS POS
  // --------------------------------------------------

  for (const po of pos) {
    const poNumber =
      String(
        po.OrderNumber || ""
      )
        .trim()
        .toUpperCase();

    const supplierName =
      po.Supplier?.Name || "";

    // ------------------------------------------------
    // SUPPLIER EXCLUSION
    // ------------------------------------------------

    if (
      EXCLUDED_SUPPLIERS.some(
        (s) =>
          s.toLowerCase() ===
          supplierName.toLowerCase()
      )
    ) {
      console.log(
        `=== ${poNumber} — SKIPPED (excluded supplier: "${supplierName}") ===\n`
      );

      continue;
    }

    console.log(
      `=== ${poNumber} (Supplier: ${supplierName}) ===`
    );

    const childrenByParent = {};
    const standalone = [];

    // ------------------------------------------------
    // READ PO PRODUCTS
    // ------------------------------------------------

    for (
      const line of
        po.PurchaseOrderLines || []
    ) {
      const {
        data: product,
      } = await apiGet(
        `https://api.tradevine.com/v1/Product/${
          line.productId ||
          line.ProductID
        }`
      );

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
        standalone.push(product);
      }
    }

    // ==================================================
    // BOM PARENT GROUPS
    // ==================================================

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

      // ------------------------------------------------
      // CHILDREN
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
          continue;
        }

        // ----------------------------------------------
        // ASSIGN WAREHOUSE FIRST
        // ----------------------------------------------

        const warehouseCode =
          await getOrAssignWarehouse(
            child.Code,
            state
          );

        // ----------------------------------------------
        // REAL STOCK CHECK
        // ----------------------------------------------

        const stockAllowed =
          await canContinuePresale(
            child,
            state,
            poNumber,
            supplierName,
            warehouseCode
          );

        if (!stockAllowed) {
          continue;
        }

        // ----------------------------------------------
        // INVENTORY
        // ----------------------------------------------

        const invKey =
          makeStateKey(
            "inv",
            poNumber,
            child.Code
          );

        if (state[invKey]) {
          console.log(
            `    ${child.Code}: inventory already added for ${poNumber} — skipping`
          );

          continue;
        }

        const ok =
          await addInventory(
            child.Code,
            PRESALE_QTY,
            warehouseCode
          );

        if (ok) {
          state[invKey] = {
            done: true,
            date:
              new Date().toISOString(),
            poNumber,
            supplier:
              supplierName || null,
            productCode:
              child.Code,
            warehouseCode,
          };

          saveState(state);
        }
      }

      // ------------------------------------------------
      // GET PARENT
      // ------------------------------------------------

      const parent =
        await getProductByCode(
          parentCode
        );

      if (!parent) {
        console.log(
          `    BLOCKED: could not find parent product for code ${parentCode}`
        );

        continue;
      }

      // ------------------------------------------------
      // PARENT DATA CHECK
      // ------------------------------------------------

      if (
        blockMissingProductData(
          parent,
          state,
          poNumber,
          supplierName
        )
      ) {
        continue;
      }

      // ------------------------------------------------
      // BOM LINK
      // ------------------------------------------------

      const bomKey =
        makeStateKey(
          "bom",
          poNumber,
          parentCode
        );

      if (!state[bomKey]) {
        const ok =
          await linkChildrenToParent(
            parent,
            children.map(
              (c) => c.ProductID
            )
          );

        if (ok) {
          state[bomKey] = {
            done: true,
            date:
              new Date().toISOString(),
            poNumber,
            supplier:
              supplierName || null,
            productCode:
              parentCode,
          };

          saveState(state);
        }
      } else {
        console.log(
          `    BOM link already recorded as done for ${parentCode} on ${poNumber}`
        );
      }

      // ------------------------------------------------
      // PARENT TITLE
      // ------------------------------------------------

      const titleKey =
        makeStateKey(
          "title",
          poNumber,
          parentCode
        );

      if (!state[titleKey]) {
        const freshParent =
          await getProductByCode(
            parentCode
          );

        if (!freshParent) {
          console.log(
            `    BLOCKED: could not refresh parent ${parentCode}`
          );

          continue;
        }

        const ok =
          await prefixTitle(
            freshParent,
            state,
            poNumber,
            supplierName
          );

        if (ok) {
          state[titleKey] = {
            done: true,
            date:
              new Date().toISOString(),
            poNumber,
            supplier:
              supplierName || null,
            productCode:
              parentCode,
          };

          saveState(state);
        }
      } else {
        console.log(
          `    Title already recorded as done for ${parentCode} on ${poNumber}`
        );
      }
    }

    // ==================================================
    // STANDALONE PRODUCTS
    // ==================================================

    for (const product of standalone) {
      console.log(
        `  Standalone: ${product.Code}`
      );

      // ------------------------------------------------
      // DATA CHECK
      // ------------------------------------------------

      if (
        blockMissingProductData(
          product,
          state,
          poNumber,
          supplierName
        )
      ) {
        continue;
      }

      // ------------------------------------------------
      // ASSIGN WAREHOUSE
      // ------------------------------------------------

      const warehouseCode =
        await getOrAssignWarehouse(
          product.Code,
          state
        );

      // ------------------------------------------------
      // REAL STOCK CHECK
      // ------------------------------------------------

      const stockAllowed =
        await canContinuePresale(
          product,
          state,
          poNumber,
          supplierName,
          warehouseCode
        );

      if (!stockAllowed) {
        continue;
      }

      // ------------------------------------------------
      // INVENTORY
      // ------------------------------------------------

      const invKey =
        makeStateKey(
          "inv",
          poNumber,
          product.Code
        );

      if (!state[invKey]) {
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
            poNumber,
            supplier:
              supplierName || null,
            productCode:
              product.Code,
            warehouseCode,
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
        makeStateKey(
          "title",
          poNumber,
          product.Code
        );

      if (!state[titleKey]) {
        const ok =
          await prefixTitle(
            product,
            state,
            poNumber,
            supplierName
          );

        if (ok) {
          state[titleKey] = {
            done: true,
            date:
              new Date().toISOString(),
            poNumber,
            supplier:
              supplierName || null,
            productCode:
              product.Code,
          };

          saveState(state);
        }
      } else {
        console.log(
          `    Title already recorded as done for ${poNumber} — skipping`
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

// --------------------------------------------------
// START
// --------------------------------------------------

main().catch((err) => {
  console.error(
    "SCRIPT CRASHED:",
    err
  );
});
