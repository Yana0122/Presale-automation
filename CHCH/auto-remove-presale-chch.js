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

  fs.appendFileSync(
    LOG_FILE,
    JSON.stringify(entry) + "\n"
  );
}

// ==================================================
// TRADEVINE OAUTH - CHCH
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
// FILES
// ==================================================

const STATE_FILE = path.join(
  __dirname,
  "../json/CHCH/processed-state-chch.json"
);

const WATCHER_STATE_FILE = path.join(
  __dirname,
  "../json/CHCH/auto-remove-state-chch.json"
);

// ==================================================
// SETTINGS
// ==================================================

const TV_API = "https://api.tradevine.com";

// ==================================================
// REAL WAREHOUSE PATTERN
// ==================================================

const REAL_WAREHOUSE_PATTERN =
  /^\d{1,2}-\d{1,2}-[A-Za-z]-\d{1,2}$/;

// ==================================================
// EXCLUDED SUPPLIERS
// ==================================================

const EXCLUDED_SUPPLIERS = [
  "Parmco Ltd",
];

// ==================================================
// EXCLUDED TITLE
// ==================================================

function isExcludedByTitle(name) {
  return (name || "")
    .toUpperCase()
    .includes("NZ MADE");
}

// ==================================================
// LOAD PROCESSED STATE
// ==================================================

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {};
  }

  try {
    return JSON.parse(
      fs.readFileSync(
        STATE_FILE,
        "utf8"
      )
    );
  } catch (err) {
    console.error(
      `Could not read ${STATE_FILE}:`,
      err.message
    );

    return {};
  }
}

// ==================================================
// LOAD WATCHER STATE
// ==================================================

function loadWatcherState() {
  if (!fs.existsSync(WATCHER_STATE_FILE)) {
    return {};
  }

  try {
    const data = JSON.parse(
      fs.readFileSync(
        WATCHER_STATE_FILE,
        "utf8"
      )
    );

    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data)
    ) {
      console.log(
        `WARNING: ${WATCHER_STATE_FILE} is not a valid object. Starting fresh.`
      );

      return {};
    }

    return data;
  } catch (err) {
    console.error(
      `Could not read ${WATCHER_STATE_FILE}:`,
      err.message
    );

    return {};
  }
}

// ==================================================
// SAVE WATCHER STATE
// ==================================================

function saveWatcherState(state) {
  const directory =
    path.dirname(WATCHER_STATE_FILE);

  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, {
      recursive: true,
    });
  }

  fs.writeFileSync(
    WATCHER_STATE_FILE,
    JSON.stringify(
      state,
      null,
      2
    ),
    "utf8"
  );
}

// ==================================================
// TRADEVINE GET - CHCH
// ==================================================

async function apiGet(url) {
  const authHeader =
    oauth.toHeader(
      oauth.authorize(
        {
          url,
          method: "GET",
        },
        token
      )
    );

  const res = await fetch(
    url,
    {
      method: "GET",

      headers: {
        ...authHeader,
        Accept: "application/json",
        "User-Agent":
          "TSB-Living-CHCH-Auto-Remove",
      },
    }
  );

  const text =
    await res.text();

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

  const result =
    await apiGet(url);

  if (
    result.status !== 200 ||
    !result.data
  ) {
    console.log(
      `${code}: Tradevine Product lookup failed — HTTP ${result.status}`
    );

    console.log(
      (
        result.raw || ""
      ).slice(0, 500)
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

  const product =
    list.find(
      (item) =>
        String(
          item.Code || ""
        ).toUpperCase() ===
        String(
          code
        ).toUpperCase()
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
// GET REAL WAREHOUSE STOCK SNAPSHOT
// ==================================================
//
// Only warehouses matching the real warehouse
// pattern are included.
//
// Example:
// 12-34-A-1
//
// Pre-order warehouses are ignored.
//

function getRealWarehouseSnapshot(product) {
  const snapshot = {};

  const inventory =
    product?.PerWarehouseInventory || [];

  for (
    const warehouse of inventory
  ) {
    const warehouseCode =
      String(
        warehouse.WarehouseCode || ""
      ).trim();

    if (
      !REAL_WAREHOUSE_PATTERN.test(
        warehouseCode
      )
    ) {
      continue;
    }

    const quantity =
      Number(
        warehouse.QuantityInStockSnapshot
      );

    snapshot[warehouseCode] =
      Number.isFinite(quantity)
        ? quantity
        : 0;
  }

  return snapshot;
}

// ==================================================
// DETECT POSITIVE STOCK CHANGE
// ==================================================
//
// Trigger only when:
//
// 1. A real warehouse appears with stock > 0
// 2. Existing real warehouse quantity increases
//
// Do NOT trigger on:
//
// - unchanged stock
// - stock decrease
// - warehouse disappearing
//

function detectPositiveStockChange(
  previous,
  current
) {
  const previousSnapshot =
    previous || {};

  const currentSnapshot =
    current || {};

  const warehouseCodes = [
    ...new Set([
      ...Object.keys(
        previousSnapshot
      ),
      ...Object.keys(
        currentSnapshot
      ),
    ]),
  ];

  const increases = [];

  for (
    const warehouseCode of
      warehouseCodes
  ) {
    const previousQty =
      Number(
        previousSnapshot[
          warehouseCode
        ] || 0
      );

    const currentQty =
      Number(
        currentSnapshot[
          warehouseCode
        ] || 0
      );

    if (
      currentQty >
      previousQty
    ) {
      increases.push({
        warehouseCode,
        previousQty,
        currentQty,
      });
    }
  }

  return increases;
}

// ==================================================
// GET COMPLETED INVENTORY CYCLES
// ==================================================

function getCompletedInventoryCycles(
  productCode,
  state
) {
  const wantedCode =
    String(
      productCode || ""
    )
      .trim()
      .toUpperCase();

  const cycles = [];

  for (
    const [
      key,
      value,
    ] of Object.entries(state)
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
      code !==
      wantedCode
    ) {
      continue;
    }

    cycles.push({
      productCode:
        wantedCode,

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
// GET CURRENT CYCLE
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

      return (
        dateB -
        dateA
      );
    }
  );

  return cycles[0];
}

// ==================================================
// GET CURRENT BOM CYCLE
// ==================================================
//
// The parent inventory is NOT used.
//
// Every BOM child must have a current completed
// inventory cycle.
//
// All children must belong to the same PO.
//

function getCurrentBomCycle(
  parentCode,
  state,
  components
) {
  const children = [];

  for (
    const component of
      components
  ) {
    const childCode =
      String(
        component.BoMComponentProductCode ||
          ""
      ).trim();

    if (!childCode) {
      continue;
    }

    const currentCycle =
      getCurrentCycleForProduct(
        childCode,
        state
      );

    if (!currentCycle) {
      return {
        blocked: true,
        reason:
          "bom_child_has_no_completed_cycle",
        children: [
          {
            childCode,
            poNumber: null,
          },
        ],
      };
    }

    children.push({
      childCode,
      poNumber:
        currentCycle.poNumber,
      processedDate:
        currentCycle.processedDate,
    });
  }

  if (
    children.length === 0
  ) {
    return null;
  }

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
    return {
      blocked: true,
      reason:
        "bom_children_different_pos",
      children,
    };
  }

  return {
    productCode:
      String(
        parentCode
      )
        .trim()
        .toUpperCase(),

    poNumber:
      poNumbers[0],

    children,
  };
}

// ==================================================
// CHECK EXCLUDED SUPPLIER
// ==================================================

function isExcludedBySupplier(
  code,
  state
) {
  const invKeys =
    Object.keys(state).filter(
      (key) =>
        key.startsWith("inv:") &&
        key.endsWith(`:${code}`)
    );

  return invKeys.some(
    (key) => {
      const supplier =
        state[key]?.supplier;

      return (
        supplier &&
        EXCLUDED_SUPPLIERS.some(
          (excluded) =>
            excluded.toLowerCase() ===
            String(
              supplier
            ).toLowerCase()
        )
      );
    }
  );
}

// ==================================================
// BLOCK CHECK
// ==================================================

function isBlocked(
  code,
  state
) {
  if (
    isExcludedBySupplier(
      code,
      state
    )
  ) {
    console.log(
      `${code}: excluded supplier (Parmco Ltd) — skipping`
    );

    return true;
  }

  return false;
}

// ==================================================
// CHECK STANDALONE PRODUCT
// ==================================================

async function checkStandaloneProduct(
  code,
  currentCycle,
  state,
  watcherState
) {
  console.log("");
  console.log(
    "=============================================="
  );
  console.log(
    `CHECKING CHCH STANDALONE: ${code}`
  );
  console.log(
    "=============================================="
  );

  if (
    isBlocked(
      code,
      state
    )
  ) {
    return false;
  }

  const poNumber =
    currentCycle.poNumber;

  console.log(
    `${code}: current presale cycle = ${poNumber}`
  );

  const product =
    await getProductByCode(
      code
    );

  if (!product) {
    return false;
  }

  if (
    isExcludedByTitle(
      product.Name
    )
  ) {
    console.log(
      `${code}: title contains "NZ MADE" — excluded, skipping`
    );

    return false;
  }

  const currentSnapshot =
    getRealWarehouseSnapshot(
      product
    );

  console.log(
    `${code}: real warehouse stock =`,
    currentSnapshot
  );

  const cycleKey =
    `${code}::${poNumber}`;

  const previousSnapshot =
    watcherState[
      cycleKey
    ]?.warehouses;

  // ------------------------------------------------
  // FIRST OBSERVATION
  // ------------------------------------------------

  if (!previousSnapshot) {
    watcherState[
      cycleKey
    ] = {
      type: "standalone",
      productCode: code,
      poNumber,
      warehouses:
        currentSnapshot,
      updatedAt:
        new Date().toISOString(),
    };

    console.log(
      `${code} / ${poNumber}: first observation — baseline saved`
    );

    log(
      "info",
      `${code} / ${poNumber}: watcher baseline created`
    );

    return false;
  }

  // ------------------------------------------------
  // STOCK CHANGE
  // ------------------------------------------------

  const increases =
    detectPositiveStockChange(
      previousSnapshot,
      currentSnapshot
    );

  if (
    increases.length === 0
  ) {
    console.log(
      `${code} / ${poNumber}: no positive stock increase`
    );

    watcherState[
      cycleKey
    ].warehouses =
      currentSnapshot;

    watcherState[
      cycleKey
    ].updatedAt =
      new Date().toISOString();

    return false;
  }

  console.log(
    `${code} / ${poNumber}: POSITIVE REAL STOCK CHANGE DETECTED`
  );

  for (
    const increase of
      increases
  ) {
    console.log(
      `    ${increase.warehouseCode}: ${increase.previousQty} → ${increase.currentQty}`
    );
  }

  log(
    "success",
    `${code} / ${poNumber}: positive real warehouse stock increase detected`
  );

  // ------------------------------------------------
  // Update baseline
  // ------------------------------------------------

  watcherState[
    cycleKey
  ].warehouses =
    currentSnapshot;

  watcherState[
    cycleKey
  ].updatedAt =
    new Date().toISOString();

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
    `CHECKING CHCH BOM PARENT: ${parentCode}`
  );
  console.log(
    "=============================================="
  );

  if (
    isBlocked(
      parentCode,
      state
    )
  ) {
    return false;
  }

  const parent =
    await getProductByCode(
      parentCode
    );

  if (!parent) {
    return false;
  }

  if (
    isExcludedByTitle(
      parent.Name
    )
  ) {
    console.log(
      `${parentCode}: title contains "NZ MADE" — excluded, skipping`
    );

    return false;
  }

  const components =
    (
      parent.BoMComponents ||
      []
    ).filter(
      (component) =>
        component.BoMComponentProductCode
    );

  if (
    components.length === 0
  ) {
    console.log(
      `${parentCode}: no BOM components found — skipping`
    );

    return false;
  }

  console.log(
    `${parentCode}: checking ${components.length} BOM child component(s)`
  );

  const currentBomCycle =
    getCurrentBomCycle(
      parentCode,
      state,
      components
    );

  if (!currentBomCycle) {
    console.log(
      `${parentCode}: no current BOM cycle found — skipping`
    );

    return false;
  }

  if (
    currentBomCycle.blocked
  ) {
    console.log(
      `${parentCode}: BLOCKED — ${currentBomCycle.reason}`
    );

    currentBomCycle.children?.forEach(
      (child) => {
        console.log(
          `    ${child.childCode} → ${
            child.poNumber || "no cycle"
          }`
        );
      }
    );

    return false;
  }

  const poNumber =
    currentBomCycle.poNumber;

  console.log(
    `${parentCode}: current BOM presale cycle = ${poNumber}`
  );

  const cycleKey =
    `${parentCode}::${poNumber}`;

  const currentChildren = {};

  for (
    const component of
      components
  ) {
    const childCode =
      String(
        component.BoMComponentProductCode
      ).trim();

    const child =
      await getProductByCode(
        childCode
      );

    if (!child) {
      console.log(
        `${childCode}: product not found — BOM watcher cannot evaluate stock`
      );

      return false;
    }

    if (
      isExcludedByTitle(
        child.Name
      )
    ) {
      console.log(
        `${childCode}: title contains "NZ MADE" — excluded`
      );

      return false;
    }

    const childSnapshot =
      getRealWarehouseSnapshot(
        child
      );

    currentChildren[
      childCode
    ] = childSnapshot;

    console.log(
      `${childCode}: real warehouse stock =`,
      childSnapshot
    );
  }

  const previousChildren =
    watcherState[
      cycleKey
    ]?.children;

  // ------------------------------------------------
  // FIRST OBSERVATION
  // ------------------------------------------------

  if (!previousChildren) {
    watcherState[
      cycleKey
    ] = {
      type: "bom",
      productCode:
        parentCode,
      poNumber,
      children:
        currentChildren,
      updatedAt:
        new Date().toISOString(),
    };

    console.log(
      `${parentCode} / ${poNumber}: first observation — BOM baseline saved`
    );

    log(
      "info",
      `${parentCode} / ${poNumber}: BOM watcher baseline created`
    );

    return false;
  }

  // ------------------------------------------------
  // CHECK ALL BOM CHILDREN FOR INCREASE
  // ------------------------------------------------

  let anyIncrease =
    false;

  for (
    const [
      childCode,
      currentSnapshot,
    ] of Object.entries(
      currentChildren
    )) {
    const previousSnapshot =
      previousChildren[
        childCode
      ] || {};

    const increases =
      detectPositiveStockChange(
        previousSnapshot,
        currentSnapshot
      );

    if (
      increases.length > 0
    ) {
      anyIncrease =
        true;

      console.log(
        `${childCode}: POSITIVE REAL STOCK CHANGE DETECTED`
      );

      for (
        const increase of
          increases
      ) {
        console.log(
          `    ${increase.warehouseCode}: ${increase.previousQty} → ${increase.currentQty}`
        );
      }
    } else {
      console.log(
        `${childCode}: no positive stock increase`
      );
    }
  }

  // ------------------------------------------------
  // UPDATE BOM BASELINE
  // ------------------------------------------------

  watcherState[
    cycleKey
  ].children =
    currentChildren;

  watcherState[
    cycleKey
  ].updatedAt =
    new Date().toISOString();

  if (!anyIncrease) {
    console.log(
      `${parentCode} / ${poNumber}: no qualifying child stock increase`
    );

    return false;
  }

  console.log(
    `${parentCode} / ${poNumber}: BOM stock increase detected ✓`
  );

  log(
    "success",
    `${parentCode} / ${poNumber}: BOM child real warehouse stock increase detected`
  );

  return true;
}

// ==================================================
// RUN CHCH REMOVE-PRESALE SCRIPT
// ==================================================

function runRemovePresale() {
  return new Promise(
    (resolve) => {
      console.log("");
      console.log(
        "======================================================"
      );
      console.log(
        " CHCH STOCK TRIGGER DETECTED"
      );
      console.log(
        " Starting CHCH remove-presale script..."
      );
      console.log(
        "======================================================"
      );
      console.log("");

      const scriptPath =
        path.join(
          __dirname,
          "remove-presale-chch.js"
        );

      const child =
        spawn(
          process.execPath,
          [scriptPath],
          {
            cwd:
              path.join(
                __dirname,
                ".."
              ),

            env: {
              ...process.env,
            },

            stdio:
              "inherit",
          }
        );

      child.on(
        "error",
        (err) => {
          console.error(
            "CHCH remove-presale process failed to start:",
            err.message
          );

          log(
            "error",
            `CHCH remove-presale process failed to start: ${err.message}`
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
              "✓ CHCH remove-presale script completed"
            );

            log(
              "success",
              "CHCH remove-presale script completed"
            );

            resolve(true);
          } else {
            console.log("");
            console.log(
              `CHCH remove-presale script exited with code ${code}`
            );

            log(
              "error",
              `CHCH remove-presale script exited with code ${code}`
            );

            resolve(false);
          }
        }
      );
    }
  );
}

// ==================================================
// FIND ACTIVE STANDALONE PRODUCTS
// ==================================================

function getStandaloneProducts(
  state
) {
  const codes =
    Object.keys(state)
      .filter(
        (key) =>
          key.startsWith("title:")
      )
      .map(
        (key) =>
          key.replace(
            "title:",
            ""
          )
      )
      .filter(
        (code) =>
          !state[
            `bom:${code}`
          ]
      );

  const products = [];

  for (
    const code of codes
  ) {
    const currentCycle =
      getCurrentCycleForProduct(
        code,
        state
      );

    if (!currentCycle) {
      console.log(
        `${code}: no completed inventory cycle found — skipping`
      );

      continue;
    }

    products.push({
      code,
      currentCycle,
    });
  }

  return products;
}

// ==================================================
// FIND ACTIVE BOM PARENTS
// ==================================================

function getBomParents(
  state
) {
  return Object.keys(state)
    .filter(
      (key) =>
        key.startsWith(
          "bom:"
        )
    )
    .map(
      (key) =>
        key.replace(
          "bom:",
          ""
        )
    );
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
    " CHCH AUTOMATIC PRESALE REMOVAL WATCHER"
  );
  console.log(
    "======================================================"
  );
  console.log("");
  console.log(
    "Purpose:"
  );
  console.log(
    "Watch CHCH real warehouse inventory and automatically"
  );
  console.log(
    "start remove-presale-chch.js when stock increases."
  );
  console.log("");
  console.log(
    `Processed state: ${STATE_FILE}`
  );
  console.log(
    `Watcher state:   ${WATCHER_STATE_FILE}`
  );
  console.log("");

  // ------------------------------------------------
  // CREDENTIAL CHECK
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
  // LOAD STATES
  // ------------------------------------------------

  const state =
    loadState();

  const watcherState =
    loadWatcherState();

  // ------------------------------------------------
  // FIND PRODUCTS
  // ------------------------------------------------

  const standaloneProducts =
    getStandaloneProducts(
      state
    );

  const bomParentCodes =
    getBomParents(
      state
    );

  console.log(
    `Found ${standaloneProducts.length} standalone CHCH product(s): ${
      standaloneProducts.length
        ? standaloneProducts
            .map(
              (item) =>
                item.code
            )
            .join(", ")
        : "none"
    }`
  );

  console.log(
    `Found ${bomParentCodes.length} CHCH BOM parent(s): ${
      bomParentCodes.join(
        ", "
      ) || "none"
    }`
  );

  let removalRequired =
    false;

  // ==================================================
  // CHECK STANDALONE PRODUCTS
  // ==================================================

  for (
    const item of
      standaloneProducts
  ) {
    try {
      const triggered =
        await checkStandaloneProduct(
          item.code,
          item.currentCycle,
          state,
          watcherState
        );

      if (triggered) {
        removalRequired =
          true;
      }
    } catch (err) {
      console.error(
        `${item.code}: ERROR — ${err.message}`
      );

      log(
        "error",
        `${item.code}: ${err.message}`
      );
    }
  }

  // ==================================================
  // CHECK BOM PARENTS
  // ==================================================

  for (
    const parentCode of
      bomParentCodes
  ) {
    try {
      const triggered =
        await checkBomParent(
          parentCode,
          state,
          watcherState
        );

      if (triggered) {
        removalRequired =
          true;
      }
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

  // ==================================================
  // SAVE WATCHER BASELINE
  // ==================================================

  saveWatcherState(
    watcherState
  );

  // ==================================================
  // RUN REMOVAL
  // ==================================================

  if (!removalRequired) {
    console.log("");
    console.log(
      "No qualifying CHCH stock increase detected."
    );
    console.log(
      "No presale removal required."
    );
  } else {
    console.log("");
    console.log(
      "Qualifying CHCH stock increase detected."
    );
    console.log(
      "Starting CHCH presale removal..."
    );

    await runRemovePresale();
  }

  // ==================================================
  // COMPLETE
  // ==================================================

  console.log("");
  console.log(
    "======================================================"
  );
  console.log(
    " CHCH AUTOMATIC PRESALE WATCHER COMPLETE"
  );
  console.log(
    "======================================================"
  );
  console.log("");
}

// ==================================================
// RUN
// ==================================================

main().catch(
  (err) => {
    console.error(
      "CHCH WATCHER CRASHED:",
      err.message
    );

    console.error(err);

    process.exit(1);
  }
);