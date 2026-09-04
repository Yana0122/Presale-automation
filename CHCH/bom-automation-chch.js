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
// SHARED AKL WAREHOUSE ASSIGNMENT
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

// Keep this restricted while testing.
// Remove/add PO numbers here when required.
const ALLOWED_PO_NUMBERS = ["PO1589"];

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
    console.error(`Could not read ${STATE_FILE}:`, err.message);
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function withDsPrefix(title) {
  return /^DS\s+/i.test(title) ? title : `DS ${title}`;
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

// --------------------------------------------------
// SUPPLIER CHECK
// --------------------------------------------------

function isExcludedSupplier(supplierName) {
  return EXCLUDED_SUPPLIERS.some(
    (excluded) =>
      excluded.toLowerCase() ===
      String(supplierName || "").trim().toLowerCase()
  );
}

// --------------------------------------------------
// COMPLETED INVENTORY CYCLE HELPERS
// --------------------------------------------------
//
// IMPORTANT:
//
// Inventory state is cycle-specific:
//
// inv:PO1589:PR15250
// inv:PO1595:PR15250
//
// Both records must remain.
//
// The newest completed record is considered the
// current presale cycle for that product.
// --------------------------------------------------

function getCompletedInventoryCycles(productCode, state) {
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
        supplier: entry?.supplier || "",
        entry,
      };
    })
    .filter((cycle) => cycle.entry?.done === true)
    .sort((a, b) => {
      const aTime = Date.parse(a.date || "");
      const bTime = Date.parse(b.date || "");

      return (
        (Number.isNaN(bTime) ? 0 : bTime) -
        (Number.isNaN(aTime) ? 0 : aTime)
      );
    });
}

function getCurrentCycleForProduct(productCode, state) {
  const cycles = getCompletedInventoryCycles(
    productCode,
    state
  );

  return cycles[0] || null;
}

// --------------------------------------------------
// CHECK WHETHER PRODUCT ALREADY HAS CURRENT CYCLE
// --------------------------------------------------

function hasInventoryForCycle(productCode, poNumber, state) {
  const key = `inv:${poNumber}:${productCode}`;

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
    valid: description.length > 0 && price > 0,
    hasDescription: description.length > 0,
    hasPrice: price > 0,
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
  const check = hasRequiredProductData(product);

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

  const reason = `Missing ${missing.join(" and ")}`;

  /*
   * Keep the block PO-specific so that a block from one
   * PO does not incorrectly represent another cycle.
   */
  const blockKey = `blocked:${poNumber}:${product.Code}`;

  state[blockKey] = {
    poNumber,
    supplier: supplierName,
    reason,
    detectedAt: new Date().toISOString(),
    productCode: product.Code,
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

// --------------------------------------------------
// API GET
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
// API POST
// --------------------------------------------------

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

// --------------------------------------------------
// GET ALL AWAITING RECEIPT POS
// --------------------------------------------------

async function getAllAwaitingReceiptPOs() {
  const url =
    "https://api.tradevine.com/v1/PurchaseOrder" +
    "?status=19001&pageSize=200";

  const result = await apiGet(url);

  if (result.status !== 200 || !result.data) {
    throw new Error(
      `PurchaseOrder lookup failed — HTTP ${result.status}: ${
        result.raw || ""
      }`
    );
  }

  return (
    result.data.List ||
    result.data.list ||
    []
  );
}

// --------------------------------------------------
// GET PRODUCT BY CODE
// --------------------------------------------------

async function getProductByCode(code) {
  const url =
    `https://api.tradevine.com/v1/Product` +
    `?code=${encodeURIComponent(code)}` +
    `&pageSize=10`;

  const result = await apiGet(url);

  if (
    result.status !== 200 ||
    !result.data
  ) {
    console.log(
      `${code}: Product lookup failed — HTTP ${result.status}`
    );

    return null;
  }

  const list =
    result.data.List ||
    result.data.list ||
    result.data;

  if (!Array.isArray(list)) {
    return null;
  }

  return (
    list.find(
      (product) =>
        String(product.Code).toUpperCase() ===
        String(code).toUpperCase()
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
    Notes:
      "Presale automation - initial stock",
  };

  const result = await apiPost(url, body);

  log(
    result.status === 200
      ? "success"
      : "error",
    `Inventory +${quantity} on ${productCode}: ${
      result.status === 200
        ? "OK"
        : "FAILED - " +
          (result.raw || "").slice(0, 200)
    }`
  );

  return result.status === 200;
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
  if (!product) {
    return false;
  }

  const currentName = String(
    product.Name || ""
  );

  if (/^DS\s+/i.test(currentName)) {
    console.log(
      `      Title already prefixed on ${product.Code}: "${currentName}" — skipping`
    );

    return true;
  }

  const newName = withDsPrefix(
    currentName
  );

  if (newName.length > 80) {
    const blockKey =
      `blocked:${poNumber}:${product.Code}`;

    state[blockKey] = {
      poNumber,
      supplier: supplierName,
      reason: "Title exceeds 80 chars",
      detectedAt: new Date().toISOString(),
      productCode: product.Code,
    };

    saveState(state);

    log(
      "warn",
      `${product.Code} — title exceeds 80 chars, blocked for ${poNumber}`
    );

    return false;
  }

  const url =
    `https://api.tradevine.com/v1/Product/${product.ProductID}`;

  const result = await apiPost(
    url,
    {
      ...product,
      Name: newName,
    }
  );

  log(
    result.status === 200
      ? "success"
      : "error",
    `Title update on ${product.Code}: ${
      result.status === 200
        ? `OK — "${result.data?.Name || newName}"`
        : "FAILED - " +
          (result.raw || "").slice(0, 200)
    }`
  );

  return result.status === 200;
}

// --------------------------------------------------
// LINK BOM CHILDREN
// --------------------------------------------------
//
// IMPORTANT:
// Keep using parent.BoMComponents.
// This is the working CHCH/WLG-compatible
// Tradevine BOM structure.
// --------------------------------------------------

async function linkChildrenToParent(
  parent,
  childProductIds
) {
  const existing =
    (parent.BoMComponents || []).filter(
      (component) =>
        component.BoMComponentProductID
    );

  const existingIds = new Set(
    existing.map((component) =>
      String(
        component.BoMComponentProductID
      )
    )
  );

  const newOnes =
    childProductIds.filter(
      (id) =>
        !existingIds.has(String(id))
    );

  if (newOnes.length === 0) {
    console.log(
      `      BOM link already complete for ${parent.Code}`
    );

    return true;
  }

  const merged = [
    ...existing.map((component) => ({
      BoMComponentProductID:
        component.BoMComponentProductID,

      BoMComponentQuantity:
        component.BoMComponentQuantity || 1,
    })),

    ...newOnes.map((id) => ({
      BoMComponentProductID: id,
      BoMComponentQuantity: 1,
    })),
  ];

  const url =
    `https://api.tradevine.com/v1/Product/SaveBoMComponents/${parent.ProductID}`;

  const result = await apiPost(
    url,
    merged
  );

  console.log(
    `      BOM link for ${parent.Code}: ${
      result.status === 200
        ? "OK"
        : "FAILED - " +
          (result.raw || "").slice(0, 200)
    }`
  );

  if (result.status !== 200) {
    log(
      "error",
      `${parent.Code}: BOM link failed — ${
        result.raw || ""
      }`.slice(0, 500)
    );

    return false;
  }

  return true;
}

// --------------------------------------------------
// PROCESS BOM PARENT
// --------------------------------------------------

async function processBomParent(
  parentCode,
  children,
  po,
  state
) {
  console.log("");
  console.log(
    `  Processing BOM parent: ${parentCode}`
  );

  const poNumber = po.OrderNumber;
  const supplierName =
    po.Supplier?.Name || "";

  // ------------------------------------------------
  // GET PARENT
  // ------------------------------------------------

  const parent =
    await getProductByCode(parentCode);

  if (!parent) {
    console.log(
      `    BLOCKED: could not find parent product for code ${parentCode}`
    );

    return;
  }

  if (
    isExcludedByTitle(parent.Name)
  ) {
    console.log(
      `    ${parentCode}: title contains "NZ MADE" — excluded, skipping`
    );

    return;
  }

  // ------------------------------------------------
  // CURRENT CYCLE
  // ------------------------------------------------
  //
  // Children are the source of BOM inventory-cycle
  // identity.
  //
  // All children for a BOM must belong to the same
  // PO cycle.
  // ------------------------------------------------

  const childCycles = [];

  for (const child of children) {
    const cycle =
      getCurrentCycleForProduct(
        child.Code,
        state
      );

    if (cycle) {
      childCycles.push({
        childCode: child.Code,
        cycle,
      });
    }
  }

  const cyclePoNumbers = [
    ...new Set(
      childCycles.map(
        (item) =>
          String(
            item.cycle.poNumber
          ).toUpperCase()
      )
    ),
  ];

  if (
    cyclePoNumbers.length > 0 &&
    cyclePoNumbers.length !== 1
  ) {
    console.log(
      `    ${parentCode}: BOM children are on different PO cycles — skipping`
    );

    for (const item of childCycles) {
      console.log(
        `      ${item.childCode}: ${item.cycle.poNumber}`
      );
    }

    log(
      "warn",
      `${parentCode}: BOM children are on different PO cycles`
    );

    return;
  }

  /*
   * The PO being processed is the authoritative cycle
   * for this run.
   *
   * If a previous cycle exists in state, that is history
   * and does not prevent this PO from being processed.
   */

  console.log(
    `    Current CHCH BOM cycle: ${poNumber}`
  );

  log(
    "info",
    `${parentCode}: current BOM cycle = ${poNumber}`
  );

  // ------------------------------------------------
  // CHILD INVENTORY
  // ------------------------------------------------

  for (const child of children) {
    console.log(
      `    Child: ${child.Code}`
    );

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

    const invKey =
      `inv:${poNumber}:${child.Code}`;

    /*
     * Cycle-specific inventory check.
     *
     * PO1589 and PO1595 are independent cycles.
     */

    if (
      hasInventoryForCycle(
        child.Code,
        poNumber,
        state
      )
    ) {
      console.log(
        `      ${child.Code}: inventory already added for ${poNumber} — skipping`
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

    if (ok) {
      state[invKey] = {
        done: true,
        date:
          new Date().toISOString(),
        supplier:
          supplierName || null,
      };

      saveState(state);

      console.log(
        `      ${child.Code}: inventory recorded for ${poNumber} ✓`
      );
    }
  }

  // ------------------------------------------------
  // PARENT REQUIRED DATA
  // ------------------------------------------------

  if (
    blockMissingProductData(
      parent,
      state,
      poNumber,
      supplierName
    )
  ) {
    return;
  }

  // ------------------------------------------------
  // BOM LINK
  // ------------------------------------------------
  //
  // The BOM relationship itself is product-level.
  // It does not need a separate BOM relationship for
  // every PO cycle.
  //
  // However, the state record is updated with the PO
  // that confirmed/processed this cycle.
  // ------------------------------------------------

  const bomKey =
    `bom:${parentCode}`;

  const existingBomState =
    state[bomKey];

  if (
    existingBomState?.done === true &&
    String(
      existingBomState.poNumber || ""
    ).toUpperCase() ===
      String(poNumber).toUpperCase()
  ) {
    console.log(
      `    BOM already recorded as done for ${parentCode} on ${poNumber}`
    );
  } else {
    const freshParent =
      await getProductByCode(
        parentCode
      );

    if (!freshParent) {
      console.log(
        `    ${parentCode}: parent disappeared before BOM link — stopping`
      );

      return;
    }

    const ok =
      await linkChildrenToParent(
        freshParent,
        children.map(
          (child) =>
            child.ProductID
        )
      );

    if (!ok) {
      console.log(
        `    ${parentCode}: BOM linking failed — stopping`
      );

      return;
    }

    state[bomKey] = {
      done: true,
      date:
        new Date().toISOString(),
      supplier:
        supplierName || null,
      poNumber,
    };

    saveState(state);

    console.log(
      `    ${parentCode}: BOM state recorded for ${poNumber} ✓`
    );
  }

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
      String(poNumber).toUpperCase()
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

// --------------------------------------------------
// PROCESS STANDALONE PRODUCT
// --------------------------------------------------

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
      String(poNumber).toUpperCase()
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

// --------------------------------------------------
// MAIN
// --------------------------------------------------

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
    " + CYCLE 1 / CYCLE 2 SUPPORT"
  );
  console.log(
    "=============================================="
  );
  console.log("");

  const state =
    loadState();

  const allPos =
    await getAllAwaitingReceiptPOs();

  const pos =
    allPos.filter(
      (po) =>
        ALLOWED_PO_NUMBERS.includes(
          po.OrderNumber
        )
    );

  console.log(
    `Found ${allPos.length} total Awaiting Receipt PO(s) on this account.`
  );

  console.log(
    `Restricted to: ${ALLOWED_PO_NUMBERS.join(
      ", "
    )}`
  );

  console.log(
    `Will process: ${
      pos
        .map(
          (p) =>
            p.OrderNumber
        )
        .join(", ") ||
      "(none matched — check PO number/status)"
    }\n`
  );

  // ------------------------------------------------
  // PROCESS POS
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

    const standalone = [];

    // ------------------------------------------------
    // READ PO PRODUCTS
    // ------------------------------------------------

    for (const line of po.PurchaseOrderLines || []) {
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

    for (const parentCode of Object.keys(
      childrenByParent
    )) {
      try {
        console.log(
          `  Parent group: ${parentCode}`
        );

        const children =
          childrenByParent[
            parentCode
          ];

        /*
         * IMPORTANT:
         * Do not process a BOM parent if there are
         * no actual children.
         */

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

    for (const product of standalone) {
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

// --------------------------------------------------
// RUN
// --------------------------------------------------

main().catch((err) => {
  console.error(
    "SCRIPT CRASHED:",
    err.message
  );

  console.error(err);

  process.exit(1);
});

