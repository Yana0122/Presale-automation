require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const OAuth = require("oauth-1.0a");
const crypto = require("crypto");
const JSONbig = require("json-bigint")({
  storeAsString: true,
});

const LOG_FILE = path.join(
  __dirname,
  "automation.log"
);

const STATE_FILE = path.join(
  __dirname,
  "../json/AKL/processed-state.json"
);

const SHOPIFY_LISTING_RESULTS_FILE = path.join(
  __dirname,
  "../json/AKL/shopify-listing-results.json"
);

// --------------------------------------------------
// LOGGING
// --------------------------------------------------

function log(type, msg) {
  const entry = {
    time: new Date().toISOString(),
    type,
    msg,
  };

  console.log(
    `[${type.toUpperCase()}] ${msg}`
  );

  fs.appendFileSync(
    LOG_FILE,
    JSON.stringify(entry) + "\n"
  );
}

// --------------------------------------------------
// TRADEVINE OAUTH
// --------------------------------------------------

const oauth = OAuth({
  consumer: {
    key: process.env.TV_CONSUMER_KEY,
    secret: process.env.TV_CONSUMER_SECRET,
  },

  signature_method: "HMAC-SHA1",

  hash_function: (base, key) =>
    crypto
      .createHmac("sha1", key)
      .update(base)
      .digest("base64"),
});

const token = {
  key: process.env.TV_ACCESS_TOKEN,
  secret: process.env.TV_ACCESS_TOKEN_SECRET,
};

// --------------------------------------------------
// STATE
// --------------------------------------------------

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
    log(
      "error",
      `Could not read state file: ${err.message}`
    );

    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      state,
      null,
      2
    )
  );
}

// --------------------------------------------------
// SHOPIFY LISTING RESULTS
// --------------------------------------------------

function getShopifyResultForCycle(
  code,
  poNumber
) {
  if (
    !fs.existsSync(
      SHOPIFY_LISTING_RESULTS_FILE
    )
  ) {
    return null;
  }

  try {
    const data = JSON.parse(
      fs.readFileSync(
        SHOPIFY_LISTING_RESULTS_FILE,
        "utf8"
      )
    );

    if (!Array.isArray(data)) {
      return null;
    }

    const targetCode = String(
      code || ""
    )
      .trim()
      .toUpperCase();

    const targetPO = String(
      poNumber || ""
    )
      .trim()
      .toUpperCase();

    let latest = null;

    data.forEach((run) => {
      if (
        !Array.isArray(
          run.products
        )
      ) {
        return;
      }

      run.products.forEach((item) => {
        const itemCode = String(
          item.productCode || ""
        )
          .trim()
          .toUpperCase();

        if (
          itemCode !== targetCode
        ) {
          return;
        }

        /*
         * Shopify listing results should contain
         * the PO number for cycle-based processing.
         *
         * Support several possible field names so
         * older result files do not break.
         */
        const itemPO = String(
          item.poNumber ||
            item.PONumber ||
            item.po ||
            run.poNumber ||
            run.PONumber ||
            ""
        )
          .trim()
          .toUpperCase();

        /*
         * IMPORTANT:
         *
         * If a PO is available in the result,
         * require it to match the requested cycle.
         */
        if (
          targetPO &&
          itemPO &&
          itemPO !== targetPO
        ) {
          return;
        }

        /*
         * If we are resolving a specific PO but
         * the result has no PO information, do
         * not use it as cycle confirmation.
         */
        if (
          targetPO &&
          !itemPO
        ) {
          return;
        }

        const detectedAt =
          item.date ||
          item.timestamp ||
          run.date ||
          run.timestamp ||
          null;

        if (!latest) {
          latest = {
            ...item,
            date: detectedAt,
            poNumber:
              itemPO ||
              null,
          };

          return;
        }

        const latestTime =
          new Date(
            latest.date || 0
          ).getTime();

        const newTime =
          new Date(
            detectedAt || 0
          ).getTime();

        if (
          newTime >= latestTime
        ) {
          latest = {
            ...item,
            date: detectedAt,
            poNumber:
              itemPO ||
              null,
          };
        }
      });
    });

    return latest;
  } catch (err) {
    log(
      "error",
      `Could not read Shopify listing results: ${err.message}`
    );

    return null;
  }
}

// --------------------------------------------------
// CHECK CYCLE STATE
// --------------------------------------------------

function isShopifyCycleAlreadyListed(
  code,
  poNumber
) {
  const state = loadState();

  const stateKey =
    `shopify-listed:${poNumber}:${code}`;

  const entry =
    state[stateKey];

  if (
    entry &&
    typeof entry === "object"
  ) {
    log(
      "success",
      `${code}: Shopify cycle already successfully listed for ${poNumber}`
    );

    log(
      "info",
      `${code}: found state key ${stateKey}`
    );

    return true;
  }

  return false;
}

// --------------------------------------------------
// RUN SHOPIFY OLD LISTING + VERIFY RESULT
// --------------------------------------------------

function runShopifyOldListing(
  code,
  poNumber
) {
  const scriptPath = path.join(
    __dirname,
    "test-shopify-old-listing.js"
  );

  if (
    !fs.existsSync(
      scriptPath
    )
  ) {
    log(
      "error",
      `${code}: test-shopify-old-listing.js not found`
    );

    return {
      ok: false,
      reason: "script_not_found",
    };
  }

  // ------------------------------------------------
  // FIRST CHECK:
  // IS THIS EXACT PO + PRODUCT ALREADY LISTED?
  // ------------------------------------------------

  if (
    isShopifyCycleAlreadyListed(
      code,
      poNumber
    )
  ) {
    return {
      ok: true,
      status: "listed",
      reason: "already_listed_for_current_cycle",
    };
  }

  log(
    "info",
    `${code}: Shopify cycle ${poNumber} is not yet recorded as listed - retrying Shopify old listing`
  );

  // ------------------------------------------------
  // RUN LISTING SCRIPT WITH PRODUCT + PO
  // ------------------------------------------------

  const result = spawnSync(
    process.execPath,
    [
      scriptPath,
      code,
      poNumber,
    ],
    {
      cwd: __dirname,

      encoding: "utf8",

      stdio: "pipe",

      env: {
        ...process.env,
      },

      windowsHide: false,
    }
  );

  // ------------------------------------------------
  // SHOW STDOUT
  // ------------------------------------------------

  if (
    result.stdout
  ) {
    console.log(
      result.stdout
    );

    log(
      "info",
      `${code}: shopify-old-listing stdout:\n${result.stdout.slice(
        0,
        10000
      )}`
    );
  }

  // ------------------------------------------------
  // SHOW STDERR
  // ------------------------------------------------

  if (
    result.stderr
  ) {
    console.error(
      result.stderr
    );

    log(
      "error",
      `${code}: shopify-old-listing stderr:\n${result.stderr.slice(
        0,
        10000
      )}`
    );
  }

  // ------------------------------------------------
  // PROCESS START ERROR
  // ------------------------------------------------

  if (
    result.error
  ) {
    log(
      "error",
      `${code}: could not start test-shopify-old-listing.js - ${result.error.message}`
    );

    return {
      ok: false,
      reason: "script_start_error",
      error: result.error.message,
    };
  }

  // ------------------------------------------------
  // PROCESS EXIT CODE
  // ------------------------------------------------

  if (
    result.status !== 0
  ) {
    log(
      "error",
      `${code}: test-shopify-old-listing.js failed with exit code ${result.status}`
    );

    /*
     * IMPORTANT:
     *
     * The listing script can return a non-zero
     * result even though the cycle may have been
     * successfully recorded before the process
     * finished.
     *
     * Therefore verify the exact cycle state
     * one more time before declaring failure.
     */

    if (
      isShopifyCycleAlreadyListed(
        code,
        poNumber
      )
    ) {
      log(
        "success",
        `${code}: listing script returned ${result.status}, but ${poNumber} + ${code} is confirmed listed in processed-state`
      );

      return {
        ok: true,
        status: "listed",
        reason: "state_confirmed_after_nonzero_exit",
      };
    }

    return {
      ok: false,
      reason: "script_failed",
      exitCode: result.status,
    };
  }

  log(
    "success",
    `${code}: test-shopify-old-listing.js completed with exit code 0`
  );

  // ------------------------------------------------
  // VERIFY EXACT CYCLE STATE
  // ------------------------------------------------

  if (
    isShopifyCycleAlreadyListed(
      code,
      poNumber
    )
  ) {
    log(
      "success",
      `${code}: ${poNumber} + ${code} confirmed successfully listed`
    );

    return {
      ok: true,
      status: "listed",
    };
  }

  // ------------------------------------------------
  // VERIFY RESULT FILE
  // ------------------------------------------------

  const latestResult =
    getShopifyResultForCycle(
      code,
      poNumber
    );

  if (
    !latestResult
  ) {
    log(
      "error",
      `${code}: Shopify listing script completed but no result was found for ${code} + ${poNumber}`
    );

    return {
      ok: false,
      reason: "no_result_for_cycle",
    };
  }

  // ------------------------------------------------
  // VERIFY PRODUCT WAS ACTUALLY LISTED
  // ------------------------------------------------

  if (
    latestResult.status !==
    "listed"
  ) {
    log(
      "warn",
      `${code}: Shopify listing result for ${poNumber} is "${latestResult.status}" - reason: ${
        latestResult.reason ||
        "unknown"
      }`
    );

    return {
      ok: false,
      reason:
        latestResult.reason ||
        "listing_still_blocked",

      status:
        latestResult.status,

      result:
        latestResult,
    };
  }

  // ------------------------------------------------
  // SUCCESS
  // ------------------------------------------------

  log(
    "success",
    `${code}: Shopify listing result confirms ${poNumber} + ${code} was successfully listed`
  );

  return {
    ok: true,
    status: "listed",
    result:
      latestResult,
  };
}

// --------------------------------------------------
// TRADEVINE GET
// --------------------------------------------------

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

  const res =
    await fetch(
      url,
      {
        method: "GET",

        headers: {
          ...authHeader,
          Accept:
            "application/json",
        },
      }
    );

  const text =
    await res.text();

  return JSONbig.parse(
    text
  );
}

// --------------------------------------------------
// MARK RESOLVED
// --------------------------------------------------

async function markResolved(
  code,
  poNumber,
  supplierName,
  reason,
  source
) {
  code = String(
    code
  )
    .trim()
    .toUpperCase();

  poNumber = String(
    poNumber || ""
  ).trim();

  reason = String(
    reason || ""
  ).trim();

  source = String(
    source || ""
  )
    .trim()
    .toLowerCase();

  log(
    "info",
    `${code}: resolving blocked product. Source: ${
      source || "unknown"
    }, Reason: ${
      reason || "unknown"
    }, PO: ${
      poNumber || "unknown"
    }`
  );

  // ------------------------------------------------
  // SHOPIFY LISTING BLOCK
  // ------------------------------------------------

  if (
    source ===
      "shopify-listing" ||
    source ===
      "shopify"
  ) {
    log(
      "info",
      `${code}: block originated from Shopify listing - checking current cycle ${poNumber}`
    );

    const listingResult =
      runShopifyOldListing(
        code,
        poNumber
      );

    // ------------------------------------------------
    // RETRY FAILED OR PRODUCT STILL BLOCKED
    // ------------------------------------------------

    if (
      !listingResult.ok
    ) {
      log(
        "error",
        `${code}: Shopify listing retry did not resolve the block - product remains blocked`
      );

      log(
        "warn",
        `${code}: NOT marking Shopify blocked record as resolved`
      );

      return false;
    }

    // ------------------------------------------------
    // PRODUCT WAS ALREADY OR ACTUALLY LISTED
    // ------------------------------------------------

    log(
      "success",
      `${code}: Shopify listing block successfully resolved for PO ${poNumber}`
    );

    log(
      "success",
      `${code}: Shopify listing verification confirmed status = listed`
    );

    return true;
  }

  // --------------------------------------------------
  // BOM AUTOMATION BLOCK
  // --------------------------------------------------

  if (
    source ===
    "bom-automation"
  ) {
    log(
      "info",
      `${code}: block originated from BOM automation`
    );
  }

  // --------------------------------------------------
  // CHECK TRADEVINE PRODUCT
  // --------------------------------------------------

  const url =
    `https://api.tradevine.com/v1/Product?code=${encodeURIComponent(
      code
    )}&pageSize=5`;

  const data =
    await apiGet(
      url
    );

  const products =
    data.List ||
    data.list ||
    data;

  const product =
    Array.isArray(
      products
    )
      ? products.find(
          (p) =>
            String(
              p.Code || ""
            )
              .trim()
              .toUpperCase() ===
            code
        )
      : null;

  if (
    !product
  ) {
    log(
      "error",
      `${code}: Tradevine product not found`
    );

    return false;
  }

  // --------------------------------------------------
  // CHECK DS TITLE
  // --------------------------------------------------

  if (
    !product.Name ||
    !product.Name.startsWith(
      "DS "
    )
  ) {
    log(
      "warn",
      `${code}: title is "${product.Name}" - doesn't start with "DS ", staff needs to fix this first`
    );

    return false;
  }

  // --------------------------------------------------
  // UPDATE BOM STATE
  // --------------------------------------------------

  const state =
    loadState();

  const now =
    new Date().toISOString();

  state[
    `inv:${poNumber}:${code}`
  ] = {
    done: true,
    date: now,
    supplier:
      supplierName ||
      null,

    note:
      "manually actioned by staff",
  };

  state[
    `title:${code}`
  ] = {
    done: true,
    date: now,
    supplier:
      supplierName ||
      null,

    note:
      "manually actioned by staff",
  };

  // --------------------------------------------------
  // REMOVE BOM BLOCK
  // --------------------------------------------------

  if (
    state[
      `blocked:${code}`
    ]
  ) {
    delete state[
      `blocked:${code}`
    ];

    log(
      "info",
      `${code}: cleared BOM blocked queue`
    );
  }

  saveState(
    state
  );

  log(
    "success",
    `${code}: BOM block marked as resolved. Now tracked for future graduation checks.`
  );

  return true;
}

// --------------------------------------------------
// COMMAND LINE
// --------------------------------------------------

const [
  ,
  ,
  code,
  poNumber,
  supplierName,
  reason,
  source,
] = process.argv;

if (
  !code ||
  !poNumber
) {
  console.log(
    'Usage: node resolve-blocked.js <ProductCode> <PONumber> "<SupplierName>" "<Reason>" "<Source>"'
  );

  process.exit(1);
}

markResolved(
  code,
  poNumber,
  supplierName,
  reason,
  source
)
  .then(
    (success) => {
      process.exit(
        success
          ? 0
          : 1
      );
    }
  )
  .catch(
    (err) => {
      console.error(
        "Crashed:",
        err
      );

      process.exit(
        1
      );
    }
  );

