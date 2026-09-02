require("dotenv").config();

const fs = require("fs");
const path = require("path");

const {
  removePresaleForProduct,
  getProductByCode,
} = require("./remove-presale");

// ========================================================
// CONFIG
// ========================================================

const LOG_FILE = "./automation.log";

const STATE_FILE = path.join(
  __dirname,
  "..",
  "json",
  "AKL",
  "processed-state.json"
);

const BASELINE_FILE = path.join(
  __dirname,
  "..",
  "json",
  "AKL",
  "real-stock-baseline.json"
);

const REAL_WAREHOUSE_PATTERN =
  /^\d{1,2}-\d{1,2}-[A-Za-z]-\d{1,2}$/;

const EXCLUDED_SUPPLIERS = [
  "Parmco Ltd",
];

// ========================================================
// LOGGING
// ========================================================

function log(type, msg) {
  const entry = {
    time: new Date().toISOString(),
    type,
    msg,
  };

  console.log(`[${type.toUpperCase()}] ${msg}`);

  try {
    fs.appendFileSync(
      LOG_FILE,
      JSON.stringify(entry) + "\n"
    );
  } catch (err) {
    console.error(
      `[ERROR] Could not write log: ${err.message}`
    );
  }
}

// ========================================================
// JSON HELPERS
// ========================================================

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      return fallback;
    }

    const raw = fs.readFileSync(
      file,
      "utf8"
    );

    if (!raw.trim()) {
      return fallback;
    }

    return JSON.parse(raw);
  } catch (err) {
    log(
      "error",
      `Could not load ${file}: ${err.message}`
    );

    return fallback;
  }
}

function saveJson(file, data) {
  try {
    fs.mkdirSync(
      path.dirname(file),
      {
        recursive: true,
      }
    );

    fs.writeFileSync(
      file,
      JSON.stringify(
        data,
        null,
        2
      )
    );

    return true;
  } catch (err) {
    log(
      "error",
      `Could not save ${file}: ${err.message}`
    );

    return false;
  }
}

// ========================================================
// STATE
// ========================================================

function loadState() {
  return loadJson(
    STATE_FILE,
    {}
  );
}

function loadBaseline() {
  return loadJson(
    BASELINE_FILE,
    {}
  );
}

function saveBaseline(baseline) {
  return saveJson(
    BASELINE_FILE,
    baseline
  );
}

// ========================================================
// EXCLUSIONS
// ========================================================

function isExcludedByTitle(product) {
  const title = String(
    product?.Name || ""
  ).trim();

  return title
    .toUpperCase()
    .includes("NZ MADE");
}

function isExcludedBySupplier(product) {
  const supplier = String(
    product?.SupplierName ||
      product?.Supplier?.Name ||
      ""
  )
    .trim()
    .toLowerCase();

  return EXCLUDED_SUPPLIERS.some(
    (excluded) =>
      supplier === excluded.toLowerCase()
  );
}

// ========================================================
// ACTIVE CYCLES
// ========================================================

function getActiveCycles(state) {
  const cycles = [];

  // ------------------------------------------------------
  // Standalone products
  // ------------------------------------------------------

  for (const key of Object.keys(state)) {
    if (!key.startsWith("title:")) {
      continue;
    }

    const code = key
      .replace("title:", "")
      .trim()
      .toUpperCase();

    // BOM parent is handled separately.
    if (state[`bom:${code}`]) {
      continue;
    }

    const entry = state[key];

    const poNumber = String(
      entry?.poNumber || ""
    )
      .trim()
      .toUpperCase();

    if (!poNumber) {
      log(
        "warn",
        `${code}: active title state has no PO number — skipping watcher`
      );

      continue;
    }

    cycles.push({
      productCode: code,
      poNumber,
      type: "standalone",
    });
  }

  // ------------------------------------------------------
  // BOM parents
  // ------------------------------------------------------

  for (const key of Object.keys(state)) {
    if (!key.startsWith("bom:")) {
      continue;
    }

    const code = key
      .replace("bom:", "")
      .trim()
      .toUpperCase();

    const entry = state[key];

    const poNumber = String(
      entry?.poNumber || ""
    )
      .trim()
      .toUpperCase();

    if (!poNumber) {
      log(
        "warn",
        `${code}: active BOM state has no PO number — skipping watcher`
      );

      continue;
    }

    cycles.push({
      productCode: code,
      poNumber,
      type: "bom",
    });
  }

  return cycles;
}

// ========================================================
// REAL WAREHOUSE SNAPSHOT
// ========================================================

function getRealWarehouseSnapshot(product) {
  const snapshot = {};

  const warehouses =
    product?.PerWarehouseInventory || [];

  for (const warehouse of warehouses) {
    const warehouseCode = String(
      warehouse?.WarehouseCode || ""
    ).trim();

    if (!warehouseCode) {
      continue;
    }

    if (
      !REAL_WAREHOUSE_PATTERN.test(
        warehouseCode
      )
    ) {
      continue;
    }

    const quantity = Number(
      warehouse?.QuantityInStockSnapshot ??
        warehouse?.QuantityInStock ??
        0
    );

    snapshot[warehouseCode] =
      Number.isFinite(quantity)
        ? quantity
        : 0;
  }

  return snapshot;
}

// ========================================================
// BOM CHILD SNAPSHOT
// ========================================================

async function getBomChildrenSnapshot(
  parentProduct
) {
  const snapshot = {};
  const childCodes = [];

  const components =
    Array.isArray(
      parentProduct?.BoMComponents
    )
      ? parentProduct.BoMComponents
      : [];

  for (const component of components) {
    const childCode = String(
      component?.BoMComponentProductCode ||
        ""
    )
      .trim()
      .toUpperCase();

    if (!childCode) {
      continue;
    }

    if (
      childCodes.includes(childCode)
    ) {
      continue;
    }

    childCodes.push(childCode);
  }

  if (!childCodes.length) {
    return {
      foundAllChildren: true,
      childCodes: [],
      snapshot: {},
    };
  }

  for (const childCode of childCodes) {
    let childProduct;

    try {
      childProduct =
        await getProductByCode(
          childCode
        );
    } catch (err) {
      log(
        "error",
        `${parentProduct.Code}: failed to fetch BOM child ${childCode} — ${err.message}`
      );

      return {
        foundAllChildren: false,
        childCodes,
        snapshot,
      };
    }

    if (!childProduct) {
      log(
        "warn",
        `${parentProduct.Code}: BOM child ${childCode} not found`
      );

      return {
        foundAllChildren: false,
        childCodes,
        snapshot,
      };
    }

    snapshot[childCode] =
      getRealWarehouseSnapshot(
        childProduct
      );

    log(
      "info",
      `${parentProduct.Code}: BOM child ${childCode} real warehouse stock = ${JSON.stringify(
        snapshot[childCode]
      )}`
    );
  }

  return {
    foundAllChildren: true,
    childCodes,
    snapshot,
  };
}

// ========================================================
// STOCK CHANGE DETECTION
// ========================================================

function hasRealStockIncrease(
  baseline,
  current
) {
  const warehouses = new Set([
    ...Object.keys(
      baseline || {}
    ),
    ...Object.keys(
      current || {}
    ),
  ]);

  for (const warehouseCode of warehouses) {
    const oldQty = Number(
      baseline?.[warehouseCode] ?? 0
    );

    const newQty = Number(
      current?.[warehouseCode] ?? 0
    );

    // New warehouse stock
    if (
      oldQty <= 0 &&
      newQty > 0
    ) {
      return {
        changed: true,
        warehouseCode,
        oldQty,
        newQty,
        reason:
          "new real warehouse stock",
      };
    }

    // Existing warehouse quantity increased
    if (
      newQty > oldQty
    ) {
      return {
        changed: true,
        warehouseCode,
        oldQty,
        newQty,
        reason:
          "real warehouse quantity increased",
      };
    }
  }

  return {
    changed: false,
  };
}

// ========================================================
// BOM STOCK CHANGE DETECTION
// ========================================================

function hasBomRealStockIncrease(
  baseline,
  current
) {
  const childCodes = new Set([
    ...Object.keys(
      baseline || {}
    ),
    ...Object.keys(
      current || {}
    ),
  ]);

  for (const childCode of childCodes) {
    const previousSnapshot =
      baseline?.[childCode] || {};

    const currentSnapshot =
      current?.[childCode] || {};

    const change =
      hasRealStockIncrease(
        previousSnapshot,
        currentSnapshot
      );

    if (change.changed) {
      return {
        changed: true,
        childCode,
        warehouseCode:
          change.warehouseCode,
        oldQty: change.oldQty,
        newQty: change.newQty,
        reason: change.reason,
      };
    }
  }

  return {
    changed: false,
  };
}

// ========================================================
// BASELINE KEY
// ========================================================

function getBaselineKey(
  productCode,
  poNumber
) {
  return `${String(productCode)
    .trim()
    .toUpperCase()}::${String(poNumber)
    .trim()
    .toUpperCase()}`;
}

// ========================================================
// PROCESS ONE ACTIVE CYCLE
// ========================================================

async function checkCycle(
  cycle,
  state,
  baseline
) {
  const code =
    cycle.productCode;

  const poNumber =
    cycle.poNumber;

  const baselineKey =
    getBaselineKey(
      code,
      poNumber
    );

  log(
    "info",
    `Checking ${code} + ${poNumber}`
  );

  // ------------------------------------------------------
  // Get current product
  // ------------------------------------------------------

  let product;

  try {
    product =
      await getProductByCode(
        code
      );
  } catch (err) {
    log(
      "error",
      `${code} + ${poNumber}: failed to fetch product — ${err.message}`
    );

    return false;
  }

  if (!product) {
    log(
      "warn",
      `${code} + ${poNumber}: product not found`
    );

    return false;
  }

  // ------------------------------------------------------
  // Exclusions
  // ------------------------------------------------------

  if (
    isExcludedByTitle(
      product
    )
  ) {
    log(
      "info",
      `${code}: title contains "NZ MADE" — watcher skipping`
    );

    return false;
  }

  if (
    isExcludedBySupplier(
      product
    )
  ) {
    log(
      "info",
      `${code}: supplier is excluded — watcher skipping`
    );

    return false;
  }

  // ======================================================
  // STANDALONE PRODUCT
  // ======================================================

  if (
    cycle.type === "standalone"
  ) {
    const currentSnapshot =
      getRealWarehouseSnapshot(
        product
      );

    log(
      "info",
      `${code} + ${poNumber}: current real warehouse stock = ${JSON.stringify(
        currentSnapshot
      )}`
    );

    // ----------------------------------------------------
    // FIRST SEEN CYCLE
    // ----------------------------------------------------

    if (
      !baseline[baselineKey]
    ) {
      baseline[baselineKey] = {
        productCode: code,
        poNumber,
        type: cycle.type,
        createdAt:
          new Date().toISOString(),
        warehouses:
          currentSnapshot,
      };

      saveBaseline(
        baseline
      );

      log(
        "success",
        `${code} + ${poNumber}: baseline created — watcher will not remove presale on this first check`
      );

      return false;
    }

    // ----------------------------------------------------
    // COMPARE WITH BASELINE
    // ----------------------------------------------------

    const previousSnapshot =
      baseline[
        baselineKey
      ].warehouses || {};

    const change =
      hasRealStockIncrease(
        previousSnapshot,
        currentSnapshot
      );

    if (!change.changed) {
      log(
        "info",
        `${code} + ${poNumber}: no real warehouse stock increase`
      );

      return false;
    }

    // ----------------------------------------------------
    // STOCK INCREASE DETECTED
    // ----------------------------------------------------

    log(
      "success",
      `${code} + ${poNumber}: ${change.reason} detected — ${change.warehouseCode}: ${change.oldQty} -> ${change.newQty}`
    );

    log(
      "info",
      `${code} + ${poNumber}: calling removePresaleForProduct()`
    );

    let removed;

    try {
      removed =
        await removePresaleForProduct(
          code,
          poNumber
        );
    } catch (err) {
      log(
        "error",
        `${code} + ${poNumber}: removePresaleForProduct failed — ${err.message}`
      );

      return false;
    }

    if (!removed) {
      log(
        "info",
        `${code} + ${poNumber}: presale was not removed — keeping baseline/state for retry`
      );

      return false;
    }

    // ----------------------------------------------------
    // SUCCESS
    // ----------------------------------------------------

    delete baseline[
      baselineKey
    ];

    saveBaseline(
      baseline
    );

    log(
      "success",
      `${code} + ${poNumber}: automatic presale removal completed`
    );

    return true;
  }

  // ======================================================
  // BOM PARENT
  // ======================================================

  if (
    cycle.type === "bom"
  ) {
    log(
      "info",
      `${code} + ${poNumber}: BOM parent detected — checking BOM children for real warehouse stock`
    );

    const bomSnapshot =
      await getBomChildrenSnapshot(
        product
      );

    if (
      !bomSnapshot.foundAllChildren
    ) {
      log(
        "warn",
        `${code} + ${poNumber}: could not build complete BOM child snapshot — skipping this check`
      );

      return false;
    }

    if (
      !bomSnapshot.childCodes.length
    ) {
      log(
        "warn",
        `${code} + ${poNumber}: BOM has no child products — skipping watcher`
      );

      return false;
    }

    // ----------------------------------------------------
    // FIRST SEEN BOM CYCLE
    // ----------------------------------------------------

    if (
      !baseline[baselineKey]
    ) {
      baseline[baselineKey] = {
        productCode: code,
        poNumber,
        type: cycle.type,
        createdAt:
          new Date().toISOString(),
        children:
          bomSnapshot.snapshot,
      };

      saveBaseline(
        baseline
      );

      log(
        "success",
        `${code} + ${poNumber}: BOM child baseline created — watcher will not remove presale on this first check`
      );

      return false;
    }

    // ----------------------------------------------------
    // COMPARE BOM CHILDREN
    // ----------------------------------------------------

    const previousSnapshot =
      baseline[
        baselineKey
      ].children || {};

    const change =
      hasBomRealStockIncrease(
        previousSnapshot,
        bomSnapshot.snapshot
      );

    if (
      !change.changed
    ) {
      log(
        "info",
        `${code} + ${poNumber}: no BOM child real warehouse stock increase`
      );

      return false;
    }

    // ----------------------------------------------------
    // BOM CHILD STOCK INCREASE DETECTED
    // ----------------------------------------------------

    log(
      "success",
      `${code} + ${poNumber}: BOM child ${change.childCode} ${change.reason} detected — ${change.warehouseCode}: ${change.oldQty} -> ${change.newQty}`
    );

    log(
      "info",
      `${code} + ${poNumber}: calling removePresaleForProduct() for BOM parent`
    );

    let removed;

    try {
      removed =
        await removePresaleForProduct(
          code,
          poNumber
        );
    } catch (err) {
      log(
        "error",
        `${code} + ${poNumber}: removePresaleForProduct failed — ${err.message}`
      );

      return false;
    }

    if (!removed) {
      log(
        "info",
        `${code} + ${poNumber}: BOM presale was not removed — keeping baseline/state for retry`
      );

      return false;
    }

    // ----------------------------------------------------
    // SUCCESS
    // ----------------------------------------------------

    delete baseline[
      baselineKey
    ];

    saveBaseline(
      baseline
    );

    log(
      "success",
      `${code} + ${poNumber}: automatic BOM presale removal completed`
    );

    return true;
  }

  // ------------------------------------------------------
  // UNKNOWN TYPE
  // ------------------------------------------------------

  log(
    "warn",
    `${code} + ${poNumber}: unknown cycle type "${cycle.type}" — skipping`
  );

  return false;
}

// ========================================================
// MAIN WATCHER
// ========================================================

async function main() {
  log(
    "info",
    "========================================"
  );

  log(
    "info",
    "AKL AUTOMATIC PRESALE WATCHER STARTED"
  );

  log(
    "info",
    "========================================"
  );

  const state =
    loadState();

  const baseline =
    loadBaseline();

  const cycles =
    getActiveCycles(
      state
    );

  log(
    "info",
    `Found ${cycles.length} active presale cycle(s)`
  );

  if (
    !cycles.length
  ) {
    log(
      "info",
      "No active presale cycles — nothing to check"
    );

    return;
  }

  for (
    const cycle of cycles
  ) {
    try {
      await checkCycle(
        cycle,
        state,
        baseline
      );
    } catch (err) {
      log(
        "error",
        `${cycle.productCode} + ${cycle.poNumber}: unexpected watcher error — ${err.message}`
      );
    }
  }

  log(
    "success",
    "AKL AUTOMATIC PRESALE WATCHER FINISHED"
  );
}

// ========================================================
// START
// ========================================================

if (
  require.main === module
) {
  main().catch(
    (err) => {
      log(
        "error",
        `WATCHER CRASHED: ${err.message}`
      );

      console.error(
        err
      );

      process.exitCode = 1;
    }
  );
}

module.exports = {
  main,
  getRealWarehouseSnapshot,
  hasRealStockIncrease,
  hasBomRealStockIncrease,
};