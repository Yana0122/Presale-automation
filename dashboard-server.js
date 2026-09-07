require("dotenv").config();

const express = require("express");
const cors = require("cors");
const session = require("express-session");
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
// DASHBOARD AUTHENTICATION
// ==================================================

const DASHBOARD_USERNAME =
  process.env.DASHBOARD_USERNAME;

const DASHBOARD_PASSWORD =
  process.env.DASHBOARD_PASSWORD;

const SESSION_SECRET =
  process.env.SESSION_SECRET;

if (
  !DASHBOARD_USERNAME ||
  !DASHBOARD_PASSWORD ||
  !SESSION_SECRET
) {
  console.error(
    "ERROR: Dashboard authentication environment variables are missing."
  );

  console.error("Required:");
  console.error("DASHBOARD_USERNAME");
  console.error("DASHBOARD_PASSWORD");
  console.error("SESSION_SECRET");

  process.exit(1);
}

// ==================================================
// BASE PATHS
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

// --------------------------------------------------
// MAIN DASHBOARD LOGS
// --------------------------------------------------
//
// These files contain SHORT structured operational
// events only.
//
// Raw automation stdout/stderr is stored separately
// under debug-logs/.
//
// --------------------------------------------------

const AUTOMATION_LOG = path.join(
  ROOT_DIR,
  "automation.log"
);

const DEBUG_LOG_DIR = path.join(
  ROOT_DIR,
  "debug-logs"
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

    logFile:
      AUTOMATION_LOG,

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
            "set-delivery-metafield.js"
          ),

          // Backwards-compatible fallback
          path.join(
            ROOT_DIR,
            "AKL",
            "set-delivery-metafiled.js"
          ),
        ],
        path.join(
          ROOT_DIR,
          "AKL",
          "set-delivery-metafield.js"
        )
      ),

    // IMPORTANT:
    // This is the confirmed correct AKL Shopify
    // listing script.
    shopifyListingScript:
      firstExistingPath(
        [
          path.join(
            ROOT_DIR,
            "AKL",
            "test-shopify-old-listing.js"
          ),
        ],
        path.join(
          ROOT_DIR,
          "AKL",
          "test-shopify-old-listing.js"
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

    shopifyEnabled:
      false,

    shopifyTag:
      null,

    shopifyMetafieldNamespace:
      null,

    shopifyMetafieldKey:
      null,

    shopifyListingResultsFile:
      null,

    shopifyResolvedFile:
      null,

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

    cleanupScript:
      null,

    deliveryScript:
      firstExistingPath(
        [
          path.join(
            ROOT_DIR,
            "WLG",
            "set-delivery-metafield-wlg.js"
          ),
        ],
        path.join(
          ROOT_DIR,
          "WLG",
          "set-delivery-metafield-wlg.js"
        )
      ),

    shopifyListingScript:
      null,
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

    shopifyEnabled:
      false,

    shopifyTag:
      null,

    shopifyMetafieldNamespace:
      null,

    shopifyMetafieldKey:
      null,

    shopifyListingResultsFile:
      null,

    shopifyResolvedFile:
      null,

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

    cleanupScript:
      null,

    deliveryScript:
      firstExistingPath(
        [
          path.join(
            ROOT_DIR,
            "CHCH",
            "set-delivery-metafield-chch.js"
          ),
        ],
        path.join(
          ROOT_DIR,
          "CHCH",
          "set-delivery-metafield-chch.js"
        )
      ),

    shopifyListingScript:
      null,
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

app.use(
  express.urlencoded({
    extended: false,
  })
);

// ==================================================
// SESSION
// ==================================================

if (
  process.env.NODE_ENV ===
  "production"
) {
  app.set(
    "trust proxy",
    1
  );
}

app.use(
  session({
    name:
      "tsb_dashboard_session",

    secret:
      SESSION_SECRET,

    resave:
      false,

    saveUninitialized:
      false,

    cookie: {
      httpOnly:
        true,

      secure:
        process.env.NODE_ENV ===
        "production",

      sameSite:
        "lax",

      maxAge:
        8 *
        60 *
        60 *
        1000,
    },
  })
);

// ==================================================
// AUTHENTICATION HELPERS
// ==================================================

function isAuthenticated(
  req
) {
  return (
    req.session &&
    req.session.authenticated ===
      true
  );
}

// ==================================================
// LOGIN PAGE
// ==================================================

app.get(
  "/login",
  (
    req,
    res
  ) => {

    if (
      isAuthenticated(req)
    ) {
      return res.redirect("/");
    }

    const hasError =
      req.query.error === "1";

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>

        <title>
          TSB Presale Automation Dashboard Login
        </title>

        <meta
          name="viewport"
          content="width=device-width, initial-scale=1"
        >

        <style>

          body {
            margin: 0;
            font-family: Arial, sans-serif;
            background: #f5f5f5;

            display: flex;
            align-items: center;
            justify-content: center;

            min-height: 100vh;
          }

          .login-box {
            width: 350px;
            background: white;

            padding: 30px;

            border-radius: 10px;

            box-shadow:
              0 5px 25px rgba(0, 0, 0, 0.12);
          }

          h2 {
            margin-top: 0;
            margin-bottom: 25px;

            text-align: center;
          }

          input {
            width: 100%;
            box-sizing: border-box;

            padding: 12px;

            margin-bottom: 15px;

            border: 1px solid #ccc;
            border-radius: 5px;

            font-size: 15px;
          }

          button {
            width: 100%;

            padding: 12px;

            border: none;
            border-radius: 5px;

            background: #111;
            color: white;

            font-size: 15px;

            cursor: pointer;
          }

          button:hover {
            background: #333;
          }

          .error {
            color: #c00;

            text-align: center;

            margin-bottom: 15px;
          }

        </style>

      </head>

      <body>

        <div class="login-box">

          <h2>
            TSB Presale Dashboard
          </h2>

          ${
            hasError
              ? `
                <div class="error">
                  Invalid username or password.
                </div>
              `
              : ""
          }

          <form
            method="POST"
            action="/login"
          >

            <input
              type="text"
              name="username"
              placeholder="Username"
              required
              autofocus
            />

            <input
              type="password"
              name="password"
              placeholder="Password"
              required
            />

            <button type="submit">
              Login
            </button>

          </form>

        </div>

      </body>
      </html>
    `);
  }
);

// ==================================================
// AUTHENTICATION MIDDLEWARE
// ==================================================

function requireAuthentication(
  req,
  res,
  next
) {

  if (
    req.path ===
    "/login"
  ) {
    return next();
  }

  if (
    isAuthenticated(req)
  ) {
    return next();
  }

  if (
    req.path.startsWith(
      "/api/"
    )
  ) {
    return res.status(401).json({
      ok:
        false,

      authenticated:
        false,

      error:
        "Authentication required.",
    });
  }

  return res.redirect(
    "/login"
  );
}

// ==================================================
// LOGIN SUBMISSION
// ==================================================

app.post(
  "/login",
  (
    req,
    res
  ) => {

    const username =
      String(
        req.body?.username ||
          ""
      ).trim();

    const password =
      String(
        req.body?.password ||
          ""
      );

    if (
      username !==
        DASHBOARD_USERNAME ||
      password !==
        DASHBOARD_PASSWORD
    ) {
      return res.redirect(
        "/login?error=1"
      );
    }

    req.session.authenticated =
      true;

    req.session.username =
      username;

    req.session.loginTime =
      new Date().toISOString();

    return res.redirect("/");
  }
);

// ==================================================
// LOGOUT
// ==================================================

app.post(
  "/logout",
  (
    req,
    res
  ) => {

    req.session.destroy(
      (err) => {

        if (err) {

          console.error(
            "Logout error:",
            err
          );

          return res.status(
            500
          ).send(
            "Could not log out."
          );
        }

        res.clearCookie(
          "tsb_dashboard_session"
        );

        return res.redirect(
          "/login"
        );
      }
    );
  }
);

// ==================================================
// STATIC DASHBOARD
// ==================================================

app.use(
  requireAuthentication
);

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
      storeKey ||
        "akl"
    )
      .trim()
      .toLowerCase();

  if (
    key ===
    "all"
  ) {
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

  if (
    !fileExists(
      store.stateFile
    )
  ) {
    return {};
  }

  try {

    const raw =
      fs.readFileSync(
        store.stateFile,
        "utf8"
      );

    if (
      !raw.trim()
    ) {
      return {};
    }

    const state =
      JSON.parse(raw);

    if (
      !state ||
      typeof state !==
        "object" ||
      Array.isArray(state)
    ) {
      return {};
    }

    return state;

  } catch (err) {

    console.error(
      `[STATE ERROR] ${store.shortName}: ${err.message}`
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
      typeof data ===
        "object" &&
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
  ] =
    new Date().toISOString();

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
      .map(
        (line) => {

          try {

            return JSON.parse(
              line
            );

          } catch {

            return {
              time:
                null,

              type:
                "info",

              msg:
                line,

              store:
                store.key,
            };
          }
        }
      )
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
// STRUCTURED LOG EVENT
// ==================================================
//
// Main dashboard logs intentionally remain short.
//
// Example:
//
// {
//   "time":"2026-09-08T10:05:21.000Z",
//   "type":"automation_start",
//   "store":"akl",
//   "msg":"AKL automation started"
// }
//
// Detailed child stdout/stderr is NOT written here.
// It is stored in debug-logs instead.
//
// ==================================================

function logEvent(
  store,
  type,
  msg,
  extra = {}
) {

  const entry = {
    time:
      new Date().toISOString(),

    type,

    msg,

    store:
      store?.key ||
      "unknown",

    ...extra,
  };

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

  console.log(
    `[${type.toUpperCase()}] [${
      store?.shortName ||
      "UNKNOWN"
    }] ${msg}`
  );
}

// ==================================================
// DEBUG LOG
// ==================================================

function createDebugLogFile(
  store
) {

  const timestamp =
    new Date()
      .toISOString()
      .replace(
        /[:.]/g,
        "-"
      );

  const directory =
    path.join(
      DEBUG_LOG_DIR,
      store.key.toUpperCase()
    );

  if (
    !fs.existsSync(
      directory
    )
  ) {
    fs.mkdirSync(
      directory,
      {
        recursive:
          true,
      }
    );
  }

  return path.join(
    directory,
    `${timestamp}.log`
  );
}

function writeDebugLog(
  debugStream,
  text
) {

  if (
    !debugStream ||
    !text
  ) {
    return;
  }

  try {

    debugStream.write(
      text
    );

  } catch {
    // Debug logging must never
    // break the automation.
  }
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
          method:
            "GET",
        },
        token
      )
    );

  const response =
    await fetch(
      url,
      {
        method:
          "GET",

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
        count:
          0,

        orders:
          [],

        error:
          true,
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

      error:
        false,
    };

  } catch (err) {

    console.error(
      `Could not retrieve ${store.shortName} awaiting POs:`,
      err.message
    );

    return {
      count:
        0,

      orders:
        [],

      error:
        true,
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

    if (
      !entry.time
    ) {
      continue;
    }

    const msg =
      String(
        entry.msg ||
          ""
      ).toLowerCase();

    if (
      runMessages.some(
        (term) =>
          msg.includes(
            term
          )
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

  if (
    Array.isArray(logs)
  ) {

    logs.forEach(
      (entry) => {

        const msg =
          entry?.msg ||
          "";

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
        parts[1] ||
        "—";

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

  const combined = [
    ...bomBlocked,
    ...shopifyBlocked,
  ];

  return combined.sort(
    (a, b) =>
      new Date(
        b.detectedAt ||
          0
      ).getTime() -
      new Date(
        a.detectedAt ||
          0
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
      `${code}: resolve script not found`,
      {
        action:
          "resolve",
        status:
          "failed",
      }
    );

    return false;
  }

  logEvent(
    store,
    "resolve_start",
    `${code}: starting blocked-product resolution`,
    {
      productCode:
        code,

      poNumber:
        poNumber,

      source:
        source ||
        "unknown",
    }
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
      `${code}: resolve script failed to start`,
      {
        productCode:
          code,

        status:
          "failed",

        error:
          err.message,
      }
    );

    return false;
  }

  // ------------------------------------------------
  // IMPORTANT:
  // Do NOT put full stdout/stderr into automation.log.
  // ------------------------------------------------

  if (
    result.error
  ) {

    logEvent(
      store,
      "error",
      `${code}: resolve process error`,
      {
        productCode:
          code,

        status:
          "failed",

        error:
          result.error.message,
      }
    );

    return false;
  }

  if (
    result.status !== 0
  ) {

    logEvent(
      store,
      "error",
      `${code}: resolve script failed`,
      {
        productCode:
          code,

        status:
          "failed",

        exitCode:
          result.status,
      }
    );

    return false;
  }

  logEvent(
    store,
    "resolve_complete",
    `${code}: blocked-product resolution completed successfully`,
    {
      productCode:
        code,

      poNumber:
        poNumber,

      source:
        source ||
        "unknown",

      status:
        "success",
    }
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
              (
                (
                  processed -
                  blocked
                ) /
                processed
              ) *
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
          const store of
          getAllStores()
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
        const store of
        getAllStores()
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

      if (
        requestedStore ===
        "all"
      ) {

        const results = [];

        for (
          const store of
          getAllStores()
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

          error:
            false,
        });
      }

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

        orders:
          [],

        count:
          0,
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
              b.detectedAt ||
                0
            ).getTime() -
            new Date(
              a.detectedAt ||
                0
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
              b.time ||
                0
            ).getTime() -
            new Date(
              a.time ||
                0
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
      } =
        req.body || {};

      if (
        !code ||
        !poNumber
      ) {

        return res.status(
          400
        ).json({

          ok:
            false,

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

          ok:
            false,

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
          source ||
            ""
        )
          .trim()
          .toLowerCase();

      const normalisedReason =
        String(
          reason ||
            ""
        )
          .trim()
          .toLowerCase();

      logEvent(
        store,
        "resolve_requested",
        `${normalisedCode}: Mark Resolved clicked`,
        {
          productCode:
            normalisedCode,

          poNumber:
            poNumber,

          source:
            normalisedSource ||
            "unknown",
        }
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
            `${normalisedCode}: Shopify resolve failed - block remains active`,
            {
              productCode:
                normalisedCode,

              status:
                "blocked",
            }
          );

          return res.status(
            500
          ).json({

            ok:
              false,

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
          "resolve_success",
          `${normalisedCode}: Shopify block resolved successfully`,
          {
            productCode:
              normalisedCode,

            status:
              "success",
          }
        );

        return res.json({

          ok:
            true,

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

      state[
        `inv:${poNumber}:${normalisedCode}`
      ] = {

        done:
          true,

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

        done:
          true,

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
        "resolve_success",
        `${normalisedCode}: BOM block resolved manually`,
        {
          productCode:
            normalisedCode,

          poNumber:
            poNumber,

          source:
            "bom-automation",

          status:
            "success",
        }
      );

      return res.json({

        ok:
          true,

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
        `Resolve endpoint failed: ${err.message}`,
        {
          status:
            "failed",
        }
      );

      return res.status(
        500
      ).json({

        ok:
          false,

        error:
          err.message,
      });
    }
  }
);

// ==================================================
// START STORE AUTOMATION
// ==================================================
//
// IMPORTANT:
//
// This function is ONLY called by:
// POST /api/run-now
//
// It is NEVER called during server startup.
//
// Dashboard:
//     ↓
// /api/run-now
//     ↓
// run-presale-automation.js
//     ↓
// correct store flow
//
// ==================================================

function startStoreAutomation(
  store
) {

  const orchestratorPath =
    path.join(
      ROOT_DIR,
      "run-presale-automation.js"
    );

  if (
    !fileExists(
      orchestratorPath
    )
  ) {

    logEvent(
      store,
      "error",
      `Master orchestrator not found`,
      {
        status:
          "failed",

        path:
          orchestratorPath,
      }
    );

    return {

      ok:
        false,

      store:
        store.key,

      storeName:
        store.name,

      error:
        `${store.shortName} master orchestrator not found: ${orchestratorPath}`,
    };
  }

  const nodeCommand =
    process.execPath;

  const storeKey =
    String(
      store.key
    )
      .trim()
      .toLowerCase();

  const commandText =
    `${path.basename(
      nodeCommand
    )} ${path.relative(
      ROOT_DIR,
      orchestratorPath
    )} ${storeKey}`;

  // ==================================================
  // DEBUG LOG
  // ==================================================

  const debugLogFile =
    createDebugLogFile(
      store
    );

  let debugStream;

  try {

    debugStream =
      fs.createWriteStream(
        debugLogFile,
        {
          flags:
            "a",
          encoding:
            "utf8",
        }
      );

  } catch (err) {

    debugStream =
      null;

    logEvent(
      store,
      "warning",
      `Could not create debug log: ${err.message}`
    );
  }

  // ==================================================
  // DASHBOARD LOG
  // ==================================================

  logEvent(
    store,
    "automation_start",
    `${store.shortName} presale automation started`,
    {
      status:
        "running",

      command:
        `node run-presale-automation.js ${storeKey}`,
    }
  );

  logEvent(
    store,
    "info",
    `${store.shortName} automation output is being stored in debug log`,
    {
      debugLog:
        path.relative(
          ROOT_DIR,
          debugLogFile
        ),
    }
  );

  // ==================================================
  // START ORCHESTRATOR
  // ==================================================

  let child;

  try {

    child =
      spawn(
        nodeCommand,
        [
          orchestratorPath,
          storeKey,
        ],
        {
          cwd:
            ROOT_DIR,

          detached:
            true,

          stdio: [
            "ignore",
            "pipe",
            "pipe",
          ],

          windowsHide:
            true,

          env: {
            ...process.env,
          },
        }
      );

  } catch (err) {

    if (debugStream) {
      debugStream.end();
    }

    logEvent(
      store,
      "error",
      `${store.shortName} automation could not be started`,
      {
        status:
          "failed",

        error:
          err.message,
      }
    );

    return {

      ok:
        false,

      store:
        store.key,

      storeName:
        store.name,

      error:
        err.message,
    };
  }

  // ==================================================
  // DEBUG STDOUT
  // ==================================================

  child.stdout.on(
    "data",
    (data) => {

      const text =
        data.toString();

      writeDebugLog(
        debugStream,
        text
      );
    }
  );

  // ==================================================
  // DEBUG STDERR
  // ==================================================

  child.stderr.on(
    "data",
    (data) => {

      const text =
        data.toString();

      writeDebugLog(
        debugStream,
        text
      );
    }
  );

  // ==================================================
  // PROCESS ERROR
  // ==================================================

  child.on(
    "error",
    (err) => {

      logEvent(
        store,
        "error",
        `${store.shortName} automation process error`,
        {
          status:
            "failed",

          error:
            err.message,
        }
      );

      writeDebugLog(
        debugStream,
        `\n[PROCESS ERROR] ${err.stack || err.message}\n`
      );
    }
  );

  // ==================================================
  // PROCESS EXIT
  // ==================================================

  child.on(
    "exit",
    (
      code,
      signal
    ) => {

      const success =
        code === 0;

      if (success) {

        logEvent(
          store,
          "automation_complete",
          `${store.shortName} presale automation completed`,
          {
            status:
              "success",

            exitCode:
              0,
          }
        );

      } else {

        logEvent(
          store,
          "automation_complete",
          `${store.shortName} presale automation finished with errors`,
          {
            status:
              "failed",

            exitCode:
              code,

            signal:
              signal ||
              null,
          }
        );
      }

      writeDebugLog(
        debugStream,
        `\n==================================================\n`
      );

      writeDebugLog(
        debugStream,
        `[PROCESS EXIT] code=${code} signal=${signal || "none"}\n`
      );

      writeDebugLog(
        debugStream,
        `==================================================\n`
      );

      if (debugStream) {
        debugStream.end();
      }
    }
  );

  // ==================================================
  // DETACH
  // ==================================================

  child.unref();

  // ==================================================
  // STARTED
  // ==================================================

  logEvent(
    store,
    "automation_triggered",
    `${store.shortName} automation triggered from dashboard`,
    {
      status:
        "running",

      pid:
        child.pid,

      command:
        `node run-presale-automation.js ${storeKey}`,
    }
  );

  return {

    ok:
      true,

    store:
      store.key,

    storeName:
      store.name,

    pid:
      child.pid,

    command:
      `node run-presale-automation.js ${storeKey}`,

    logFile:
      path.relative(
        ROOT_DIR,
        store.logFile
      ),

    debugLog:
      path.relative(
        ROOT_DIR,
        debugLogFile
      ),
  };
}

// ==================================================
// API — RUN NOW
// ==================================================
//
// IMPORTANT:
//
// This is the ONLY place where the dashboard
// starts presale automation.
//
// Nothing below or above automatically calls
// the orchestrator during dashboard startup.
//
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

        const orchestratorPath =
          path.join(
            ROOT_DIR,
            "run-presale-automation.js"
          );

        if (
          !fileExists(
            orchestratorPath
          )
        ) {

          logEvent(
            STORES.akl,
            "error",
            "Master orchestrator not found",
            {
              status:
                "failed",

              path:
                orchestratorPath,
            }
          );

          return res.status(
            500
          ).json({

            ok:
              false,

            store:
              "all",

            error:
              `Master orchestrator not found: ${orchestratorPath}`,
          });
        }

        // ----------------------------------------------
        // CREATE DEBUG LOG
        // ----------------------------------------------

        const timestamp =
          new Date()
            .toISOString()
            .replace(
              /[:.]/g,
              "-"
            );

        const allDebugDirectory =
          path.join(
            DEBUG_LOG_DIR,
            "ALL"
          );

        if (
          !fs.existsSync(
            allDebugDirectory
          )
        ) {

          fs.mkdirSync(
            allDebugDirectory,
            {
              recursive:
                true,
            }
          );
        }

        const debugLogFile =
          path.join(
            allDebugDirectory,
            `${timestamp}.log`
          );

        let debugStream;

        try {

          debugStream =
            fs.createWriteStream(
              debugLogFile,
              {
                flags:
                  "a",
                encoding:
                  "utf8",
              }
            );

        } catch {

          debugStream =
            null;
        }

        // ----------------------------------------------
        // LOG START
        // ----------------------------------------------

        logEvent(
          STORES.akl,
          "automation_start",
          "ALL STORES presale automation started",
          {
            status:
              "running",

            command:
              "node run-presale-automation.js",
          }
        );

        let child;

        try {

          child =
            spawn(
              process.execPath,
              [
                orchestratorPath,
              ],
              {
                cwd:
                  ROOT_DIR,

                detached:
                  true,

                stdio: [
                  "ignore",
                  "pipe",
                  "pipe",
                ],

                windowsHide:
                  true,

                env: {
                  ...process.env,
                },
              }
            );

        } catch (err) {

          if (debugStream) {
            debugStream.end();
          }

          logEvent(
            STORES.akl,
            "error",
            `Could not start ALL STORES automation: ${err.message}`,
            {
              status:
                "failed",
            }
          );

          return res.status(
            500
          ).json({

            ok:
              false,

            store:
              "all",

            error:
              err.message,
          });
        }

        child.stdout.on(
          "data",
          (data) => {

            writeDebugLog(
              debugStream,
              data.toString()
            );
          }
        );

        child.stderr.on(
          "data",
          (data) => {

            writeDebugLog(
              debugStream,
              data.toString()
            );
          }
        );

        child.on(
          "error",
          (err) => {

            logEvent(
              STORES.akl,
              "error",
              `ALL STORES automation process error: ${err.message}`,
              {
                status:
                  "failed",
              }
            );

            writeDebugLog(
              debugStream,
              `\n[PROCESS ERROR] ${err.stack || err.message}\n`
            );
          }
        );

        child.on(
          "exit",
          (
            code,
            signal
          ) => {

            if (
              code === 0
            ) {

              logEvent(
                STORES.akl,
                "automation_complete",
                "ALL STORES presale automation completed",
                {
                  status:
                    "success",

                  exitCode:
                    0,
                }
              );

            } else {

              logEvent(
                STORES.akl,
                "automation_complete",
                "ALL STORES presale automation finished with errors",
                {
                  status:
                    "failed",

                  exitCode:
                    code,

                  signal:
                    signal ||
                    null,
                }
              );
            }

            if (debugStream) {
              debugStream.end();
            }
          }
        );

        child.unref();

        logEvent(
          STORES.akl,
          "automation_triggered",
          "ALL STORES automation triggered from dashboard",
          {
            status:
              "running",

            pid:
              child.pid,

            command:
              "node run-presale-automation.js",

            debugLog:
              path.relative(
                ROOT_DIR,
                debugLogFile
              ),
          }
        );

        return res.json({

          ok:
            true,

          store:
            "all",

          pid:
            child.pid,

          command:
            "node run-presale-automation.js",

          message:
            "AKL, WLG and CHCH presale automation started successfully.",
        });
      }

      // ==================================================
      // SINGLE STORE
      // ==================================================

      const store =
        getStore(
          requestedStore
        );

      if (!store) {

        return res.status(
          400
        ).json({

          ok:
            false,

          store:
            requestedStore,

          error:
            `Unknown store: ${requestedStore}`,
        });
      }

      // ----------------------------------------------
      // START ONLY WHEN THIS API IS CALLED
      // ----------------------------------------------

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

        ok:
          true,

        store:
          store.key,

        storeName:
          store.name,

        pid:
          result.pid,

        command:
          result.command,

        message:
          `${store.shortName} presale automation started successfully.`,
      });

    } catch (err) {

      console.error(
        "Run-now error:",
        err
      );

      return res.status(
        500
      ).json({

        ok:
          false,

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

    const stores = {};

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

      debugLogDir:
        DEBUG_LOG_DIR,

      debugLogDirExists:
        fileExists(
          DEBUG_LOG_DIR
        ),

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

      ok:
        true,

      service:
        "TSB Pre-sale Automation Dashboard",

      rootDir:
        ROOT_DIR,

      stores:
        getAllStores().map(
          (store) =>
            store.shortName
        ),

      automationOnStartup:
        false,

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

      ok:
        false,

      error:
        err.message ||
        "Internal server error",
    });
  }
);

// ==================================================
// START SERVER
// ==================================================
//
// IMPORTANT:
//
// NOTHING HERE STARTS AUTOMATION.
//
// This section ONLY starts the Express server.
//
// Automation can only begin after:
//
// POST /api/run-now
//
// ==================================================

const server =
  app.listen(
    PORT,
    () => {

      console.log("");

      console.log(
        "=============================================="
      );

      console.log(
        " TSB PRE-SALE DASHBOARD"
      );

      console.log(
        "=============================================="
      );

      console.log(
        ` Dashboard: http://localhost:${PORT}/`
      );

      console.log(
        ` API:       http://localhost:${PORT}/api/overview`
      );

      console.log("");

      console.log(
        " ROOT"
      );

      console.log(
        ` ${ROOT_DIR}`
      );

      console.log("");

      console.log(
        " STORES"
      );

      console.log(
        " --------------------------------------------"
      );

      getAllStores().forEach(
        (store) => {

          console.log(
            ` ${store.shortName} → ${store.name}`
          );

          console.log(
            `    Automation: ${store.automationScript}`
          );

          console.log(
            `    Exists:     ${fileExists(
              store.automationScript
            )}`
          );

          if (
            store.resolveScript
          ) {

            console.log(
              `    Resolve:    ${store.resolveScript}`
            );

            console.log(
              `    Exists:     ${fileExists(
                store.resolveScript
              )}`
            );
          }

          if (
            store.cleanupScript
          ) {

            console.log(
              `    Cleanup:    ${store.cleanupScript}`
            );

            console.log(
              `    Exists:     ${fileExists(
                store.cleanupScript
              )}`
            );
          }

          if (
            store.deliveryScript
          ) {

            console.log(
              `    Delivery:   ${store.deliveryScript}`
            );

            console.log(
              `    Exists:     ${fileExists(
                store.deliveryScript
              )}`
            );
          }

          if (
            store.shopifyListingScript
          ) {

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
        }
      );

      console.log(
        " --------------------------------------------"
      );

      console.log(
        " AUTOMATION"
      );

      console.log(
        " --------------------------------------------"
      );

      console.log(
        " ✓ No automation runs at dashboard startup."
      );

      console.log(
        " ✓ Automation runs only through /api/run-now."
      );

      console.log(
        " ✓ AKL → run-presale-automation.js akl"
      );

      console.log(
        " ✓ WLG → run-presale-automation.js wlg"
      );

      console.log(
        " ✓ CHCH → run-presale-automation.js chch"
      );

      console.log(
        " ✓ ALL → run-presale-automation.js"
      );

      console.log("");

      console.log(
        " LOGGING"
      );

      console.log(
        " --------------------------------------------"
      );

      console.log(
        ` Main logs:  ${AUTOMATION_LOG}`
      );

      console.log(
        ` Debug logs: ${DEBUG_LOG_DIR}`
      );

      console.log("");

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

server.on(
  "error",
  (err) => {

    console.error("");

    console.error(
      "=============================================="
    );

    console.error(
      " DASHBOARD SERVER ERROR"
    );

    console.error(
      "=============================================="
    );

    console.error(
      err
    );

    console.error("");

    if (
      err.code ===
      "EADDRINUSE"
    ) {

      console.error(
        `Port ${PORT} is already being used by another process.`
      );
    }

    process.exitCode =
      1;
  }
);

// ==================================================
// PROCESS DEBUG
// ==================================================

process.on(
  "exit",
  (code) => {

    console.log(
      `\n[PROCESS EXIT] dashboard-server.js exited with code ${code}`
    );
  }
);

process.on(
  "SIGINT",
  () => {

    console.log(
      "\n[PROCESS] SIGINT received."
    );

    server.close(
      () => {

        console.log(
          "[PROCESS] Dashboard server closed."
        );

        process.exit(0);
      }
    );
  }
);

process.on(
  "SIGTERM",
  () => {

    console.log(
      "\n[PROCESS] SIGTERM received."
    );

    server.close(
      () => {

        console.log(
          "[PROCESS] Dashboard server closed."
        );

        process.exit(0);
      }
    );
  }
);