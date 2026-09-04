require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const OAuth = require("oauth-1.0a");
const crypto = require("crypto");
const JSONbig = require("json-bigint")({
  storeAsString: true,
});

const app = express();
const PORT = Number(process.env.PORT) || 3456;

// ==================================================
// BASE PATHS
// ==================================================
//
// dashboard.js is located in the PROJECT ROOT.
//
// Example:
//
// D:\tsb-presale-live\
// ├── dashboard.js
// ├── dashboard/
// │   └── index.html
// ├── AKL/
// │   ├── auto-remove-presale.js
// │   ├── bom-automation.js
// │   ├── remove-blocked.js
// │   ├── set-delivery-metafiled.js
// │   ├── shopify-old-listing.js
// │   ├── test-shopify-old-listing.js
// │   └── warehouse-assignment.js
// ├── WLG/
// ├── CHCH/
// └── json/
//     ├── AKL/
//     ├── WLG/
//     └── CHCH/
//
// ==================================================

const ROOT_DIR = path.resolve(__dirname);

const JSON_DIR = path.join(
  ROOT_DIR,
  "json"
);

const DASHBOARD_DIR = path.join(
  ROOT_DIR,
  "dashboard"
);

const AUTOMATION_LOG = path.join(
  ROOT_DIR,
  "automation.log"
);


// ==================================================
// FILE HELPERS
// ==================================================

function firstExistingPath(
  candidates,
  fallback
) {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return fallback;
}


function ensureParentDirectory(
  filePath
) {
  const directory =
    path.dirname(filePath);

  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, {
      recursive: true,
    });
  }
}


function fileExists(
  filePath
) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}


// ==================================================
// STORE CONFIGURATION
// ==================================================
//
// AKL
// ----
// Shopify enabled.
// All AKL automation scripts live inside /AKL.
//
// WLG
// ----
// No Shopify.
//
// CHCH
// ----
// No Shopify.
//
// ==================================================

const STORES = {

  // ==================================================
  // AKL
  // ==================================================

  akl: {

    key: "akl",

    name: "Auckland",

    shortName: "AKL",


    // ----------------------------------------------
    // STATE
    // ----------------------------------------------

    stateFile: path.join(
      JSON_DIR,
      "AKL",
      "processed-state.json"
    ),

    graduationFile: path.join(
      JSON_DIR,
      "AKL",
      "graduated-this-week.json"
    ),

    shopifyListingResultsFile: path.join(
      JSON_DIR,
      "AKL",
      "shopify-listing-results.json"
    ),

    shopifyResolvedFile: path.join(
      JSON_DIR,
      "AKL",
      "shopify-resolved.json"
    ),

    logFile: AUTOMATION_LOG,


    // ----------------------------------------------
    // SHOPIFY
    // ----------------------------------------------

    shopifyEnabled: true,

    shopifyTag:
      "Pre-Order-Auckland",

    shopifyMetafieldNamespace:
      "stock",

    shopifyMetafieldKey:
      "akl_arriving_date",


    // ----------------------------------------------
    // TRADEVINE
    // ----------------------------------------------

    tvConsumerKey:
      process.env.TV_CONSUMER_KEY,

    tvConsumerSecret:
      process.env.TV_CONSUMER_SECRET,

    tvAccessToken:
      process.env.TV_ACCESS_TOKEN,

    tvAccessTokenSecret:
      process.env.TV_ACCESS_TOKEN_SECRET,


    // ----------------------------------------------
    // SHOPIFY CREDENTIALS
    // ----------------------------------------------

    shopifyStore:
      process.env.SHOPIFY_STORE,

    shopifyToken:
      process.env.SHOPIFY_ACCESS_TOKEN,


    // ----------------------------------------------
    // AKL AUTOMATION SCRIPTS
    // ----------------------------------------------

    automationScript:
      firstExistingPath(
        [
          path.join(
            ROOT_DIR,
            "AKL",
            "bom-automation.js"
          ),
        ],
        path.join(
          ROOT_DIR,
          "AKL",
          "bom-automation.js"
        )
      ),

    resolveScript:
      firstExistingPath(
        [
          path.join(
            ROOT_DIR,
            "AKL",
            "resolve-blocked.js"
          ),
        ],
        path.join(
          ROOT_DIR,
          "AKL",
          "resolve-blocked.js"
        )
      ),

    cleanupScript:
      firstExistingPath(
        [
          path.join(
            ROOT_DIR,
            "AKL",
            "auto-remove-presale.js"
          ),
        ],
        path.join(
          ROOT_DIR,
          "AKL",
          "auto-remove-presale.js"
        )
      ),

    deliveryScript:
      firstExistingPath(
        [
          path.join(
            ROOT_DIR,
            "AKL",
            "set-delivery-metafiled.js"
          ),
        ],
        path.join(
          ROOT_DIR,
          "AKL",
          "set-delivery-metafiled.js"
        )
      ),

    shopifyListingScript:
      firstExistingPath(
        [
          path.join(
            ROOT_DIR,
            "AKL",
            "shopify-old-listing.js"
          ),
        ],
        path.join(
          ROOT_DIR,
          "AKL",
          "shopify-old-listing.js"
        )
      ),
  },


  // ==================================================
  // WLG
  // ==================================================

  wlg: {

    key: "wlg",

    name: "Wellington",

    shortName: "WLG",


    // ----------------------------------------------
    // STATE
    // ----------------------------------------------

    stateFile: path.join(
      JSON_DIR,
      "WLG",
      "processed-state-wlg.json"
    ),

    graduationFile: path.join(
      JSON_DIR,
      "WLG",
      "graduated-this-week-wlg.json"
    ),

    logFile: path.join(
      ROOT_DIR,
      "WLG",
      "automation-wlg.log"
    ),


    // ----------------------------------------------
    // SHOPIFY
    // ----------------------------------------------

    shopifyEnabled: false,

    shopifyTag: null,

    shopifyMetafieldNamespace: null,

    shopifyMetafieldKey: null,

    shopifyListingResultsFile: null,

    shopifyResolvedFile: null,


    // ----------------------------------------------
    // TRADEVINE
    // ----------------------------------------------

    tvConsumerKey:
      process.env.WLG_TV_CONSUMER_KEY,

    tvConsumerSecret:
      process.env.WLG_TV_CONSUMER_SECRET,

    tvAccessToken:
      process.env.WLG_TV_ACCESS_TOKEN,

    tvAccessTokenSecret:
      process.env.WLG_TV_ACCESS_TOKEN_SECRET,


    // ----------------------------------------------
    // AUTOMATION
    // ----------------------------------------------

    automationScript:
      firstExistingPath(
        [
          path.join(
            ROOT_DIR,
            "WLG",
            "bom-automation-wlg.js"
          ),

          path.join(
            ROOT_DIR,
            "WLG",
            "bom-automation.js"
          ),
        ],
        path.join(
          ROOT_DIR,
          "WLG",
          "bom-automation-wlg.js"
        )
      ),

    resolveScript:
      firstExistingPath(
        [
          path.join(
            ROOT_DIR,
            "WLG",
            "resolve-blocked-wlg.js"
          ),

          path.join(
            ROOT_DIR,
            "WLG",
            "resolve-blocked.js"
          ),
        ],
        path.join(
          ROOT_DIR,
          "WLG",
          "resolve-blocked-wlg.js"
        )
      ),
  },


  // ==================================================
  // CHCH
  // ==================================================

  chch: {

    key: "chch",

    name: "Christchurch",

    shortName: "CHCH",


    // ----------------------------------------------
    // STATE
    // ----------------------------------------------

    stateFile: path.join(
      JSON_DIR,
      "CHCH",
      "processed-state-chch.json"
    ),

    graduationFile: path.join(
      JSON_DIR,
      "CHCH",
      "graduated-this-week-chch.json"
    ),

    logFile: path.join(
      ROOT_DIR,
      "CHCH",
      "automation-chch.log"
    ),


    // ----------------------------------------------
    // SHOPIFY
    // ----------------------------------------------

    shopifyEnabled: false,

    shopifyTag: null,

    shopifyMetafieldNamespace: null,

    shopifyMetafieldKey: null,

    shopifyListingResultsFile: null,

    shopifyResolvedFile: null,


    // ----------------------------------------------
    // TRADEVINE
    // ----------------------------------------------

    tvConsumerKey:
      process.env.CHCH_TV_CONSUMER_KEY,

    tvConsumerSecret:
      process.env.CHCH_TV_CONSUMER_SECRET,

    tvAccessToken:
      process.env.CHCH_TV_ACCESS_TOKEN,

    tvAccessTokenSecret:
      process.env.CHCH_TV_ACCESS_TOKEN_SECRET,


    // ----------------------------------------------
    // AUTOMATION
    // ----------------------------------------------

    automationScript:
      firstExistingPath(
        [
          path.join(
            ROOT_DIR,
            "CHCH",
            "bom-automation-chch.js"
          ),

          path.join(
            ROOT_DIR,
            "CHCH",
            "bom-automation.js"
          ),
        ],
        path.join(
          ROOT_DIR,
          "CHCH",
          "bom-automation-chch.js"
        )
      ),

    resolveScript:
      firstExistingPath(
        [
          path.join(
            ROOT_DIR,
            "CHCH",
            "resolve-blocked-chch.js"
          ),

          path.join(
            ROOT_DIR,
            "CHCH",
            "resolve-blocked.js"
          ),
        ],
        path.join(
          ROOT_DIR,
          "CHCH",
          "resolve-blocked-chch.js"
        )
      ),
  },
};


// ==================================================
// EXPRESS
// ==================================================

app.use(cors());

app.use(
  express.json({
    limit: "2mb",
  })
);


// ==================================================
// STATIC DASHBOARD
// ==================================================

app.use(
  express.static(
    DASHBOARD_DIR
  )
);


// ==================================================
// STORE HELPERS
// ==================================================

function getStore(
  storeKey
) {
  const key =
    String(
      storeKey || "akl"
    )
      .trim()
      .toLowerCase();

  if (key === "all") {
    return null;
  }

  return (
    STORES[key] ||
    STORES.akl
  );
}


function getAllStores() {
  return Object.values(
    STORES
  );
}


// ==================================================
// STATE
// ==================================================

function loadState(
  store
) {
  if (!store) {
    console.error(
      "loadState: store is missing"
    );

    return {};
  }

  console.log(
    `[STATE READ] ${store.shortName} -> ${store.stateFile}`
  );

  if (!fileExists(store.stateFile)) {
    console.warn(
      `[STATE MISSING] ${store.shortName} -> ${store.stateFile}`
    );

    return {};
  }

  try {
    const raw =
      fs.readFileSync(
        store.stateFile,
        "utf8"
      );

    if (!raw.trim()) {
      return {};
    }

    const state =
      JSON.parse(raw);

    if (
      !state ||
      typeof state !== "object" ||
      Array.isArray(state)
    ) {
      console.error(
        `[STATE INVALID] ${store.shortName} state is not an object`
      );

      return {};
    }

    console.log(
      `[STATE LOADED] ${store.shortName} -> ${
        Object.keys(state).length
      } records`
    );

    return state;

  } catch (err) {
    console.error(
      `[STATE ERROR] ${store.shortName} -> ${store.stateFile}: ${err.message}`
    );

    return {};
  }
}


function saveState(
  store,
  state
) {
  if (
    !store ||
    !store.stateFile
  ) {
    throw new Error(
      "Store state file is not configured."
    );
  }

  ensureParentDirectory(
    store.stateFile
  );

  fs.writeFileSync(
    store.stateFile,
    JSON.stringify(
      state,
      null,
      2
    ),
    "utf8"
  );

  console.log(
    `[STATE SAVED] ${store.shortName} -> ${store.stateFile}`
  );
}


// ==================================================
// SHOPIFY RESOLVED RECORDS
// ==================================================

function loadShopifyResolved(
  store
) {
  if (
    !store ||
    !store.shopifyEnabled ||
    !store.shopifyResolvedFile ||
    !fileExists(
      store.shopifyResolvedFile
    )
  ) {
    return {};
  }

  try {
    const data =
      JSON.parse(
        fs.readFileSync(
          store.shopifyResolvedFile,
          "utf8"
        )
      );

    return (
      data &&
      typeof data === "object" &&
      !Array.isArray(data)
    )
      ? data
      : {};

  } catch (err) {
    console.error(
      `Could not read ${store.shortName} Shopify resolved file:`,
      err.message
    );

    return {};
  }
}


function saveShopifyResolved(
  store,
  data
) {
  if (
    !store ||
    !store.shopifyEnabled ||
    !store.shopifyResolvedFile
  ) {
    return;
  }

  ensureParentDirectory(
    store.shopifyResolvedFile
  );

  fs.writeFileSync(
    store.shopifyResolvedFile,
    JSON.stringify(
      data,
      null,
      2
    ),
    "utf8"
  );
}


function markShopifyBlockResolved(
  store,
  code
) {
  if (
    !store.shopifyEnabled
  ) {
    return;
  }

  const resolved =
    loadShopifyResolved(
      store
    );

  const normalisedCode =
    String(code)
      .trim()
      .toUpperCase();

  resolved[
    normalisedCode
  ] = new Date().toISOString();

  saveShopifyResolved(
    store,
    resolved
  );

  logEvent(
    store,
    "info",
    `${normalisedCode}: Shopify blocked record marked as resolved`
  );
}


// ==================================================
// SHOPIFY LISTING BLOCKED PRODUCTS
// ==================================================

function loadShopifyListingBlockedProducts(
  store
) {
  if (
    !store ||
    !store.shopifyEnabled ||
    !store.shopifyListingResultsFile ||
    !fileExists(
      store.shopifyListingResultsFile
    )
  ) {
    return [];
  }

  try {
    const data =
      JSON.parse(
        fs.readFileSync(
          store.shopifyListingResultsFile,
          "utf8"
        )
      );

    if (
      !Array.isArray(data)
    ) {
      return [];
    }

    const resolved =
      loadShopifyResolved(
        store
      );

    const latest =
      new Map();

    data.forEach(
      (run) => {
        if (
          !Array.isArray(
            run.products
          )
        ) {
          return;
        }

        run.products.forEach(
          (item) => {
            if (
              !item.productCode
            ) {
              return;
            }

            const code =
              String(
                item.productCode
              )
                .trim()
                .toUpperCase();

            const detectedAt =
              item.date ||
              run.date ||
              null;

            const record = {
              code,

              poNumber:
                item.poNumber ||
                "—",

              supplier:
                item.supplier ||
                "—",

              reason:
                item.reason ||
                "unknown",

              missing:
                Array.isArray(
                  item.missing
                )
                  ? item.missing
                  : [],

              error:
                item.error ||
                null,

              detectedAt,

              source:
                "shopify-listing",

              status:
                item.status,

              store:
                store.key,

              storeName:
                store.name,
            };

            const existing =
              latest.get(code);

            if (!existing) {
              latest.set(
                code,
                record
              );

              return;
            }

            const existingTime =
              new Date(
                existing.detectedAt ||
                  0
              ).getTime();

            const newTime =
              new Date(
                record.detectedAt ||
                  0
              ).getTime();

            if (
              newTime >=
              existingTime
            ) {
              latest.set(
                code,
                record
              );
            }
          }
        );
      }
    );

    const results = [];

    latest.forEach(
      (item, code) => {
        if (
          item.status !==
          "blocked"
        ) {
          return;
        }

        const resolvedAt =
          resolved[code];

        if (resolvedAt) {
          const blockedTime =
            new Date(
              item.detectedAt ||
                0
            ).getTime();

          const resolvedTime =
            new Date(
              resolvedAt
            ).getTime();

          if (
            !Number.isNaN(
              resolvedTime
            ) &&
            !Number.isNaN(
              blockedTime
            ) &&
            blockedTime <=
              resolvedTime
          ) {
            return;
          }
        }

        results.push(item);
      }
    );

    return results;

  } catch (err) {
    console.error(
      `Could not read ${store.shortName} Shopify listing results:`,
      err.message
    );

    return [];
  }
}


// ==================================================
// GRADUATIONS
// ==================================================

function loadGraduations(
  store
) {
  if (
    !store ||
    !store.graduationFile ||
    !fileExists(
      store.graduationFile
    )
  ) {
    return [];
  }

  try {
    const data =
      JSON.parse(
        fs.readFileSync(
          store.graduationFile,
          "utf8"
        )
      );

    return Array.isArray(data)
      ? data
      : [];

  } catch (err) {
    console.error(
      `Could not read ${store.shortName} graduation file:`,
      err.message
    );

    return [];
  }
}


// ==================================================
// LOGS
// ==================================================

function loadLogs(
  store
) {
  if (
    !store ||
    !store.logFile ||
    !fileExists(
      store.logFile
    )
  ) {
    return [];
  }

  try {
    return fs
      .readFileSync(
        store.logFile,
        "utf8"
      )
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(
            line
          );
        } catch {
          return {
            time: null,

            type: "info",

            msg: line,

            store:
              store.key,
          };
        }
      })
      .reverse();

  } catch (err) {
    console.error(
      `Could not read ${store.shortName} log:`,
      err.message
    );

    return [];
  }
}


// ==================================================
// LOG EVENT
// ==================================================

function logEvent(
  store,
  type,
  msg
) {
  const entry = {
    time:
      new Date().toISOString(),

    type,

    msg,

    store:
      store?.key ||
      "unknown",
  };

  console.log(
    `[${type.toUpperCase()}] [${
      store?.shortName ||
      "UNKNOWN"
    }] ${msg}`
  );

  const logFile =
    store?.logFile ||
    AUTOMATION_LOG;

  ensureParentDirectory(
    logFile
  );

  fs.appendFileSync(
    logFile,
    JSON.stringify(
      entry
    ) + "\n",
    "utf8"
  );
}


// ==================================================
// TRADEVINE OAUTH
// ==================================================

function createOAuth(
  store
) {
  return OAuth({
    consumer: {
      key:
        store.tvConsumerKey,

      secret:
        store.tvConsumerSecret,
    },

    signature_method:
      "HMAC-SHA1",

    hash_function: (
      base,
      key
    ) =>
      crypto
        .createHmac(
          "sha1",
          key
        )
        .update(base)
        .digest("base64"),
  });
}


// ==================================================
// TRADEVINE GET
// ==================================================

async function tradevineGet(
  store,
  url
) {
  const oauth =
    createOAuth(
      store
    );

  const token = {
    key:
      store.tvAccessToken,

    secret:
      store.tvAccessTokenSecret,
  };

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

  const response =
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
    await response.text();

  let data = null;

  try {
    data =
      JSONbig.parse(
        text
      );
  } catch {
    data = null;
  }

  return {
    status:
      response.status,

    data,

    raw:
      text,
  };
}


// ==================================================
// TRADEVINE — PURCHASE ORDERS
// ==================================================

async function getAwaitingReceiptPOs(
  store
) {
  try {
    const url =
      "https://api.tradevine.com/v1/PurchaseOrder" +
      "?pageNumber=1" +
      "&pageSize=500" +
      "&status=19001";

    const result =
      await tradevineGet(
        store,
        url
      );

    if (
      result.status !== 200 ||
      !result.data
    ) {
      console.error(
        `${store.shortName} PurchaseOrder lookup failed:`,
        result.status,
        result.raw?.slice(
          0,
          500
        )
      );

      return {
        count: 0,

        orders: [],

        error: true,
      };
    }

    const list =
      result.data.List ||
      result.data.list ||
      [];

    return {
      count:
        result.data.TotalCount ??
        list.length,

      orders:
        list.map(
          (po) => ({
            orderNumber:
              po.OrderNumber ||
              "—",

            supplier:
              po.Supplier?.Name ||
              "—",

            requiredDeliveryDate:
              po.RequiredDeliveryDate ||
              null,

            status:
              po.Status,

            purchaseOrderId:
              po.PurchaseOrderID
                ? String(
                    po.PurchaseOrderID
                  )
                : null,
          })
        ),

      error: false,
    };

  } catch (err) {
    console.error(
      `Could not retrieve ${store.shortName} awaiting POs:`,
      err.message
    );

    return {
      count: 0,

      orders: [],

      error: true,
    };
  }
}


// ==================================================
// PRODUCT CODE EXTRACTION
// ==================================================

function extractProductCodesFromText(
  text
) {
  if (!text) {
    return [];
  }

  const matches =
    text.match(
      /\bPR\d+(?:-[A-Z0-9]+)?\b/gi
    ) || [];

  return matches.map(
    (code) =>
      code.toUpperCase()
  );
}


// ==================================================
// LAST AUTOMATION RUN
// ==================================================

function getLastRun(
  logs
) {
  const runMessages = [
    "automation run",
    "bom-automation",
    "automation started",
    "presale automation",
    "checking",
    "found",
    "presale cleanup",
    "delivery metafield",
    "remove-presale",
    "graduated",
  ];

  for (
    const entry of logs
  ) {
    if (!entry.time) {
      continue;
    }

    const msg =
      String(
        entry.msg || ""
      ).toLowerCase();

    if (
      runMessages.some(
        (term) =>
          msg.includes(term)
      )
    ) {
      return entry.time;
    }
  }

  return null;
}


// ==================================================
// PROCESSED PRODUCTS
// ==================================================

function getProcessedProducts(
  state,
  logs
) {
  const products =
    new Set();

  if (
    !state ||
    typeof state !==
      "object"
  ) {
    return products;
  }

  Object.entries(
    state
  ).forEach(
    ([key, value]) => {
      if (
        !key.startsWith(
          "inv:"
        )
      ) {
        return;
      }

      if (
        !value ||
        value.done !== true
      ) {
        return;
      }

      const parts =
        key.split(":");

      if (
        parts.length >= 3
      ) {
        const productCode =
          parts
            .slice(2)
            .join(":")
            .trim()
            .toUpperCase();

        if (
          productCode
        ) {
          products.add(
            productCode
          );
        }
      }
    }
  );


  // ----------------------------------------------
  // GRADUATED PRODUCTS
  // ----------------------------------------------

  if (
    Array.isArray(logs)
  ) {
    logs.forEach(
      (entry) => {
        const msg =
          entry?.msg || "";

        if (
          /graduated/i.test(
            msg
          )
        ) {
          const codes =
            extractProductCodesFromText(
              msg
            );

          codes.forEach(
            (code) =>
              products.add(
                code
              )
          );
        }
      }
    );
  }

  return products;
}


// ==================================================
// PROCESSED PRODUCT DETAILS
// ==================================================

function getProcessedProductDetails(
  store
) {
  const state =
    loadState(
      store
    );

  const products =
    new Map();

  if (
    !state ||
    typeof state !==
      "object"
  ) {
    return [];
  }


  // ----------------------------------------------
  // INVENTORY
  // ----------------------------------------------

  Object.entries(
    state
  ).forEach(
    ([key, value]) => {
      if (
        !key.startsWith(
          "inv:"
        )
      ) {
        return;
      }

      if (
        !value ||
        value.done !== true
      ) {
        return;
      }

      const parts =
        key.split(":");

      if (
        parts.length < 3
      ) {
        return;
      }

      const poNumber =
        parts[1] || "—";

      const code =
        parts
          .slice(2)
          .join(":")
          .trim()
          .toUpperCase();

      if (!code) {
        return;
      }

      products.set(
        code,
        {
          code,

          poNumber,

          supplier:
            value.supplier ||
            "—",

          store:
            store.key,

          storeName:
            store.name,

          type:
            "Inventory",

          status:
            "Processed",

          date:
            value.date ||
            null,
        }
      );
    }
  );


  // ----------------------------------------------
  // TITLE
  // ----------------------------------------------

  Object.entries(
    state
  ).forEach(
    ([key, value]) => {
      if (
        !key.startsWith(
          "title:"
        )
      ) {
        return;
      }

      if (
        !value ||
        value.done !== true
      ) {
        return;
      }

      const code =
        key
          .replace(
            /^title:/,
            ""
          )
          .trim()
          .toUpperCase();

      if (!code) {
        return;
      }

      if (
        !products.has(
          code
        )
      ) {
        products.set(
          code,
          {
            code,

            poNumber:
              "—",

            supplier:
              value.supplier ||
              "—",

            store:
              store.key,

            storeName:
              store.name,

            type:
              "Title",

            status:
              "Processed",

            date:
              value.date ||
              null,
          }
        );
      }
    }
  );


  // ----------------------------------------------
  // BOM
  // ----------------------------------------------

  Object.entries(
    state
  ).forEach(
    ([key, value]) => {
      if (
        !key.startsWith(
          "bom:"
        )
      ) {
        return;
      }

      if (
        !value ||
        value.done !== true
      ) {
        return;
      }

      const code =
        key
          .replace(
            /^bom:/,
            ""
          )
          .trim()
          .toUpperCase();

      if (!code) {
        return;
      }

      if (
        !products.has(
          code
        )
      ) {
        products.set(
          code,
          {
            code,

            poNumber:
              "—",

            supplier:
              value.supplier ||
              "—",

            store:
              store.key,

            storeName:
              store.name,

            type:
              "BOM",

            status:
              "Processed",

            date:
              value.date ||
              null,
          }
        );
      }
    }
  );


  return Array.from(
    products.values()
  ).sort(
    (a, b) =>
      a.code.localeCompare(
        b.code
      )
  );
}


// ==================================================
// BOM BLOCKED PRODUCTS
// ==================================================

function getBomBlockedProducts(
  store,
  state
) {
  return Object.entries(
    state
  )
    .filter(
      ([key]) =>
        key.startsWith(
          "blocked:"
        )
    )
    .map(
      ([key, value]) => ({
        code:
          key
            .replace(
              "blocked:",
              ""
            )
            .trim()
            .toUpperCase(),

        poNumber:
          value?.poNumber ||
          "—",

        supplier:
          value?.supplier ||
          "—",

        reason:
          value?.reason ||
          "unknown",

        missing:
          Array.isArray(
            value?.missing
          )
            ? value.missing
            : [],

        error:
          value?.error ||
          null,

        detectedAt:
          value?.detectedAt ||
          value?.date ||
          null,

        source:
          "bom-automation",

        store:
          store.key,

        storeName:
          store.name,
      })
    );
}


// ==================================================
// ALL BLOCKED PRODUCTS
// ==================================================

function getAllBlockedProducts(
  store,
  state
) {
  const bomBlocked =
    getBomBlockedProducts(
      store,
      state
    );

  const shopifyBlocked =
    store.shopifyEnabled
      ? loadShopifyListingBlockedProducts(
          store
        )
      : [];


  // ------------------------------------------------
  // IMPORTANT
  // ------------------------------------------------
  //
  // BOM and Shopify blocks are separate records.
  //
  // Example:
  //
  // PR15301 | BOM
  // PR15301 | Shopify
  //
  // Both remain visible.
  //

  const combined = [
    ...bomBlocked,
    ...shopifyBlocked,
  ];

  return combined.sort(
    (a, b) =>
      new Date(
        b.detectedAt || 0
      ).getTime() -
      new Date(
        a.detectedAt || 0
      ).getTime()
  );
}


// ==================================================
// RUN REMOVE-BLOCKED
// ==================================================

function runResolveBlocked(
  store,
  code,
  poNumber,
  supplierName,
  reason,
  source
) {
  const scriptPath =
    store.resolveScript;

  if (
    !fileExists(
      scriptPath
    )
  ) {
    logEvent(
      store,
      "error",
      `${code}: resolve script not found at ${scriptPath}`
    );

    return false;
  }


  logEvent(
    store,
    "info",
    `${code}: STARTING ${path.basename(
      scriptPath
    )}`
  );


  logEvent(
    store,
    "info",
    `${code}: resolve script path = ${scriptPath}`
  );


  logEvent(
    store,
    "info",
    `${code}: PO = ${poNumber}, source = ${
      source || "unknown"
    }, reason = ${
      reason || "unknown"
    }`
  );


  let result;

  try {
    result =
      spawnSync(
        process.execPath,
        [
          scriptPath,

          code,

          poNumber,

          supplierName ||
            "",

          reason ||
            "",

          source ||
            "",
        ],
        {
          cwd:
            ROOT_DIR,

          encoding:
            "utf8",

          env: {
            ...process.env,
          },

          windowsHide:
            false,

          stdio: [
            "ignore",
            "pipe",
            "pipe",
          ],
        }
      );

  } catch (err) {
    logEvent(
      store,
      "error",
      `${code}: resolve script spawn crashed - ${err.message}`
    );

    return false;
  }


  if (
    result.stdout
  ) {
    console.log(
      `\n========== ${store.shortName} ${code} RESOLVE STDOUT ==========\n`
    );

    console.log(
      result.stdout
    );

    console.log(
      `\n========== END ${store.shortName} ${code} STDOUT ==========\n`
    );

    logEvent(
      store,
      "info",
      `${code}: resolve script stdout:\n${result.stdout.slice(
        0,
        10000
      )}`
    );
  }


  if (
    result.stderr
  ) {
    console.error(
      `\n========== ${store.shortName} ${code} RESOLVE STDERR ==========\n`
    );

    console.error(
      result.stderr
    );

    console.error(
      `\n========== END ${store.shortName} ${code} STDERR ==========\n`
    );

    logEvent(
      store,
      "error",
      `${code}: resolve script stderr:\n${result.stderr.slice(
        0,
        10000
      )}`
    );
  }


  if (
    result.error
  ) {
    logEvent(
      store,
      "error",
      `${code}: could not start resolve script - ${result.error.message}`
    );

    return false;
  }


  if (
    result.status !== 0
  ) {
    logEvent(
      store,
      "error",
      `${code}: resolve script FAILED with exit code ${result.status}`
    );

    return false;
  }


  logEvent(
    store,
    "success",
    `${code}: resolve script completed successfully`
  );

  return true;
}


// ==================================================
// OVERVIEW BUILDER
// ==================================================

async function buildStoreOverview(
  store
) {
  const state =
    loadState(
      store
    );

  const logs =
    loadLogs(
      store
    );

  const awaiting =
    await getAwaitingReceiptPOs(
      store
    );

  const processedProducts =
    getProcessedProducts(
      state,
      logs
    );

  const blockedProducts =
    getAllBlockedProducts(
      store,
      state
    );

  const graduations =
    loadGraduations(
      store
    );

  const weekAgo =
    Date.now() -
    7 *
      24 *
      60 *
      60 *
      1000;

  const graduatedThisWeek =
    graduations.filter(
      (entry) => {
        const dateValue =
          entry?.date ||
          entry?.graduatedAt ||
          entry?.completedAt ||
          entry?.timestamp;

        const time =
          new Date(
            dateValue
          ).getTime();

        return (
          !Number.isNaN(
            time
          ) &&
          time >=
            weekAgo
        );
      }
    ).length;


  const lastRun =
    getLastRun(
      logs
    );

  const processed =
    processedProducts.size;

  const blocked =
    blockedProducts.length;

  const healthRate =
    processed > 0
      ? Math.max(
          0,
          Math.min(
            100,
            Math.round(
              ((processed -
                blocked) /
                processed) *
                100
            )
          )
        )
      : 100;


  return {
    store:
      store.key,

    storeName:
      store.name,

    storeShortName:
      store.shortName,

    posAwaiting:
      awaiting.count,

    productsProcessed:
      processed,

    blocked,

    graduatedThisWeek,

    lastRun,

    healthRate,

    poError:
      awaiting.error,

    automationScript:
      path.relative(
        ROOT_DIR,
        store.automationScript
      ),

    automationScriptExists:
      fileExists(
        store.automationScript
      ),

    resolveScript:
      path.relative(
        ROOT_DIR,
        store.resolveScript
      ),

    resolveScriptExists:
      fileExists(
        store.resolveScript
      ),

    cleanupScript:
      store.cleanupScript
        ? path.relative(
            ROOT_DIR,
            store.cleanupScript
          )
        : null,

    cleanupScriptExists:
      store.cleanupScript
        ? fileExists(
            store.cleanupScript
          )
        : false,

    deliveryScript:
      store.deliveryScript
        ? path.relative(
            ROOT_DIR,
            store.deliveryScript
          )
        : null,

    deliveryScriptExists:
      store.deliveryScript
        ? fileExists(
            store.deliveryScript
          )
        : false,

    shopifyListingScript:
      store.shopifyListingScript
        ? path.relative(
            ROOT_DIR,
            store.shopifyListingScript
          )
        : null,

    shopifyListingScriptExists:
      store.shopifyListingScript
        ? fileExists(
            store.shopifyListingScript
          )
        : false,

    stateFile:
      path.relative(
        ROOT_DIR,
        store.stateFile
      ),

    stateFileExists:
      fileExists(
        store.stateFile
      ),

    graduationFile:
      path.relative(
        ROOT_DIR,
        store.graduationFile
      ),

    graduationFileExists:
      fileExists(
        store.graduationFile
      ),

    shopifyEnabled:
      store.shopifyEnabled,

    generatedAt:
      new Date().toISOString(),
  };
}


// ==================================================
// API — OVERVIEW
// ==================================================

app.get(
  "/api/overview",
  async (
    req,
    res
  ) => {
    try {
      const requestedStore =
        String(
          req.query.store ||
            "akl"
        )
          .trim()
          .toLowerCase();

      if (
        requestedStore ===
        "all"
      ) {
        const result = {};

        for (
          const store of getAllStores()
        ) {
          result[
            store.key
          ] =
            await buildStoreOverview(
              store
            );
        }

        return res.json({
          stores:
            result,

          generatedAt:
            new Date().toISOString(),
        });
      }

      const store =
        getStore(
          requestedStore
        );

      const overview =
        await buildStoreOverview(
          store
        );

      return res.json(
        overview
      );

    } catch (err) {
      console.error(
        "Overview error:",
        err
      );

      return res.status(
        500
      ).json({
        error:
          err.message,
      });
    }
  }
);


// ==================================================
// API — ALL STORE OVERVIEW
// ==================================================

app.get(
  "/api/overview/all",
  async (
    req,
    res
  ) => {
    try {
      const result = {};

      for (
        const store of getAllStores()
      ) {
        result[
          store.key
        ] =
          await buildStoreOverview(
            store
          );
      }

      return res.json({
        stores:
          result,

        generatedAt:
          new Date().toISOString(),
      });

    } catch (err) {
      console.error(
        "All-store overview error:",
        err
      );

      return res.status(
        500
      ).json({
        error:
          err.message,
      });
    }
  }
);


// ==================================================
// API — GRADUATIONS
// ==================================================

app.get(
  "/api/graduations",
  (
    req,
    res
  ) => {
    try {
      const requestedStore =
        String(
          req.query.store ||
            "akl"
        )
          .trim()
          .toLowerCase();

      if (
        requestedStore ===
        "all"
      ) {
        const results = [];

        getAllStores().forEach(
          (store) => {
            const graduations =
              loadGraduations(
                store
              );

            const weekAgo =
              Date.now() -
              7 *
                24 *
                60 *
                60 *
                1000;

            graduations
              .filter(
                (entry) => {
                  const dateValue =
                    entry?.date ||
                    entry?.graduatedAt ||
                    entry?.completedAt ||
                    entry?.timestamp;

                  const time =
                    new Date(
                      dateValue
                    ).getTime();

                  return (
                    !Number.isNaN(
                      time
                    ) &&
                    time >=
                      weekAgo
                  );
                }
              )
              .forEach(
                (entry) => {
                  results.push({
                    ...entry,

                    store:
                      store.key,

                    storeName:
                      store.name,
                  });
                }
              );
          }
        );

        return res.json(
          results
        );
      }

      const store =
        getStore(
          requestedStore
        );

      const graduations =
        loadGraduations(
          store
        );

      const weekAgo =
        Date.now() -
        7 *
          24 *
          60 *
          60 *
          1000;

      const recent =
        graduations.filter(
          (entry) => {
            const dateValue =
              entry?.date ||
              entry?.graduatedAt ||
              entry?.completedAt ||
              entry?.timestamp;

            const time =
              new Date(
                dateValue
              ).getTime();

            return (
              !Number.isNaN(
                time
              ) &&
              time >=
                weekAgo
            );
          }
        );

      return res.json(
        recent.map(
          (entry) => ({
            ...entry,

            store:
              store.key,

            storeName:
              store.name,
          })
        )
      );

    } catch (err) {
      console.error(
        "Graduations error:",
        err
      );

      return res.status(
        500
      ).json({
        error:
          err.message,
      });
    }
  }
);


// ==================================================
// API — PURCHASE ORDERS
// ==================================================

app.get(
  "/api/purchase-orders",
  async (
    req,
    res
  ) => {
    try {
      const requestedStore =
        String(
          req.query.store ||
            "akl"
        )
          .trim()
          .toLowerCase();

      // --------------------------------------------
      // ALL STORES
      // --------------------------------------------

      if (
        requestedStore ===
        "all"
      ) {
        const results = [];

        for (
          const store of getAllStores()
        ) {
          const result =
            await getAwaitingReceiptPOs(
              store
            );

          results.push(
            ...result.orders.map(
              (order) => ({
                ...order,

                store:
                  store.key,

                storeName:
                  store.name,
              })
            )
          );
        }

        return res.json({
          count:
            results.length,

          orders:
            results,

          error: false,
        });
      }


      // --------------------------------------------
      // SINGLE STORE
      // --------------------------------------------

      const store =
        getStore(
          requestedStore
        );

      const result =
        await getAwaitingReceiptPOs(
          store
        );

      return res.json({
        ...result,

        store:
          store.key,

        storeName:
          store.name,
      });

    } catch (err) {
      console.error(
        "Purchase order error:",
        err
      );

      return res.status(
        500
      ).json({
        error:
          err.message,

        orders: [],

        count: 0,
      });
    }
  }
);


// ==================================================
// API — STATE
// ==================================================

app.get(
  "/api/state",
  (
    req,
    res
  ) => {
    try {
      const requestedStore =
        String(
          req.query.store ||
            "akl"
        )
          .trim()
          .toLowerCase();

      if (
        requestedStore ===
        "all"
      ) {
        const states = {};

        getAllStores().forEach(
          (store) => {
            states[
              store.key
            ] =
              loadState(
                store
              );
          }
        );

        return res.json(
          states
        );
      }

      const store =
        getStore(
          requestedStore
        );

      return res.json(
        loadState(
          store
        )
      );

    } catch (err) {
      return res.status(
        500
      ).json({
        error:
          err.message,
      });
    }
  }
);


// ==================================================
// API — PRODUCTS
// ==================================================

app.get(
  "/api/products",
  (
    req,
    res
  ) => {
    try {
      const requestedStore =
        String(
          req.query.store ||
            "akl"
        )
          .trim()
          .toLowerCase();


      if (
        requestedStore ===
        "all"
      ) {
        const allProducts =
          [];

        getAllStores().forEach(
          (store) => {
            const products =
              getProcessedProductDetails(
                store
              );

            allProducts.push(
              ...products
            );
          }
        );


        const unique =
          new Map();

        allProducts.forEach(
          (product) => {
            const key =
              `${product.store}:${product.code}`;

            if (
              !unique.has(
                key
              )
            ) {
              unique.set(
                key,
                product
              );
            }
          }
        );


        return res.json(
          Array.from(
            unique.values()
          ).sort(
            (a, b) =>
              a.code.localeCompare(
                b.code
              )
          )
        );
      }


      const store =
        getStore(
          requestedStore
        );

      return res.json(
        getProcessedProductDetails(
          store
        )
      );

    } catch (err) {
      console.error(
        "Products error:",
        err
      );

      return res.status(
        500
      ).json({
        error:
          err.message,
      });
    }
  }
);


// ==================================================
// API — BLOCKED
// ==================================================

app.get(
  "/api/blocked",
  (
    req,
    res
  ) => {
    try {
      const requestedStore =
        String(
          req.query.store ||
            "akl"
        )
          .trim()
          .toLowerCase();


      if (
        requestedStore ===
        "all"
      ) {
        const result = [];

        getAllStores().forEach(
          (store) => {
            const state =
              loadState(
                store
              );

            result.push(
              ...getAllBlockedProducts(
                store,
                state
              )
            );
          }
        );

        result.sort(
          (a, b) =>
            new Date(
              b.detectedAt || 0
            ).getTime() -
            new Date(
              a.detectedAt || 0
            ).getTime()
        );

        return res.json(
          result
        );
      }


      const store =
        getStore(
          requestedStore
        );

      const state =
        loadState(
          store
        );

      const result =
        getAllBlockedProducts(
          store,
          state
        );

      return res.json(
        result
      );

    } catch (err) {
      console.error(
        "Blocked products error:",
        err
      );

      return res.status(
        500
      ).json({
        error:
          err.message,
      });
    }
  }
);


// ==================================================
// API — LOGS
// ==================================================

app.get(
  "/api/logs",
  (
    req,
    res
  ) => {
    try {
      const requestedStore =
        String(
          req.query.store ||
            "akl"
        )
          .trim()
          .toLowerCase();


      if (
        requestedStore ===
        "all"
      ) {
        const allLogs =
          [];

        getAllStores().forEach(
          (store) => {
            allLogs.push(
              ...loadLogs(
                store
              )
            );
          }
        );


        allLogs.sort(
          (a, b) =>
            new Date(
              b.time || 0
            ).getTime() -
            new Date(
              a.time || 0
            ).getTime()
        );


        return res.json(
          allLogs.slice(
            0,
            200
          )
        );
      }


      const store =
        getStore(
          requestedStore
        );

      return res.json(
        loadLogs(
          store
        ).slice(
          0,
          200
        )
      );

    } catch (err) {
      return res.status(
        500
      ).json({
        error:
          err.message,
      });
    }
  }
);


// ==================================================
// API — MARK RESOLVED
// ==================================================

app.post(
  "/api/resolve",
  (
    req,
    res
  ) => {
    try {
      const {
        code,
        poNumber,
        supplierName,
        reason,
        source,
        store:
          requestedStore,
      } = req.body || {};


      if (
        !code ||
        !poNumber
      ) {
        return res.status(
          400
        ).json({
          ok: false,

          error:
            "Product code and PO number are required.",
        });
      }


      const requested =
        String(
          requestedStore ||
            "akl"
        )
          .trim()
          .toLowerCase();


      if (
        requested ===
        "all"
      ) {
        return res.status(
          400
        ).json({
          ok: false,

          error:
            "A specific store is required to resolve a product.",
        });
      }


      const store =
        getStore(
          requested
        );


      const normalisedCode =
        String(code)
          .trim()
          .toUpperCase();


      const normalisedSource =
        String(
          source || ""
        )
          .trim()
          .toLowerCase();


      const normalisedReason =
        String(
          reason || ""
        )
          .trim()
          .toLowerCase();


      logEvent(
        store,
        "info",
        `${normalisedCode}: Mark Resolved clicked for ${store.shortName}`
      );


      // ==================================================
      // SHOPIFY BLOCK
      // ==================================================

      if (
        store.shopifyEnabled &&
        (
          normalisedSource ===
            "shopify-listing" ||
          normalisedSource ===
            "shopify"
        )
      ) {
        logEvent(
          store,
          "info",
          `${normalisedCode}: Shopify block resolved from dashboard - starting ${path.basename(
            store.resolveScript
          )}`
        );


        const success =
          runResolveBlocked(
            store,
            normalisedCode,
            poNumber,
            supplierName,
            reason,
            normalisedSource
          );


        if (!success) {
          logEvent(
            store,
            "error",
            `${normalisedCode}: Shopify resolve script failed - block remains active`
          );

          return res.status(
            500
          ).json({
            ok: false,

            code:
              normalisedCode,

            store:
              store.key,

            source:
              "shopify-listing",

            error:
              "Shopify listing retry failed. Product remains blocked.",
          });
        }


        markShopifyBlockResolved(
          store,
          normalisedCode
        );


        logEvent(
          store,
          "success",
          `${normalisedCode}: Shopify resolve completed successfully`
        );


        return res.json({
          ok: true,

          code:
            normalisedCode,

          store:
            store.key,

          source:
            "shopify-listing",

          message:
            `${store.shortName} Shopify block resolved successfully.`,
        });
      }


      // ==================================================
      // BOM BLOCK
      // ==================================================

      const state =
        loadState(
          store
        );

      const now =
        new Date().toISOString();


      delete state[
        `blocked:${normalisedCode}`
      ];


      // ----------------------------------------------
      // IMPORTANT
      // ----------------------------------------------
      //
      // PO remains part of the inventory key.
      //
      // This allows the same product to enter a new
      // presale cycle under a NEW PO.
      //
      // ----------------------------------------------

      state[
        `inv:${poNumber}:${normalisedCode}`
      ] = {
        done: true,

        date:
          now,

        supplier:
          supplierName ||
          null,

        note:
          "manually actioned by staff via dashboard",
      };


      state[
        `title:${normalisedCode}`
      ] = {
        done: true,

        date:
          now,

        supplier:
          supplierName ||
          null,

        note:
          "manually actioned by staff via dashboard",
      };


      saveState(
        store,
        state
      );


      logEvent(
        store,
        "success",
        `Staff resolved ${normalisedCode} BOM block via ${store.shortName} dashboard`
      );


      return res.json({
        ok: true,

        code:
          normalisedCode,

        store:
          store.key,

        source:
          "bom-automation",

        message:
          `${normalisedCode} BOM block resolved successfully.`,
      });

    } catch (err) {
      console.error(
        "Resolve error:",
        err
      );


      const store =
        getStore(
          req.body?.store
        );


      logEvent(
        store,
        "error",
        `Resolve endpoint crashed: ${err.message}`
      );


      return res.status(
        500
      ).json({
        ok: false,

        error:
          err.message,
      });
    }
  }
);


// ==================================================
// START STORE AUTOMATION
// ==================================================

function startStoreAutomation(
  store
) {
  const scriptPath =
    store.automationScript;


  // ----------------------------------------------
  // VERIFY SCRIPT
  // ----------------------------------------------

  if (
    !fileExists(
      scriptPath
    )
  ) {
    logEvent(
      store,
      "error",
      `Automation script not found: ${scriptPath}`
    );


    return {
      ok: false,

      store:
        store.key,

      storeName:
        store.name,

      error:
        `${store.shortName} automation script not found: ${scriptPath}`,
    };
  }


  // ----------------------------------------------
  // LOG PATH
  // ----------------------------------------------

  logEvent(
    store,
    "info",
    `Starting ${store.shortName} automation`
  );


  logEvent(
    store,
    "info",
    `Automation script path = ${scriptPath}`
  );


  // ----------------------------------------------
  // SPAWN
  // ----------------------------------------------

  try {
    const child =
      spawn(
        process.execPath,
        [
          scriptPath,
        ],
        {
          cwd:
            ROOT_DIR,

          detached:
            true,

          stdio:
            "ignore",

          windowsHide:
            true,

          env: {
            ...process.env,
          },
        }
      );


    child.unref();


    logEvent(
      store,
      "info",
      `Manual ${path.basename(
        scriptPath
      )} run triggered from dashboard`
    );


    return {
      ok: true,

      store:
        store.key,

      storeName:
        store.name,

      pid:
        child.pid,

      script:
        path.relative(
          ROOT_DIR,
          scriptPath
        ),
    };

  } catch (err) {
    logEvent(
      store,
      "error",
      `Could not start ${store.shortName} automation: ${err.message}`
    );


    return {
      ok: false,

      store:
        store.key,

      storeName:
        store.name,

      error:
        err.message,
    };
  }
}


// ==================================================
// API — RUN NOW
// ==================================================

app.post(
  "/api/run-now",
  (
    req,
    res
  ) => {
    try {
      const requestedStore =
        String(
          req.query.store ||
            req.body?.store ||
            "akl"
        )
          .trim()
          .toLowerCase();


      // ==================================================
      // ALL STORES
      // ==================================================

      if (
        requestedStore ===
        "all"
      ) {
        const results =
          [];

        for (
          const store of getAllStores()
        ) {
          const result =
            startStoreAutomation(
              store
            );

          results.push(
            result
          );
        }


        const failed =
          results.filter(
            (result) =>
              !result.ok
          );


        logEvent(
          STORES.akl,
          "info",
          "Manual ALL STORES automation run triggered from dashboard"
        );


        if (
          failed.length ===
          results.length
        ) {
          return res.status(
            500
          ).json({
            ok: false,

            store:
              "all",

            results,

            error:
              "Could not start any store automation.",
          });
        }


        return res.json({
          ok: true,

          store:
            "all",

          results,

          message:
            failed.length > 0
              ? "Some store automations failed to start."
              : "AKL, WLG and CHCH automation started successfully.",
        });
      }


      // ==================================================
      // SINGLE STORE
      // ==================================================

      const store =
        getStore(
          requestedStore
        );


      const result =
        startStoreAutomation(
          store
        );


      if (
        !result.ok
      ) {
        return res.status(
          500
        ).json(
          result
        );
      }


      return res.json({
        ok: true,

        store:
          store.key,

        storeName:
          store.name,

        pid:
          result.pid,

        script:
          result.script,

        message:
          `${store.shortName} automation started successfully.`,
      });

    } catch (err) {
      console.error(
        "Run-now error:",
        err
      );


      return res.status(
        500
      ).json({
        ok: false,

        error:
          err.message,
      });
    }
  }
);


// ==================================================
// API — STORE CONFIGURATION
// ==================================================

app.get(
  "/api/stores",
  (
    req,
    res
  ) => {
    res.json(
      getAllStores().map(
        (store) => ({
          key:
            store.key,

          name:
            store.name,

          shortName:
            store.shortName,

          shopifyEnabled:
            store.shopifyEnabled,

          shopifyTag:
            store.shopifyTag,

          metafield:
            store.shopifyEnabled &&
            store.shopifyMetafieldNamespace &&
            store.shopifyMetafieldKey
              ? `${store.shopifyMetafieldNamespace}.${store.shopifyMetafieldKey}`
              : null,


          automationScript:
            path.relative(
              ROOT_DIR,
              store.automationScript
            ),

          automationScriptExists:
            fileExists(
              store.automationScript
            ),


          resolveScript:
            path.relative(
              ROOT_DIR,
              store.resolveScript
            ),

          resolveScriptExists:
            fileExists(
              store.resolveScript
            ),


          cleanupScript:
            store.cleanupScript
              ? path.relative(
                  ROOT_DIR,
                  store.cleanupScript
                )
              : null,

          cleanupScriptExists:
            store.cleanupScript
              ? fileExists(
                  store.cleanupScript
                )
              : false,


          deliveryScript:
            store.deliveryScript
              ? path.relative(
                  ROOT_DIR,
                  store.deliveryScript
                )
              : null,

          deliveryScriptExists:
            store.deliveryScript
              ? fileExists(
                  store.deliveryScript
                )
              : false,


          shopifyListingScript:
            store.shopifyListingScript
              ? path.relative(
                  ROOT_DIR,
                  store.shopifyListingScript
                )
              : null,

          shopifyListingScriptExists:
            store.shopifyListingScript
              ? fileExists(
                  store.shopifyListingScript
                )
              : false,


          stateFile:
            path.relative(
              ROOT_DIR,
              store.stateFile
            ),

          stateFileExists:
            fileExists(
              store.stateFile
            ),


          graduationFile:
            path.relative(
              ROOT_DIR,
              store.graduationFile
            ),

          graduationFileExists:
            fileExists(
              store.graduationFile
            ),
        })
      )
    );
  }
);


// ==================================================
// API — PATH DIAGNOSTICS
// ==================================================

app.get(
  "/api/paths",
  (
    req,
    res
  ) => {
    const stores =
      {};

    getAllStores().forEach(
      (store) => {
        stores[
          store.key
        ] = {

          automationScript:
            store.automationScript,

          automationScriptExists:
            fileExists(
              store.automationScript
            ),


          resolveScript:
            store.resolveScript,

          resolveScriptExists:
            fileExists(
              store.resolveScript
            ),


          cleanupScript:
            store.cleanupScript,

          cleanupScriptExists:
            store.cleanupScript
              ? fileExists(
                  store.cleanupScript
                )
              : false,


          deliveryScript:
            store.deliveryScript,

          deliveryScriptExists:
            store.deliveryScript
              ? fileExists(
                  store.deliveryScript
                )
              : false,


          shopifyListingScript:
            store.shopifyListingScript,

          shopifyListingScriptExists:
            store.shopifyListingScript
              ? fileExists(
                  store.shopifyListingScript
                )
              : false,


          stateFile:
            store.stateFile,

          stateFileExists:
            fileExists(
              store.stateFile
            ),


          graduationFile:
            store.graduationFile,

          graduationFileExists:
            fileExists(
              store.graduationFile
            ),


          logFile:
            store.logFile,

          logFileExists:
            fileExists(
              store.logFile
            ),


          shopifyEnabled:
            store.shopifyEnabled,
        };
      }
    );


    res.json({
      rootDir:
        ROOT_DIR,

      dashboardDir:
        DASHBOARD_DIR,

      dashboardIndex:
        path.join(
          DASHBOARD_DIR,
          "index.html"
        ),

      dashboardIndexExists:
        fileExists(
          path.join(
            DASHBOARD_DIR,
            "index.html"
          )
        ),

      jsonDir:
        JSON_DIR,

      stores,

      generatedAt:
        new Date().toISOString(),
    });
  }
);


// ==================================================
// API — HEALTH
// ==================================================

app.get(
  "/api/health",
  (
    req,
    res
  ) => {
    res.json({
      ok: true,

      service:
        "TSB Pre-sale Automation Dashboard",

      rootDir:
        ROOT_DIR,

      stores:
        getAllStores().map(
          (store) =>
            store.shortName
        ),

      timestamp:
        new Date().toISOString(),
    });
  }
);


// ==================================================
// ROOT
// ==================================================

app.get(
  "/",
  (
    req,
    res
  ) => {
    const indexPath =
      path.join(
        DASHBOARD_DIR,
        "index.html"
      );


    if (
      !fileExists(
        indexPath
      )
    ) {
      return res.status(
        500
      ).send(
        `
        <h1>Dashboard file not found</h1>
        <p>Expected:</p>
        <pre>${indexPath}</pre>
        `
      );
    }


    res.sendFile(
      indexPath
    );
  }
);


// ==================================================
// 404 API HANDLER
// ==================================================

app.use(
  "/api",
  (
    req,
    res
  ) => {
    res.status(
      404
    ).json({
      error:
        "API endpoint not found",

      path:
        req.originalUrl,
    });
  }
);


// ==================================================
// GLOBAL ERROR HANDLER
// ==================================================

app.use(
  (
    err,
    req,
    res,
    next
  ) => {
    console.error(
      "Unhandled dashboard error:",
      err
    );


    if (
      res.headersSent
    ) {
      return next(
        err
      );
    }


    res.status(
      500
    ).json({
      ok: false,

      error:
        err.message ||
        "Internal server error",
    });
  }
);


// ==================================================
// START SERVER
// ==================================================

const server = app.listen(
  PORT,
  () => {
    console.log("");
    console.log("==============================================");
    console.log(" TSB PRE-SALE DASHBOARD");
    console.log("==============================================");
    console.log(` Dashboard: http://localhost:${PORT}/`);
    console.log(` API:       http://localhost:${PORT}/api/overview`);
    console.log("");

    console.log(" ROOT");
    console.log(` ${ROOT_DIR}`);
    console.log("");

    console.log(" STORES");
    console.log(" --------------------------------------------");

    getAllStores().forEach((store) => {
      console.log(` ${store.shortName} → ${store.name}`);

      console.log(
        `    Automation: ${store.automationScript}`
      );

      console.log(
        `    Exists:     ${fileExists(
          store.automationScript
        )}`
      );

      if (store.resolveScript) {
        console.log(
          `    Resolve:    ${store.resolveScript}`
        );

        console.log(
          `    Exists:     ${fileExists(
            store.resolveScript
          )}`
        );
      }

      if (store.cleanupScript) {
        console.log(
          `    Cleanup:    ${store.cleanupScript}`
        );

        console.log(
          `    Exists:     ${fileExists(
            store.cleanupScript
          )}`
        );
      }

      if (store.deliveryScript) {
        console.log(
          `    Delivery:   ${store.deliveryScript}`
        );

        console.log(
          `    Exists:     ${fileExists(
            store.deliveryScript
          )}`
        );
      }

      if (store.shopifyListingScript) {
        console.log(
          `    Shopify:    ${store.shopifyListingScript}`
        );

        console.log(
          `    Exists:     ${fileExists(
            store.shopifyListingScript
          )}`
        );
      }

      console.log(
        `    State:      ${store.stateFile}`
      );

      console.log(
        `    Exists:     ${fileExists(
          store.stateFile
        )}`
      );

      console.log("");
    });

    console.log(
      " --------------------------------------------"
    );

    console.log(
      "=============================================="
    );

    console.log("");

    console.log(
      "✓ Dashboard server is running."
    );

    console.log(
      "✓ Waiting for requests..."
    );

    console.log("");
  }
);


// ==================================================
// SERVER ERROR HANDLER
// ==================================================

server.on("error", (err) => {
  console.error("");
  console.error("==============================================");
  console.error(" DASHBOARD SERVER ERROR");
  console.error("==============================================");
  console.error(err);
  console.error("");

  if (err.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already being used by another process.`
    );
  }

  process.exitCode = 1;
});


// ==================================================
// PROCESS DEBUG
// ==================================================

process.on("exit", (code) => {
  console.log(
    `\n[PROCESS EXIT] dashboard-server.js exited with code ${code}`
  );
});

process.on("SIGINT", () => {
  console.log("\n[PROCESS] SIGINT received.");
  server.close(() => {
    console.log("[PROCESS] Dashboard server closed.");
    process.exit(0);
  });
});

process.on("SIGTERM", () => {
  console.log("\n[PROCESS] SIGTERM received.");
  server.close(() => {
    console.log("[PROCESS] Dashboard server closed.");
    process.exit(0);
  });
});