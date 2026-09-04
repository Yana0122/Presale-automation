require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const OAuth = require("oauth-1.0a");
const crypto = require("crypto");
const JSONbig = require("json-bigint")({
  storeAsString: true,
});

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

  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error(`Could not write log: ${err.message}`);
  }
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

// ==================================================
// FILES
// ==================================================

const STATE_FILE = path.join(
  __dirname,
  "../json/WLG/processed-state-wlg.json"
);

const WATCHER_STATE_FILE = path.join(
  __dirname,
  "../json/WLG/auto-remove-state-wlg.json"
);

// ==================================================
// SETTINGS
// ==================================================

const TV_API = "https://api.tradevine.com";

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
// LOAD PROCESSED STATE
// ==================================================

function loadProcessedState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (err) {
    console.error(
      `Could not read ${STATE_FILE}: ${err.message}`
    );

    return {};
  }
}

// ==================================================
// LOAD WATCHER BASELINE
// ==================================================

function loadWatcherState() {
  if (!fs.existsSync(WATCHER_STATE_FILE)) {
    return {};
  }

  try {
    const data = JSON.parse(
      fs.readFileSync(WATCHER_STATE_FILE, "utf8")
    );

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      console.log(
        `${WATCHER_STATE_FILE}: invalid format — starting empty`
      );

      return {};
    }

    return data;
  } catch (err) {
    console.error(
      `Could not read ${WATCHER_STATE_FILE}: ${err.message}`
    );

    return {};
  }
}

// ==================================================
// SAVE WATCHER BASELINE
// ==================================================

function saveWatcherState(state) {
  const directory = path.dirname(WATCHER_STATE_FILE);

  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, {
      recursive: true,
    });
  }

  fs.writeFileSync(
    WATCHER_STATE_FILE,
    JSON.stringify(state, null, 2)
  );
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
// GET PRODUCT BY CODE
// ==================================================

async function getProductByCode(code) {
  const url =
    `${TV_API}/v1/Product` +
    `?code=${encodeURIComponent(code)}` +
    `&pageSize=10`;

  const result = await apiGet(url);

  if (result.status !== 200 || !result.data) {
    console.log(
      `${code}: Tradevine Product lookup failed — HTTP ${result.status}`
    );

    console.log((result.raw || "").slice(0, 500));

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
// REAL WAREHOUSE SNAPSHOT
// ==================================================

function getRealWarehouseSnapshot(product) {
  const snapshot = {};

  const warehouses =
    product?.PerWarehouseInventory || [];

  for (const warehouse of warehouses) {
    const warehouseCode = String(
      warehouse.WarehouseCode || ""
    ).trim();

    if (
      !warehouseCode ||
      !REAL_WAREHOUSE_PATTERN.test(warehouseCode)
    ) {
      continue;
    }

    const quantity = Number(
      warehouse.QuantityInStockSnapshot
    );

    snapshot[warehouseCode] = Number.isFinite(quantity)
      ? quantity
      : 0;
  }

  return snapshot;
}

// ==================================================
// TOTAL REAL STOCK
// ==================================================

function getTotalRealStock(snapshot) {
  return Object.values(snapshot).reduce(
    (total, qty) => total + Number(qty || 0),
    0
  );
}

// ==================================================
// STOCK CHANGE CHECK
// ==================================================
//
// Trigger rules:
//
// 1. New real warehouse with stock > 0
// 2. Existing real warehouse quantity increases
//
// Do NOT trigger for:
//
// - unchanged stock
// - stock decrease
// - stock disappearing
//
// ==================================================

function detectPositiveStockChange(
  previousSnapshot,
  currentSnapshot
) {
  const previous = previousSnapshot || {};
  const current = currentSnapshot || {};

  const warehouses = new Set([
    ...Object.keys(previous),
    ...Object.keys(current),
  ]);

  const increases = [];

  for (const warehouseCode of warehouses) {
    const oldQty = Number(
      previous[warehouseCode] || 0
    );

    const newQty = Number(
      current[warehouseCode] || 0
    );

    if (newQty > oldQty) {
      increases.push({
        warehouseCode,
        oldQty,
        newQty,
      });
    }
  }

  return increases;
}

// ==================================================
// EXCLUDED SUPPLIER CHECK
// ==================================================

function isExcludedSupplier(code, state) {
  const targetCode = String(code)
    .trim()
    .toUpperCase();

  const invKeys = Object.keys(state).filter(
    (key) => {
      if (!key.startsWith("inv:")) {
        return false;
      }

      const parts = key.split(":");

      if (parts.length !== 3) {
        return false;
      }

      return (
        String(parts[2])
          .trim()
          .toUpperCase() === targetCode
      );
    }
  );

  return invKeys.some((key) => {
    const supplier = state[key]?.supplier;

    return (
      supplier &&
      EXCLUDED_SUPPLIERS.some(
        (excluded) =>
          String(excluded).toLowerCase() ===
          String(supplier).toLowerCase()
      )
    );
  });
}

// ==================================================
// GET COMPLETED CYCLES FOR PRODUCT
// ==================================================

function getCompletedCyclesForProduct(
  productCode,
  state
) {
  const cycles = [];

  const targetCode = String(productCode)
    .trim()
    .toUpperCase();

  for (const [key, value] of Object.entries(state)) {
    if (!key.startsWith("inv:")) {
      continue;
    }

    const parts = key.split(":");

    // Expected:
    // inv:PO1560:PR13374

    if (parts.length !== 3) {
      continue;
    }

    const poNumber = parts[1];
    const code = parts[2];

    if (
      String(code)
        .trim()
        .toUpperCase() !== targetCode
    ) {
      continue;
    }

    if (value?.done !== true) {
      continue;
    }

    const date =
      value?.date ||
      value?.processedDate ||
      null;

    cycles.push({
      productCode: code,
      poNumber,
      date,
      supplier: value?.supplier || "",
      stateKey: key,
    });
  }

  // Newest completed cycle first

  cycles.sort((a, b) => {
    const aTime = Date.parse(a.date || "");
    const bTime = Date.parse(b.date || "");

    return (
      (Number.isNaN(bTime) ? 0 : bTime) -
      (Number.isNaN(aTime) ? 0 : aTime)
    );
  });

  return cycles;
}

// ==================================================
// GET CURRENT CYCLE
// ==================================================

function getCurrentCycleForProduct(
  productCode,
  state
) {
  const cycles =
    getCompletedCyclesForProduct(
      productCode,
      state
    );

  return cycles.length > 0
    ? cycles[0]
    : null;
}

// ==================================================
// BUILD CYCLE KEY
// ==================================================

function cycleKey(productCode, poNumber) {
  return (
    `${String(productCode).trim().toUpperCase()}` +
    `::` +
    `${String(poNumber).trim().toUpperCase()}`
  );
}

// ==================================================
// CHECK STANDALONE PRODUCT CYCLE
// ==================================================

function getStandaloneCycle(code, state) {
  return getCurrentCycleForProduct(
    code,
    state
  );
}

// ==================================================
// CHECK BOM CHILD CYCLES
// ==================================================
//
// All BOM children must belong to the
// same current PO.
//
// This matches remove-presale-wlg.js.
//

function getBomCycle(parentCode, components, state) {
  const childCycles = [];

  for (const component of components) {
    const childCode =
      component.BoMComponentProductCode;

    if (!childCode) {
      continue;
    }

    const childCycle =
      getCurrentCycleForProduct(
        childCode,
        state
      );

    if (!childCycle) {
      return null;
    }

    childCycles.push({
      childCode,
      cycle: childCycle,
    });
  }

  if (childCycles.length === 0) {
    return null;
  }

  const childPOs = [
    ...new Set(
      childCycles.map((item) =>
        String(item.cycle.poNumber)
      )
    ),
  ];

  if (childPOs.length !== 1) {
    console.log(
      `${parentCode}: BLOCKED — BOM children belong to different PO cycles: ${childPOs.join(
        ", "
      )}`
    );

    log(
      "warn",
      `${parentCode}: BOM children have mixed PO cycles`
    );

    return null;
  }

  return {
    poNumber: childPOs[0],
    children: childCycles,
  };
}

// ==================================================
// CHECK STANDALONE PRODUCT
// ==================================================

async function checkStandaloneProduct(
  code,
  state,
  watcherState
) {
  console.log("");
  console.log(
    "=============================================="
  );
  console.log(
    `CHECKING WLG STANDALONE: ${code}`
  );
  console.log(
    "=============================================="
  );

  // Supplier protection

  if (isExcludedSupplier(code, state)) {
    console.log(
      `${code}: excluded supplier (Parmco Ltd) — skipping`
    );

    return false;
  }

  // Current PO cycle

  const currentCycle =
    getStandaloneCycle(code, state);

  if (!currentCycle) {
    console.log(
      `${code}: no completed inventory cycle — skipping`
    );

    return false;
  }

  const currentPO =
    currentCycle.poNumber;

  console.log(
    `${code}: current presale cycle = ${currentPO}`
  );

  const key = cycleKey(code, currentPO);

  // Product lookup

  const product =
    await getProductByCode(code);

  if (!product) {
    return false;
  }

  // NZ MADE protection

  if (isExcludedByTitle(product.Name)) {
    console.log(
      `${code}: title contains "NZ MADE" — excluded`
    );

    return false;
  }

  // Current real warehouse stock

  const currentSnapshot =
    getRealWarehouseSnapshot(product);

  console.log(
    `${code}: real warehouse stock = ${JSON.stringify(
      currentSnapshot
    )}`
  );

  const previousSnapshot =
    watcherState[key]?.snapshot || {};

  // Detect positive change

  const increases =
    detectPositiveStockChange(
      previousSnapshot,
      currentSnapshot
    );

  // First time seeing this cycle:
  //
  // Save baseline only.
  //
  // This prevents an existing stock quantity from
  // immediately triggering removal when the watcher
  // is first deployed.

  if (!watcherState[key]) {
    watcherState[key] = {
      type: "standalone",
      productCode: code,
      poNumber: currentPO,
      snapshot: currentSnapshot,
      lastChecked: new Date().toISOString(),
    };

    console.log(
      `${code} / ${currentPO}: first observation — baseline saved`
    );

    log(
      "info",
      `${code} / ${currentPO}: watcher baseline created`
    );

    return false;
  }

  // Update baseline every run

  watcherState[key].snapshot =
    currentSnapshot;

  watcherState[key].lastChecked =
    new Date().toISOString();

  if (increases.length === 0) {
    console.log(
      `${code} / ${currentPO}: no positive real-stock change`
    );

    return false;
  }

  // Positive stock change detected

  console.log("");
  console.log(
    `✓ ${code} / ${currentPO}: POSITIVE REAL STOCK CHANGE DETECTED`
  );

  for (const change of increases) {
    console.log(
      `  ${change.warehouseCode}: ${change.oldQty} -> ${change.newQty}`
    );
  }

  log(
    "success",
    `${code} / ${currentPO}: real warehouse stock increased`
  );

  return true;
}

// ==================================================
// CHECK BOM PARENT
// ==================================================

async function checkBomParent(
  parentCode,
  state,
  watcherState
) {
  console.log("");
  console.log(
    "=============================================="
  );
  console.log(
    `CHECKING WLG BOM PARENT: ${parentCode}`
  );
  console.log(
    "=============================================="
  );

  // Parent lookup

  const parent =
    await getProductByCode(parentCode);

  if (!parent) {
    return false;
  }

  // NZ MADE protection

  if (isExcludedByTitle(parent.Name)) {
    console.log(
      `${parentCode}: title contains "NZ MADE" — excluded`
    );

    return false;
  }

  // Keep the exact working BOM field

  const components =
    (parent.BoMComponents || []).filter(
      (component) =>
        component.BoMComponentProductCode
    );

  if (components.length === 0) {
    console.log(
      `${parentCode}: no BOM components found — skipping`
    );

    log(
      "warn",
      `${parentCode}: BOM has no components`
    );

    return false;
  }

  console.log(
    `${parentCode}: checking ${components.length} BOM child component(s)`
  );

  // Determine current BOM cycle

  const bomCycle =
    getBomCycle(
      parentCode,
      components,
      state
    );

  if (!bomCycle) {
    return false;
  }

  const currentPO =
    bomCycle.poNumber;

  console.log(
    `${parentCode}: current BOM presale cycle = ${currentPO}`
  );

  const key =
    cycleKey(
      parentCode,
      currentPO
    );

  // --------------------------------------------------
  // Build current child snapshots
  // --------------------------------------------------

  const currentChildren = {};

  for (const item of bomCycle.children) {
    const childCode =
      item.childCode;

    // Supplier protection

    if (
      isExcludedSupplier(
        childCode,
        state
      )
    ) {
      console.log(
        `${childCode}: excluded supplier (Parmco Ltd) — skipping BOM trigger`
      );

      return false;
    }

    const child =
      await getProductByCode(
        childCode
      );

    if (!child) {
      console.log(
        `${childCode}: child not found`
      );

      return false;
    }

    // NZ MADE protection

    if (
      isExcludedByTitle(
        child.Name
      )
    ) {
      console.log(
        `${childCode}: NZ MADE — not eligible`
      );

      return false;
    }

    const snapshot =
      getRealWarehouseSnapshot(
        child
      );

    currentChildren[childCode] =
      snapshot;

    console.log(
      `${childCode}: real warehouse stock = ${JSON.stringify(
        snapshot
      )}`
    );
  }

  // --------------------------------------------------
  // First observation
  // --------------------------------------------------

  if (!watcherState[key]) {
    watcherState[key] = {
      type: "bom",
      productCode: parentCode,
      poNumber: currentPO,
      children: currentChildren,
      lastChecked: new Date().toISOString(),
    };

    console.log(
      `${parentCode} / ${currentPO}: first observation — BOM baseline saved`
    );

    log(
      "info",
      `${parentCode} / ${currentPO}: BOM watcher baseline created`
    );

    return false;
  }

  // --------------------------------------------------
  // Compare every child
  // --------------------------------------------------

  let stockIncreaseDetected = false;

  const previousChildren =
    watcherState[key].children || {};

  for (const item of bomCycle.children) {
    const childCode =
      item.childCode;

    const previousSnapshot =
      previousChildren[childCode] || {};

    const currentSnapshot =
      currentChildren[childCode] || {};

    const increases =
      detectPositiveStockChange(
        previousSnapshot,
        currentSnapshot
      );

    if (increases.length > 0) {
      stockIncreaseDetected = true;

      console.log("");
      console.log(
        `✓ ${parentCode}: BOM child ${childCode} stock increased`
      );

      for (const change of increases) {
        console.log(
          `  ${change.warehouseCode}: ${change.oldQty} -> ${change.newQty}`
        );
      }
    }
  }

  // --------------------------------------------------
  // Update BOM baseline
  // --------------------------------------------------

  watcherState[key].children =
    currentChildren;

  watcherState[key].lastChecked =
    new Date().toISOString();

  if (!stockIncreaseDetected) {
    console.log(
      `${parentCode} / ${currentPO}: no BOM child stock increase`
    );

    return false;
  }

  // --------------------------------------------------
  // Trigger
  // --------------------------------------------------

  console.log("");
  console.log(
    `✓ ${parentCode} / ${currentPO}: BOM REAL STOCK CHANGE DETECTED`
  );

  log(
    "success",
    `${parentCode} / ${currentPO}: BOM child real stock increased`
  );

  return true;
}

// ==================================================
// RUN WLG REMOVE-PRESALE SCRIPT
// ==================================================
//
// We deliberately run the existing working
// remove-presale-wlg.js instead of duplicating
// its graduation logic here.
//
// remove-presale-wlg.js will:
//   - verify current cycle
//   - verify BOM children
//   - clear pre-order stock
//   - remove DS title
//   - clean Tradevine ShopifyProduct
//   - remove WLG Shopify tag
//   - remove WLG arriving-date metafield
//   - verify Shopify cleanup
//   - record graduation
//   - remove temporary state
//
// ==================================================

function runRemovePresale() {
  return new Promise((resolve) => {
    const scriptPath =
      path.join(
        __dirname,
        "remove-presale-wlg.js"
      );

    console.log("");
    console.log(
      "=============================================="
    );
    console.log(
      " STARTING WLG REMOVE-PRESALE"
    );
    console.log(
      "=============================================="
    );
    console.log(
      `Script: ${scriptPath}`
    );

    log(
      "info",
      "WLG automatic stock trigger detected — starting remove-presale-wlg.js"
    );

    const child =
      spawn(
        process.execPath,
        [scriptPath],
        {
          cwd: path.resolve(__dirname, ".."),
          env: process.env,
          stdio: "inherit",
        }
      );

    child.on(
      "error",
      (err) => {
        console.error(
          `Failed to start remove-presale-wlg.js: ${err.message}`
        );

        log(
          "error",
          `Failed to start remove-presale-wlg.js: ${err.message}`
        );

        resolve(false);
      }
    );

    child.on(
      "close",
      (code) => {
        if (code === 0) {
          console.log("");
          console.log(
            "✓ WLG remove-presale.js completed successfully"
          );

          log(
            "success",
            "WLG remove-presale-wlg.js completed successfully"
          );

          resolve(true);
          return;
        }

        console.error(
          `WLG remove-presale-wlg.js exited with code ${code}`
        );

        log(
          "error",
          `WLG remove-presale-wlg.js exited with code ${code}`
        );

        resolve(false);
      }
    );
  });
}

// ==================================================
// MAIN
// ==================================================

async function main() {
  console.log("");
  console.log(
    "======================================================"
  );
  console.log(
    " WLG AUTOMATIC PRESALE REMOVAL WATCHER"
  );
  console.log(
    "======================================================"
  );
  console.log("");

  console.log(
    "Purpose:"
  );

  console.log(
    "Watch WLG real warehouse inventory and automatically"
  );

  console.log(
    "start remove-presale-wlg.js when stock increases."
  );

  console.log("");

  console.log(
    `Processed state: ${STATE_FILE}`
  );

  console.log(
    `Watcher state:   ${WATCHER_STATE_FILE}`
  );

  console.log("");

  // --------------------------------------------------
  // Load state
  // --------------------------------------------------

  const state =
    loadProcessedState();

  const watcherState =
    loadWatcherState();

  // --------------------------------------------------
  // Find standalone products
  // --------------------------------------------------

  const standaloneCodes =
    Object.keys(state)
      .filter(
        (key) =>
          key.startsWith("title:")
      )
      .map(
        (key) =>
          key.replace("title:", "")
      )
      .filter(
        (code) =>
          !state[`bom:${code}`]
      );

  console.log(
    `Found ${standaloneCodes.length} standalone WLG product(s): ${
      standaloneCodes.join(", ") ||
      "none"
    }`
  );

  // --------------------------------------------------
  // Find BOM parents
  // --------------------------------------------------

  const bomParentCodes =
    Object.keys(state)
      .filter(
        (key) =>
          key.startsWith("bom:")
      )
      .map(
        (key) =>
          key.replace("bom:", "")
      );

  console.log(
    `Found ${bomParentCodes.length} WLG BOM parent(s): ${
      bomParentCodes.join(", ") ||
      "none"
    }`
  );

  console.log("");

  // --------------------------------------------------
  // CHECK STANDALONE
  // --------------------------------------------------

  let removalTriggered = false;

  for (const code of standaloneCodes) {
    try {
      const triggered =
        await checkStandaloneProduct(
          code,
          state,
          watcherState
        );

      if (triggered) {
        removalTriggered = true;
      }
    } catch (err) {
      console.error(
        `${code}: watcher ERROR — ${err.message}`
      );

      log(
        "error",
        `${code}: watcher ERROR — ${err.message}`
      );
    }
  }

  // --------------------------------------------------
  // CHECK BOM PARENTS
  // --------------------------------------------------

  for (const parentCode of bomParentCodes) {
    try {
      const triggered =
        await checkBomParent(
          parentCode,
          state,
          watcherState
        );

      if (triggered) {
        removalTriggered = true;
      }
    } catch (err) {
      console.error(
        `${parentCode}: watcher ERROR — ${err.message}`
      );

      log(
        "error",
        `${parentCode}: watcher ERROR — ${err.message}`
      );
    }
  }

  // --------------------------------------------------
  // SAVE BASELINES
  // --------------------------------------------------

  saveWatcherState(
    watcherState
  );

  console.log("");

  // --------------------------------------------------
  // RUN CLEANUP
  // --------------------------------------------------

  if (removalTriggered) {
    console.log(
      "✓ At least one qualifying WLG stock increase detected."
    );

    console.log(
      "Starting WLG remove-presale process..."
    );

    await runRemovePresale();
  } else {
    console.log(
      "No qualifying WLG stock increase detected."
    );

    console.log(
      "No presale removal required."
    );
  }

  // --------------------------------------------------
  // COMPLETE
  // --------------------------------------------------

  console.log("");
  console.log(
    "======================================================"
  );
  console.log(
    " WLG AUTOMATIC PRESALE WATCHER COMPLETE"
  );
  console.log(
    "======================================================"
  );
  console.log("");
}

// ==================================================
// RUN
// ==================================================

main().catch((err) => {
  console.error(
    "WLG AUTOMATIC WATCHER CRASHED:",
    err.message
  );

  console.error(err);

  log(
    "error",
    `WLG automatic watcher crashed: ${err.message}`
  );

  process.exit(1);
});

