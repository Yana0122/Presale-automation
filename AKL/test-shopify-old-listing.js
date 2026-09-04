require("dotenv").config();

const fs = require("fs");
const path = require("path");

const {
  listExistingProductOnShopify,
  getActivePOForProduct,
} = require("./shopify-old-listing");

// --------------------------------------------------
// FILES
// --------------------------------------------------

const STATE_FILE = path.join(
  __dirname,
  "../json/AKL/processed-state.json"
);

const RESULTS_FILE = path.join(
  __dirname,
  "../json/AKL/shopify-listing-results.json"
);

// --------------------------------------------------
// LOAD PROCESSED STATE
// --------------------------------------------------

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    console.error(
      `ERROR: ${STATE_FILE} not found.`
    );

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
      `ERROR: Could not read ${STATE_FILE}:`,
      err.message
    );

    return {};
  }
}

// --------------------------------------------------
// LOAD RESULTS
// --------------------------------------------------

function loadResults() {
  if (!fs.existsSync(RESULTS_FILE)) {
    return [];
  }

  try {
    const data =
      JSON.parse(
        fs.readFileSync(
          RESULTS_FILE,
          "utf8"
        )
      );

    return Array.isArray(data)
      ? data
      : [];
  } catch (err) {
    console.error(
      "WARNING: Could not read existing results:",
      err.message
    );

    return [];
  }
}

// --------------------------------------------------
// SAVE RESULTS
// --------------------------------------------------

function saveResults(results) {
  fs.writeFileSync(
    RESULTS_FILE,
    JSON.stringify(
      results,
      null,
      2
    )
  );
}

// --------------------------------------------------
// CHILD PRODUCT CHECK
// --------------------------------------------------
//
// PR15242-A
// PR15242-B
// ...
//
// These must NEVER be listed individually.
// --------------------------------------------------

function isChildProduct(productCode) {
  return /^PR\d+-[A-Z]$/i.test(
    String(productCode || "").trim()
  );
}

// --------------------------------------------------
// EXTRACT PRODUCT CODE
// --------------------------------------------------

function extractProductCode(key) {
  if (!key) {
    return null;
  }

  // inv:PO4447:PR15242
  if (key.startsWith("inv:")) {
    const parts =
      key.split(":");

    if (parts.length >= 3) {
      return parts
        .slice(2)
        .join(":")
        .trim()
        .toUpperCase();
    }
  }

  // title:PR15242
  if (key.startsWith("title:")) {
    return key
      .replace(/^title:/i, "")
      .trim()
      .toUpperCase();
  }

  // bom:PR15242
  if (key.startsWith("bom:")) {
    return key
      .replace(/^bom:/i, "")
      .trim()
      .toUpperCase();
  }

  return null;
}

// --------------------------------------------------
// GET DONE PRODUCTS
// --------------------------------------------------
//
// Only title: and bom: represent an active parent/
// standalone product that should be considered for
// Shopify listing.
//
// Inventory child records are deliberately not used
// directly for Shopify listing.
// --------------------------------------------------

function getDoneProducts(state) {
  const products =
    new Map();

  Object.entries(state).forEach(
    ([key, value]) => {
      if (
        !value ||
        value.done !== true
      ) {
        return;
      }

      // ONLY ACTIVE PRESALE STATE
      const isActiveStateKey =
        key.startsWith("title:") ||
        key.startsWith("bom:");

      if (!isActiveStateKey) {
        return;
      }

      const productCode =
        extractProductCode(key);

      if (!productCode) {
        return;
      }

      // IGNORE BOM CHILDREN
      if (
        isChildProduct(
          productCode
        )
      ) {
        return;
      }

      if (
        !products.has(
          productCode
        )
      ) {
        products.set(
          productCode,
          {
            productCode,
            stateKeys: [],
          }
        );
      }

      products
        .get(productCode)
        .stateKeys
        .push(key);
    }
  );

  return Array.from(
    products.values()
  );
}

// --------------------------------------------------
// MAIN
// --------------------------------------------------

async function main() {
  console.log("");

  console.log(
    "========================================"
  );

  console.log(
    " SHOPIFY OLD LISTING"
  );

  console.log(
    " ALL DONE PARENT / STANDALONE PRODUCTS"
  );

  console.log(
    "========================================"
  );

  console.log("");

  // --------------------------------------------------
  // LOAD STATE
  // --------------------------------------------------

  const state =
    loadState();

  const products =
    getDoneProducts(
      state
    );

  console.log(
    `Found ${products.length} eligible product(s).`
  );

  console.log("");

  if (
    products.length === 0
  ) {
    console.log(
      "No products with done=true were found."
    );

    return;
  }

  // --------------------------------------------------
  // PREPARE RUN
  // --------------------------------------------------

  const now =
    new Date().toISOString();

  const runId =
    now.replace(
      /[:.]/g,
      "-"
    );

  const previousResults =
    loadResults();

  const runResults = [];

  let listedCount = 0;
  let blockedCount = 0;
  let skippedCount = 0;

  // --------------------------------------------------
  // PROCESS PRODUCTS
  // --------------------------------------------------

  for (
    const product of products
  ) {
    const productCode =
      product.productCode;

    console.log(
      `Processing ${productCode}...`
    );

    // --------------------------------------------------
    // BOM CHILD PROTECTION
    // --------------------------------------------------

    if (
      isChildProduct(
        productCode
      )
    ) {
      console.log(
        `  ${productCode}: SKIPPED — BOM child product`
      );

      skippedCount++;

      runResults.push({
        productCode,
        status: "skipped",
        reason: "bom_child",
        date: now,
      });

      continue;
    }

    let activePO = null;

    try {
      // --------------------------------------------------
      // FIND ACTIVE PO
      // --------------------------------------------------

      const activeCycle =
        getActivePOForProduct(
          productCode,
          state
        );

      if (!activeCycle) {
        console.log(
          `  ${productCode}: SKIPPED — no active presale cycle`
        );

        skippedCount++;

        runResults.push({
          productCode,
          status: "skipped",
          reason:
            "no_active_presale_cycle",
          date: now,
        });

        continue;
      }

      activePO =
        activeCycle.poNumber;

      console.log(
        `  ${productCode}: Active PO = ${activePO}`
      );

      // --------------------------------------------------
      // CALL ACTUAL SHOPIFY LISTING LOGIC
      // --------------------------------------------------

      const result =
        await listExistingProductOnShopify(
          productCode,
          activePO
        );

      // --------------------------------------------------
      // SUCCESS
      // --------------------------------------------------

      if (result.ok) {
        if (result.skipped) {
          skippedCount++;

          runResults.push({
            productCode,
            poNumber: activePO,
            status: "skipped",
            reason:
              result.reason ||
              "skipped",
            date: now,
            result,
          });

          console.log(
            `  ${productCode}: SKIPPED — ${
              result.reason || "skipped"
            }`
          );
        } else {
          listedCount++;

          runResults.push({
            productCode,
            poNumber: activePO,
            status: "listed",
            reason: null,
            date: now,
            result,
          });

          console.log(
            `  ${productCode}: ✓ LISTED`
          );
        }
      }

      // --------------------------------------------------
      // BLOCKED
      // --------------------------------------------------

      else {
        blockedCount++;

        runResults.push({
          productCode,
          poNumber: activePO,
          status: "blocked",
          reason:
            result.reason ||
            "unknown",
          missing:
            result.missing ||
            [],
          error:
            result.error ||
            null,
          date: now,
          result,
        });

        console.log(
          `  ${productCode}: ⚠ BLOCKED`
        );
      }
    } catch (err) {
      blockedCount++;

      console.error(
        `  ${productCode}: ERROR — ${err.message}`
      );

      runResults.push({
        productCode,
        poNumber: activePO,
        status: "blocked",
        reason: "script_error",
        missing: [],
        error: err.message,
        date: now,
      });
    }

    console.log("");
  }

  // --------------------------------------------------
  // SAVE RUN RECORD
  // --------------------------------------------------

  const runRecord = {
    runId,
    date: now,

    summary: {
      total:
        products.length,

      listed:
        listedCount,

      blocked:
        blockedCount,

      skipped:
        skippedCount,
    },

    products:
      runResults,
  };

  previousResults.push(
    runRecord
  );

  // --------------------------------------------------
  // THIS IS THE REPORTING FILE
  // --------------------------------------------------
  //
  // It remains separate from processed-state.json.
  // --------------------------------------------------

  saveResults(
    previousResults
  );

  // --------------------------------------------------
  // DASHBOARD-FRIENDLY BLOCKED LIST
  // --------------------------------------------------

  const blockedProducts =
    runResults
      .filter(
        (item) =>
          item.status ===
          "blocked"
      )
      .map(
        (item) => ({
          productCode:
            item.productCode,

          poNumber:
            item.poNumber ||
            null,

          reason:
            item.reason,

          missing:
            item.missing ||
            [],

          error:
            item.error ||
            null,

          date:
            item.date,

          actionRequired:
            true,
        })
      );

  // --------------------------------------------------
  // SUMMARY
  // --------------------------------------------------

  console.log("");

  console.log(
    "========================================"
  );

  console.log(
    " SHOPIFY LISTING RUN COMPLETE"
  );

  console.log(
    "========================================"
  );

  console.log(
    `Total eligible: ${products.length}`
  );

  console.log(
    `Listed:         ${listedCount}`
  );

  console.log(
    `Blocked:        ${blockedCount}`
  );

  console.log(
    `Skipped:        ${skippedCount}`
  );

  console.log("");

  // --------------------------------------------------
  // SHOW BLOCKED PRODUCTS
  // --------------------------------------------------

  if (
    blockedProducts.length > 0
  ) {
    console.log(
      "========================================"
    );

    console.log(
      " BLOCKED PRODUCTS — STAFF ACTION REQUIRED"
    );

    console.log(
      "========================================"
    );

    blockedProducts.forEach(
      (item) => {
        console.log(
          `  ${item.productCode}`
        );

        if (item.poNumber) {
          console.log(
            `    PO: ${item.poNumber}`
          );
        }

        console.log(
          `    Reason: ${item.reason}`
        );

        if (
          item.missing.length > 0
        ) {
          console.log(
            `    Missing: ${item.missing.join(
              ", "
            )}`
          );
        }

        if (item.error) {
          console.log(
            `    Error: ${item.error}`
          );
        }

        console.log(
          `    Action required: YES`
        );

        console.log("");
      }
    );
  } else {
    console.log(
      "No blocked products."
    );
  }

  console.log("");

  console.log(
    `Results saved to: ${RESULTS_FILE}`
  );

  console.log(
    "========================================"
  );
}

// --------------------------------------------------
// RUN
// --------------------------------------------------

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