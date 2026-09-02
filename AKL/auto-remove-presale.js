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

  console.log(
    `[${type.toUpperCase()}] ${msg}`
  );

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
      supplier ===
      excluded.toLowerCase()
  );
}

// ========================================================
// OAUTH
// ========================================================

// const oauth = new OAuth({
//   consumer: {
//     key:
//       process.env.TRADEVINE_CONSUMER_KEY,
//     secret:
//       process.env.TRADEVINE_CONSUMER_SECRET,
//   },

//   signature_method:
//     "HMAC-SHA1",

//   hash_function(
//     baseString,
//     key
//   ) {
//     return crypto
//       .createHmac(
//         "sha1",
//         key
//       )
//       .update(baseString)
//       .digest("base64");
//   },
// });

// function getTradevineHeaders(
//   method,
//   url
// ) {
//   return oauth.toHeader(
//     oauth.authorize(
//       {
//         url,
//         method,
//       },
//       {
//         key:
//           process.env.TRADEVINE_ACCESS_TOKEN,
//         secret:
//           process.env.TRADEVINE_ACCESS_TOKEN_SECRET,
//       }
//     )
//   );
// }

// ========================================================
// TRADEVINE API
// ========================================================

// async function apiGet(url) {
//   const headers =
//     getTradevineHeaders(
//       "GET",
//       url
//     );

//   const response =
//     await fetch(url, {
//       method: "GET",
//       headers: {
//         ...headers,
//         Accept:
//           "application/json",
//       },
//     });

//   const text =
//     await response.text();

//   if (!response.ok) {
//     throw new Error(
//       `Tradevine GET ${response.status}: ${text}`
//     );
//   }

//   return text
//     ? JSONbig.parse(text)
//     : null;
// }

// ========================================================
// GET PRODUCT
// ========================================================

// async function getProductByCode(
//   productCode
// ) {
//   const url =
//     `${TV_API}/v1/Product` +
//     `?code=${encodeURIComponent(
//       productCode
//     )}`;

//   const result =
//     await apiGet(url);

//   if (
//     Array.isArray(result)
//   ) {
//     return result[0] || null;
//   }

//   if (
//     Array.isArray(
//       result?.Items
//     )
//   ) {
//     return (
//       result.Items[0] ||
//       null
//     );
//   }

//   if (
//     Array.isArray(
//       result?.Results
//     )
//   ) {
//     return (
//       result.Results[0] ||
//       null
//     );
//   }

//   if (
//     result?.Code
//   ) {
//     return result;
//   }

//   return null;
// }

// ========================================================
// ACTIVE CYCLES
// ========================================================

function getActiveCycles(state) {
  const cycles = [];

  // ------------------------------------------------------
  // Standalone products
  // ------------------------------------------------------

  for (
    const key of Object.keys(state)
  ) {
    if (
      !key.startsWith(
        "title:"
      )
    ) {
      continue;
    }

    const code =
      key.replace(
        "title:",
        ""
      ).trim().toUpperCase();

    // BOM parent is handled separately.
    if (
      state[
        `bom:${code}`
      ]
    ) {
      continue;
    }

    const entry =
      state[key];

    const poNumber =
      String(
        entry?.poNumber ||
          ""
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

  for (
    const key of Object.keys(state)
  ) {
    if (
      !key.startsWith(
        "bom:"
      )
    ) {
      continue;
    }

    const code =
      key.replace(
        "bom:",
        ""
      ).trim().toUpperCase();

    const entry =
      state[key];

    const poNumber =
      String(
        entry?.poNumber ||
          ""
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

function getRealWarehouseSnapshot(
  product
) {
  const snapshot = {};

  const warehouses =
    product?.PerWarehouseInventory ||
    [];

  for (
    const warehouse of warehouses
  ) {
    const warehouseCode =
      String(
        warehouse?.WarehouseCode ||
          ""
      ).trim();

    if (
      !warehouseCode
    ) {
      continue;
    }

    if (
      !REAL_WAREHOUSE_PATTERN.test(
        warehouseCode
      )
    ) {
      continue;
    }

    const quantity =
      Number(
        warehouse?.QuantityInStockSnapshot ??
          warehouse?.QuantityInStock ??
          0
      );

    snapshot[
      warehouseCode
    ] = Number.isFinite(
      quantity
    )
      ? quantity
      : 0;
  }

  return snapshot;
}

// ========================================================
// STOCK CHANGE DETECTION
// ========================================================

function hasRealStockIncrease(
  baseline,
  current
) {
  const warehouses =
    new Set([
      ...Object.keys(
        baseline || {}
      ),
      ...Object.keys(
        current || {}
      ),
    ]);

  for (
    const warehouseCode of warehouses
  ) {
    const oldQty =
      Number(
        baseline?.[
          warehouseCode
        ] ?? 0
      );

    const newQty =
      Number(
        current?.[
          warehouseCode
        ] ?? 0
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

    // Quantity increased
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
// BASELINE KEY
// ========================================================

function getBaselineKey(
  productCode,
  poNumber
) {
  return `${String(
    productCode
  )
    .trim()
    .toUpperCase()}::${String(
    poNumber
  )
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

  // ------------------------------------------------------
  // Current warehouse snapshot
  // ------------------------------------------------------

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

  // ------------------------------------------------------
  // FIRST SEEN CYCLE
  // ------------------------------------------------------

  if (
    !baseline[
      baselineKey
    ]
  ) {
    baseline[
      baselineKey
    ] = {
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

  // ------------------------------------------------------
  // COMPARE WITH BASELINE
  // ------------------------------------------------------

  const previousSnapshot =
    baseline[
      baselineKey
    ].warehouses || {};

  const change =
    hasRealStockIncrease(
      previousSnapshot,
      currentSnapshot
    );

  if (
    !change.changed
  ) {
    log(
      "info",
      `${code} + ${poNumber}: no real warehouse stock increase`
    );

    return false;
  }

  // ------------------------------------------------------
  // STOCK INCREASE DETECTED
  // ------------------------------------------------------

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

  // ------------------------------------------------------
  // SUCCESS
  // ------------------------------------------------------

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
};