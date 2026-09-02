require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const OAuth = require("oauth-1.0a");
const crypto = require("crypto");
const JSONbig = require("json-bigint")({ storeAsString: true });

const app = express();
const PORT = 3456;

// ==================================================
// BASE PATHS
// ==================================================
const ROOT_DIR = __dirname;
const JSON_DIR = path.join(ROOT_DIR, "json");
const AUTOMATION_LOG = path.join(ROOT_DIR, "automation.log");

// ==================================================
// STORE CONFIGURATION
// ==================================================
//
// IMPORTANT:
// Each store is completely independent.
//
// AKL:
// Existing root-level state/results.
//
// WLG:
// json/WLG/...
//
// CHCH:
// json/CHCH/...
//
// ==================================================

const STORES = {
  akl: {
    key: "akl",
    name: "Auckland",
    shortName: "AKL",

    stateFile: path.join(JSON_DIR, "AKL", "processed-state.json"),
    shopifyListingResultsFile: path.join(JSON_DIR, "AKL", "shopify-listing-results.json"),
    shopifyResolvedFile: path.join(JSON_DIR,"AKL", "shopify-resolved.json"),
    graduationFile: path.join(JSON_DIR, "AKL", "graduated-this-week.json"),
    logFile: AUTOMATION_LOG,

    shopifyTag: "Pre-Order-Auckland",
    shopifyMetafieldNamespace: "stock",
    shopifyMetafieldKey: "akl_arriving_date",

    tvConsumerKey: process.env.TV_CONSUMER_KEY,
    tvConsumerSecret: process.env.TV_CONSUMER_SECRET,
    tvAccessToken: process.env.TV_ACCESS_TOKEN,
    tvAccessTokenSecret: process.env.TV_ACCESS_TOKEN_SECRET,

    shopifyStore: process.env.SHOPIFY_STORE,
    shopifyToken: process.env.SHOPIFY_ACCESS_TOKEN,

    automationScript: path.join(ROOT_DIR, "bom-automation.js"),
    resolveScript: path.join(ROOT_DIR, "resolve-blocked.js"),
  },

  wlg: {
    key: "wlg",
    name: "Wellington",
    shortName: "WLG",

    stateFile: path.join(JSON_DIR, "WLG", "processed-state-wlg.json"),
    shopifyListingResultsFile: path.join(JSON_DIR, "WLG", "shopify-listing-results-wlg.json"),
    shopifyResolvedFile: path.join(JSON_DIR, "WLG", "shopify-resolved-wlg.json"),
    graduationFile: path.join(JSON_DIR, "WLG", "graduated-this-week-wlg.json"),
    logFile: path.join(JSON_DIR, "WLG", "automation-wlg.log"),

    shopifyTag: "Pre-Order-Wellington",
    shopifyMetafieldNamespace: "stock",
    shopifyMetafieldKey: "wlg_arriving_date",

    tvConsumerKey: process.env.WLG_TV_CONSUMER_KEY,
    tvConsumerSecret: process.env.WLG_TV_CONSUMER_SECRET,
    tvAccessToken: process.env.WLG_TV_ACCESS_TOKEN,
    tvAccessTokenSecret: process.env.WLG_TV_ACCESS_TOKEN_SECRET,

    shopifyStore: process.env.WLG_SHOPIFY_STORE || process.env.SHOPIFY_STORE,
    shopifyToken: process.env.WLG_SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN,

    automationScript: path.join(ROOT_DIR, "WLG", "bom-automation-wlg.js"),
    resolveScript: path.join(ROOT_DIR, "WLG", "resolve-blocked-wlg.js"),
  },

  chch: {
    key: "chch",
    name: "Christchurch",
    shortName: "CHCH",

    stateFile: path.join(JSON_DIR, "CHCH", "processed-state-chch.json"),
    shopifyListingResultsFile: path.join(JSON_DIR, "CHCH", "shopify-listing-results-chch.json"),
    shopifyResolvedFile: path.join(JSON_DIR, "CHCH", "shopify-resolved-chch.json"),
    graduationFile: path.join(JSON_DIR, "CHCH", "graduated-this-week-chch.json"),
    logFile: path.join(JSON_DIR, "CHCH", "automation-chch.log"),

    shopifyTag: "Pre-Order-Christchurch",
    shopifyMetafieldNamespace: "stock",
    shopifyMetafieldKey: "chch_arriving_date",

    tvConsumerKey: process.env.CHCH_TV_CONSUMER_KEY,
    tvConsumerSecret: process.env.CHCH_TV_CONSUMER_SECRET,
    tvAccessToken: process.env.CHCH_TV_ACCESS_TOKEN,
    tvAccessTokenSecret: process.env.CHCH_TV_ACCESS_TOKEN_SECRET,

    shopifyStore: process.env.CHCH_SHOPIFY_STORE || process.env.SHOPIFY_STORE,
    shopifyToken: process.env.CHCH_SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN,

    automationScript: path.join(ROOT_DIR, "CHCH", "bom-automation-chch.js"),
    resolveScript: path.join(ROOT_DIR, "CHCH", "resolve-blocked-chch.js"),
  },
};

// ==================================================
// AUTOMATION SCHEDULE
// ==================================================
const AUTOMATION_INTERVAL_HOURS = 4;
const AUTOMATION_INTERVAL_MS = AUTOMATION_INTERVAL_HOURS * 60 * 60 * 1000;


// ==================================================
// EXPRESS
// ==================================================
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(ROOT_DIR, "dashboard")));


// ==================================================
// STORE HELPERS
// ==================================================
function getStore(storeKey) {
  const key = String(storeKey || "akl").trim().toLowerCase();
  return STORES[key] || STORES.akl;
}

function ensureParentDirectory(filePath) {
  const directory = path.dirname(filePath);

  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}


// ==================================================
// STATE
// ==================================================
function loadState(store) {
  if (!store) {
    console.error("loadState: store is missing");
    return {};
  }

  console.log(
    `[STATE READ] ${store.shortName} -> ${store.stateFile}`
  );

  console.log(
    `[STATE EXISTS] ${store.shortName} -> ${fs.existsSync(store.stateFile)}`
  );

  if (!fs.existsSync(store.stateFile)) {
    console.error(
      `[STATE MISSING] ${store.shortName} state file does not exist: ${store.stateFile}`
    );

    return {};
  }

  try {
    const raw = fs.readFileSync(store.stateFile, "utf8");
    const state = JSON.parse(raw);

    console.log(
      `[STATE LOADED] ${store.shortName} -> ${store.stateFile}`
    );

    console.log(
      `[STATE KEYS] ${store.shortName} -> ${Object.keys(state).length} records`
    );

    return state;

  } catch (err) {
    console.error(
      `[STATE ERROR] ${store.shortName} -> ${store.stateFile}: ${err.message}`
    );

    return {};
  }
}


// ==================================================
// SHOPIFY RESOLVED RECORDS
// ==================================================
function loadShopifyResolved(store) {
  if (!store || !fs.existsSync(store.shopifyResolvedFile)) {
    return {};
  }

  try {
    const data = JSON.parse(fs.readFileSync(store.shopifyResolvedFile, "utf8"));
    return (data && typeof data === "object" && !Array.isArray(data)) ? data : {};
  } catch (err) {
    console.error(`Could not read ${store.shortName} Shopify resolved file:`, err.message);
    return {};
  }
}

function saveShopifyResolved(store, data) {
  ensureParentDirectory(store.shopifyResolvedFile);
  fs.writeFileSync(store.shopifyResolvedFile, JSON.stringify(data, null, 2));
}


// ==================================================
// MARK SHOPIFY BLOCK AS RESOLVED
// ==================================================
function markShopifyBlockResolved(store, code) {
  const resolved = loadShopifyResolved(store);
  const normalisedCode = String(code).trim().toUpperCase();

  resolved[normalisedCode] = new Date().toISOString();
  saveShopifyResolved(store, resolved);

  logEvent(store, "info", `${normalisedCode}: Shopify blocked record marked as resolved`);
}


// ==================================================
// SHOPIFY LISTING BLOCKED PRODUCTS
// ==================================================
function loadShopifyListingBlockedProducts(store) {
  if (!store || !fs.existsSync(store.shopifyListingResultsFile)) {
    return [];
  }

  try {
    const data = JSON.parse(fs.readFileSync(store.shopifyListingResultsFile, "utf8"));
    if (!Array.isArray(data)) {
      return [];
    }

    const resolved = loadShopifyResolved(store);
    const latest = new Map();

    // --------------------------------------------------
    // COLLECT LATEST BLOCKED RECORD PER PRODUCT CODE
    // --------------------------------------------------
    data.forEach((run) => {
      if (!Array.isArray(run.products)) {
        return;
      }

      run.products.forEach((item) => {
        if (!item.productCode) {
          return;
        }

        const code = String(item.productCode).trim().toUpperCase();
        const detectedAt = item.date || run.date || null;

        const record = {
          code,
          poNumber: item.poNumber || "—",
          supplier: item.supplier || "—",
          reason: item.reason || "unknown",
          missing: Array.isArray(item.missing) ? item.missing : [],
          error: item.error || null,
          detectedAt,
          source: "shopify-listing",
          status: item.status,
          store: store.key,
          storeName: store.name,
        };

        const existing = latest.get(code);

        if (!existing) {
          latest.set(code, record);
          return;
        }

        const existingTime = new Date(existing.detectedAt || 0).getTime();
        const newTime = new Date(record.detectedAt || 0).getTime();

        if (newTime >= existingTime) {
          latest.set(code, record);
        }
      });
    });

    // --------------------------------------------------
    // FILTER OUT RESOLVED BLOCKS
    // --------------------------------------------------
    const results = [];

    latest.forEach((item, code) => {
      if (item.status !== "blocked") {
        return;
      }

      const resolvedAt = resolved[code];

      if (resolvedAt) {
        const blockedTime = new Date(item.detectedAt || 0).getTime();
        const resolvedTime = new Date(resolvedAt).getTime();

        if (
          !Number.isNaN(resolvedTime) &&
          !Number.isNaN(blockedTime) &&
          blockedTime <= resolvedTime
        ) {
          return; // Block was resolved after detection
        }
      }

      results.push(item);
    });

    return results;

  } catch (err) {
    console.error(`Could not read ${store.shortName} Shopify listing results:`, err.message);
    return [];
  }
}
// ==================================================
// GRADUATIONS
// ==================================================
function loadGraduations(store) {
  if (!store || !fs.existsSync(store.graduationFile)) {
    return [];
  }

  try {
    const data = JSON.parse(fs.readFileSync(store.graduationFile, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error(`Could not read ${store.shortName} graduation file:`, err.message);
    return [];
  }
}


// ==================================================
// LOGS
// ==================================================
function loadLogs(store) {
  if (!store || !fs.existsSync(store.logFile)) {
    return [];
  }

  return fs
    .readFileSync(store.logFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { time: null, type: "info", msg: line };
      }
    })
    .reverse();
}


// ==================================================
// LOG EVENT
// ==================================================
function logEvent(store, type, msg) {
  const entry = {
    time: new Date().toISOString(),
    type,
    msg,
    store: store?.key || "unknown",
  };

  console.log(`[${type.toUpperCase()}] [${store?.shortName || "UNKNOWN"}] ${msg}`);

  const logFile = store?.logFile || AUTOMATION_LOG;
  ensureParentDirectory(logFile);

  fs.appendFileSync(logFile, JSON.stringify(entry) + "\n");
}


// ==================================================
// TRADEVINE OAUTH
// ==================================================
function createOAuth(store) {
  return OAuth({
    consumer: {
      key: store.tvConsumerKey,
      secret: store.tvConsumerSecret,
    },
    signature_method: "HMAC-SHA1",
    hash_function: (base, key) =>
      crypto.createHmac("sha1", key).update(base).digest("base64"),
  });
}


// ==================================================
// TRADEVINE GET
// ==================================================
async function tradevineGet(store, url) {
  const oauth = createOAuth(store);
  const token = {
    key: store.tvAccessToken,
    secret: store.tvAccessTokenSecret,
  };

  const authHeader = oauth.toHeader(
    oauth.authorize({ url, method: "GET" }, token)
  );

  const response = await fetch(url, {
    method: "GET",
    headers: {
      ...authHeader,
      Accept: "application/json",
    },
  });

  const text = await response.text();
  let data = null;

  try {
    data = JSONbig.parse(text);
  } catch {
    data = null;
  }

  return {
    status: response.status,
    data,
    raw: text,
  };
}


// ==================================================
// TRADEVINE — PURCHASE ORDERS
// ==================================================
async function getAwaitingReceiptPOs(store) {
  try {
    const url =
      "https://api.tradevine.com/v1/PurchaseOrder" +
      "?pageNumber=1" +
      "&pageSize=500" +
      "&status=19001";

    const result = await tradevineGet(store, url);

    if (result.status !== 200 || !result.data) {
      console.error(
        `${store.shortName} PurchaseOrder lookup failed:`,
        result.status,
        result.raw?.slice(0, 500)
      );

      return { count: 0, orders: [], error: true };
    }

    const list = result.data.List || result.data.list || [];

    return {
      count: result.data.TotalCount ?? list.length,
      orders: list.map((po) => ({
        orderNumber: po.OrderNumber || "—",
        supplier: po.Supplier?.Name || "—",
        requiredDeliveryDate: po.RequiredDeliveryDate || null,
        status: po.Status,
        purchaseOrderId: po.PurchaseOrderID ? String(po.PurchaseOrderID) : null,
      })),
      error: false,
    };
  } catch (err) {
    console.error(`Could not retrieve ${store.shortName} awaiting POs:`, err.message);
    return { count: 0, orders: [], error: true };
  }
}


// ==================================================
// EXTRACT PRODUCT CODES
// ==================================================
function extractProductCodesFromText(text) {
  if (!text) {
    return [];
  }

  const matches = text.match(/\bPR\d+(?:-[A-Z0-9]+)?\b/gi) || [];
  return matches.map((code) => code.toUpperCase());
}


// ==================================================
// LAST AUTOMATION RUN
// ==================================================
function getLastRun(logs) {
  const runMessages = [
    "automation run",
    "bom-automation",
    "automation started",
    "checking",
    "found",
    "presale cleanup",
    "delivery metafield",
  ];

  for (const entry of logs) {
    if (!entry.time) continue;

    const msg = (entry.msg || "").toLowerCase();

    if (runMessages.some((term) => msg.includes(term))) {
      return entry.time;
    }
  }

  return null;
}


// ==================================================
// NEXT RUN
// ==================================================
function getNextRun(lastRun) {
  if (!lastRun) {
    return null;
  }

  const last = new Date(lastRun).getTime();
  if (Number.isNaN(last)) {
    return null;
  }

  return new Date(last + AUTOMATION_INTERVAL_MS).toISOString();
}

/* ==================================================
   PRODUCTS PROCESSED
================================================== */
function getProcessedProducts(state, logs) {
  const products = new Set();

  if (!state || typeof state !== "object") {
    return products;
  }

  /* --------------------------------------------------
     PROCESSED INVENTORY RECORDS
  -------------------------------------------------- */
  Object.entries(state).forEach(([key, value]) => {
    if (!key.startsWith("inv:")) {
      return;
    }

    // Only count completed records
    if (!value || value.done !== true) {
      return;
    }

    const parts = key.split(":");

    // Expected format:
    // inv:PO_NUMBER:PRODUCT_CODE
    if (parts.length >= 3) {
      const productCode = parts
        .slice(2)
        .join(":")
        .trim()
        .toUpperCase();

      if (productCode) {
        products.add(productCode);
      }
    }
  });

  /* --------------------------------------------------
     GRADUATED PRODUCTS FROM LOGS
  -------------------------------------------------- */
  if (Array.isArray(logs)) {
    logs.forEach((entry) => {
      const msg = entry?.msg || "";

      if (/graduated/i.test(msg)) {
        const codes = extractProductCodesFromText(msg);
        codes.forEach((code) => products.add(code));
      }
    });
  }

  return products;
}

// ==================================================
// BOM BLOCKED PRODUCTS
// ==================================================
function getBomBlockedProducts(store, state) {
  return Object.entries(state)
    .filter(([key]) => key.startsWith("blocked:"))
    .map(([key, value]) => ({
      code: key.replace("blocked:", "").trim().toUpperCase(),
      poNumber: value?.poNumber || "—",
      supplier: value?.supplier || "—",
      reason: value?.reason || "unknown",
      missing: Array.isArray(value?.missing) ? value.missing : [],
      error: value?.error || null,
      detectedAt: value?.detectedAt || value?.date || null,
      source: "bom-automation",
      store: store.key,
      storeName: store.name,
    }));
}


// ==================================================
// ALL BLOCKED PRODUCTS
// ==================================================
function getAllBlockedProducts(store, state) {
  const bomBlocked = getBomBlockedProducts(store, state);
  const shopifyBlocked = loadShopifyListingBlockedProducts(store);

  const combined = [...bomBlocked, ...shopifyBlocked];

  return combined.sort(
    (a, b) =>
      new Date(b.detectedAt || 0).getTime() -
      new Date(a.detectedAt || 0).getTime()
  );
}


// ==================================================
// RUN RESOLVE-BLOCKED
// ==================================================
function runResolveBlocked(store, code, poNumber, supplierName, reason, source) {
  const scriptPath = store.resolveScript;

  if (!fs.existsSync(scriptPath)) {
    logEvent(store, "error", `${code}: resolve script not found at ${scriptPath}`);
    return false;
  }

  logEvent(store, "info", `${code}: STARTING ${path.basename(scriptPath)}`);
  logEvent(store, "info", `${code}: resolve script path = ${scriptPath}`);
  logEvent(
    store,
    "info",
    `${code}: PO = ${poNumber}, source = ${source}, reason = ${reason || "unknown"}`
  );

  let result;

  try {
    result = spawnSync(
      process.execPath,
      [
        scriptPath,
        code,
        poNumber,
        supplierName || "",
        reason || "",
        source || "",
      ],
      {
        cwd: ROOT_DIR,
        encoding: "utf8",
        env: { ...process.env },
        windowsHide: false,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
  } catch (err) {
    logEvent(store, "error", `${code}: resolve script spawn crashed - ${err.message}`);
    return false;
  }

  if (result.stdout) {
    console.log(`\n========== ${store.shortName} ${code} RESOLVE STDOUT ==========\n`);
    console.log(result.stdout);
    console.log(`\n========== END ${store.shortName} ${code} STDOUT ==========\n`);

    logEvent(
      store,
      "info",
      `${code}: resolve script stdout:\n${result.stdout.slice(0, 10000)}`
    );
  }

  if (result.stderr) {
    console.error(`\n========== ${store.shortName} ${code} RESOLVE STDERR ==========\n`);
    console.error(result.stderr);
    console.error(`\n========== END ${store.shortName} ${code} STDERR ==========\n`);

    logEvent(
      store,
      "error",
      `${code}: resolve script stderr:\n${result.stderr.slice(0, 10000)}`
    );
  }

  if (result.error) {
    logEvent(
      store,
      "error",
      `${code}: could not start resolve script - ${result.error.message}`
    );
    return false;
  }

  if (result.status !== 0) {
    logEvent(
      store,
      "error",
      `${code}: resolve script FAILED with exit code ${result.status}`
    );
    return false;
  }

  logEvent(store, "success", `${code}: resolve script completed successfully`);
  return true;
}


// ==================================================
// OVERVIEW
// ==================================================
app.get("/api/overview", async (req, res) => {
  try {
    const store = getStore(req.query.store);
    const state = loadState(store);
    const logs = loadLogs(store);

    const awaiting = await getAwaitingReceiptPOs(store);
    const processedProducts = getProcessedProducts(state, logs);
    const blockedProducts = getAllBlockedProducts(store, state);
    const graduations = loadGraduations(store);

    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const graduatedThisWeek = graduations.filter((entry) => {
      const time = new Date(entry.date).getTime();
      return !Number.isNaN(time) && time >= weekAgo;
    }).length;

    const lastRun = getLastRun(logs);
    const nextRun = getNextRun(lastRun);

    const processed = processedProducts.size;
    const blocked = blockedProducts.length;

    const healthRate =
      processed > 0
        ? Math.max(
            0,
            Math.min(100, Math.round(((processed - blocked) / processed) * 100))
          )
        : 100;

    res.json({
      store: store.key,
      storeName: store.name,
      storeShortName: store.shortName,
      posAwaiting: awaiting.count,
      productsProcessed: processed,
      blocked,
      graduatedThisWeek,
      lastRun,
      nextRun,
      healthRate,
      automationIntervalHours: AUTOMATION_INTERVAL_HOURS,
      poError: awaiting.error,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Overview error:", err);
    res.status(500).json({ error: err.message });
  }
});


// ==================================================
// ALL STORE OVERVIEW
// ==================================================
app.get("/api/overview/all", async (req, res) => {
  try {
    const result = {};

    for (const key of Object.keys(STORES)) {
      const store = STORES[key];
      const state = loadState(store);
      const logs = loadLogs(store);

      const awaiting = await getAwaitingReceiptPOs(store);
      const processedProducts = getProcessedProducts(state, logs);
      const blockedProducts = getAllBlockedProducts(store, state);
      const graduations = loadGraduations(store);

      const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

      const graduatedThisWeek = graduations.filter((entry) => {
        const time = new Date(entry.date).getTime();
        return !Number.isNaN(time) && time >= weekAgo;
      }).length;

      const lastRun = getLastRun(logs);

      const processed = processedProducts.size;
      const blocked = blockedProducts.length;

      const healthRate =
        processed > 0
          ? Math.max(
              0,
              Math.min(100, Math.round(((processed - blocked) / processed) * 100))
            )
          : 100;

      result[key] = {
        store: store.key,
        storeName: store.name,
        storeShortName: store.shortName,
        posAwaiting: awaiting.count,
        productsProcessed: processed,
        blocked,
        graduatedThisWeek,
        lastRun,
        nextRun: getNextRun(lastRun),
        healthRate,
        automationIntervalHours: AUTOMATION_INTERVAL_HOURS,
        poError: awaiting.error,
      };
    }

    res.json({
      stores: result,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("All-store overview error:", err);
    res.status(500).json({ error: err.message });
  }
});


// ==================================================
// GRADUATIONS
// ==================================================
app.get("/api/graduations", (req, res) => {
  const store = getStore(req.query.store);
  const graduations = loadGraduations(store);

  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  const recent = graduations.filter((entry) => {
    const time = new Date(entry.date).getTime();
    return !Number.isNaN(time) && time >= weekAgo;
  });

  res.json(
    recent.map((entry) => ({
      ...entry,
      store: store.key,
      storeName: store.name,
    }))
  );
});
// ==================================================
// PURCHASE ORDERS
// ==================================================
app.get("/api/purchase-orders", async (req, res) => {
  try {
    const store = getStore(req.query.store);
    const result = await getAwaitingReceiptPOs(store);

    res.json({
      ...result,
      store: store.key,
      storeName: store.name,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ==================================================
// STATE
// ==================================================
app.get("/api/state", (req, res) => {
  const store = getStore(req.query.store);
  res.json(loadState(store));
});

/* ==================================================
   PROCESSED PRODUCTS
================================================== */
function getProcessedProductDetails(store) {
  const state = loadState(store);
  const products = new Map();

  if (!state || typeof state !== "object") {
    return [];
  }

  /* --------------------------------------------------
     INVENTORY PROCESSED PRODUCTS
  -------------------------------------------------- */
  Object.entries(state).forEach(([key, value]) => {
    if (!key.startsWith("inv:")) return;
    if (!value || value.done !== true) return;

    const parts = key.split(":");
    if (parts.length < 3) return;

    const poNumber = parts[1] || "—";

    const code = parts
      .slice(2)
      .join(":")
      .trim()
      .toUpperCase();

    if (!code) return;

    products.set(code, {
      code,
      poNumber,
      supplier: value.supplier || "—",
      store: store.key,
      storeName: store.name,
      type: "Inventory",
      status: "Processed",
      date: value.date || null,
    });
  });

  /* --------------------------------------------------
     TITLE PROCESSED PRODUCTS
  -------------------------------------------------- */
  Object.entries(state).forEach(([key, value]) => {
    if (!key.startsWith("title:")) return;
    if (!value || value.done !== true) return;

    const code = key.replace(/^title:/, "").trim().toUpperCase();
    if (!code) return;

    if (!products.has(code)) {
      products.set(code, {
        code,
        poNumber: "—",
        supplier: value.supplier || "—",
        store: store.key,
        storeName: store.name,
        type: "Title",
        status: "Processed",
        date: value.date || null,
      });
    }
  });

  /* --------------------------------------------------
     BOM PROCESSED PRODUCTS
  -------------------------------------------------- */
  Object.entries(state).forEach(([key, value]) => {
    if (!key.startsWith("bom:")) return;
    if (!value || value.done !== true) return;

    const code = key.replace(/^bom:/, "").trim().toUpperCase();
    if (!code) return;

    if (!products.has(code)) {
      products.set(code, {
        code,
        poNumber: "—",
        supplier: value.supplier || "—",
        store: store.key,
        storeName: store.name,
        type: "BOM",
        status: "Processed",
        date: value.date || null,
      });
    }
  });

  return Array.from(products.values()).sort((a, b) =>
    a.code.localeCompare(b.code)
  );
}


/* ==================================================
   PRODUCTS API
================================================== */
app.get("/api/products", (req, res) => {
  try {
    const requestedStore = String(req.query.store || "akl")
      .trim()
      .toLowerCase();

    /* ----------------------------------------------
       ALL STORES
    ---------------------------------------------- */
    if (requestedStore === "all") {
      const allProducts = [];

      Object.values(STORES).forEach((store) => {
        const products = getProcessedProductDetails(store);
        allProducts.push(...products);
      });

      // Remove duplicate store + product combinations
      const unique = new Map();

      allProducts.forEach((product) => {
        const key = `${product.store}:${product.code}`;
        if (!unique.has(key)) {
          unique.set(key, product);
        }
      });

      return res.json(
        Array.from(unique.values()).sort((a, b) =>
          a.code.localeCompare(b.code)
        )
      );
    }

    /* ----------------------------------------------
       SINGLE STORE
    ---------------------------------------------- */
    const store = getStore(requestedStore);

    return res.json(getProcessedProductDetails(store));

  } catch (err) {
    console.error("Products error:", err);

    return res.status(500).json({
      error: err.message,
    });
  }
});

// ==================================================
// BLOCKED PRODUCTS
// ==================================================
app.get("/api/blocked", (req, res) => {
  try {
    const store = getStore(req.query.store);
    const state = loadState(store);
    const result = getAllBlockedProducts(store, state);

    res.json(result);
  } catch (err) {
    console.error("Blocked products error:", err);
    res.status(500).json({ error: err.message });
  }
});


// ==================================================
// LOGS
// ==================================================
app.get("/api/logs", (req, res) => {
  const store = getStore(req.query.store);
  res.json(loadLogs(store).slice(0, 200));
});


function saveState(store, state) {
  if (!store || !store.stateFile) {
    throw new Error("Store state file is not configured.");
  }

  ensureParentDirectory(store.stateFile);

  fs.writeFileSync(
    store.stateFile,
    JSON.stringify(state, null, 2),
    "utf8"
  );

  console.log(
    `[STATE] ${store.shortName} state saved to ${store.stateFile}`
  );
}

// ==================================================
// MARK RESOLVED
// ==================================================
app.post("/api/resolve", async (req, res) => {
  try {
    const {
      code,
      poNumber,
      supplierName,
      reason,
      source,
      store: requestedStore,
    } = req.body;

    if (!code || !poNumber) {
      return res.status(400).json({
        ok: false,
        error: "Product code and PO number are required",
      });
    }

    const store = getStore(requestedStore);

    const normalisedCode = String(code).trim().toUpperCase();
    const normalisedSource = String(source || "").trim().toLowerCase();
    const normalisedReason = String(reason || "").trim().toLowerCase();

    logEvent(
      store,
      "info",
      `${normalisedCode}: Mark Resolved clicked for ${store.shortName}`
    );

    // ==================================================
    // SHOPIFY LISTING BLOCK
    // ==================================================
    if (normalisedSource === "shopify-listing" || normalisedSource === "shopify") {
      logEvent(
        store,
        "info",
        `${normalisedCode}: Shopify block resolved from dashboard - starting store-specific resolve script`
      );

      logEvent(
        store,
        "info",
        `${normalisedCode}: Shopify listing reason was "${normalisedReason || "unknown"}"`
      );

      const listingSuccess = runResolveBlocked(
        store,
        normalisedCode,
        poNumber,
        supplierName,
        reason,
        normalisedSource
      );

      if (!listingSuccess) {
        logEvent(
          store,
          "error",
          `${normalisedCode}: resolve script failed - Shopify block remains active`
        );

        return res.status(500).json({
          ok: false,
          code: normalisedCode,
          store: store.key,
          source: "shopify-listing",
          error: "Shopify listing retry failed. Product remains blocked.",
        });
      }

      markShopifyBlockResolved(store, normalisedCode);

      logEvent(
        store,
        "success",
        `${normalisedCode}: resolve script completed successfully - Shopify block marked resolved`
      );

      return res.json({
        ok: true,
        code: normalisedCode,
        store: store.key,
        source: "shopify-listing",
        message: `${store.shortName} Shopify listing retry completed successfully and block was resolved.`,
      });
    }

    // ==================================================
    // BOM BLOCK
    // ==================================================
    const state = loadState(store);
    const now = new Date().toISOString();

    delete state[`blocked:${normalisedCode}`];

    state[`inv:${poNumber}:${normalisedCode}`] = {
      done: true,
      date: now,
      supplier: supplierName || null,
      note: "manually actioned by staff via dashboard",
    };

    state[`title:${normalisedCode}`] = {
      done: true,
      date: now,
      supplier: supplierName || null,
      note: "manually actioned by staff via dashboard",
    };

    saveState(store, state);

    logEvent(
      store,
      "success",
      `Staff resolved ${normalisedCode} BOM block via ${store.shortName} dashboard`
    );

    return res.json({
      ok: true,
      code: normalisedCode,
      store: store.key,
      source: "bom-automation",
    });
  } catch (err) {
    console.error("Resolve error:", err);

    logEvent(
      getStore(req.body?.store),
      "error",
      `Resolve endpoint crashed: ${err.message}`
    );

    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});


// ==================================================
// RUN AUTOMATION NOW
// ==================================================
function startStoreAutomation(store) {
  const scriptPath = store.automationScript;

  if (!fs.existsSync(scriptPath)) {
    logEvent(
      store,
      "error",
      `Automation script not found: ${scriptPath}`
    );

    return {
      ok: false,
      store: store.key,
      storeName: store.name,
      error: `${store.shortName} automation script not found: ${scriptPath}`,
    };
  }

  try {
    const child = spawn(process.execPath, [scriptPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      cwd: ROOT_DIR,
    });

    child.unref();

    logEvent(
      store,
      "info",
      `Manual ${path.basename(scriptPath)} run triggered from dashboard`
    );

    return {
      ok: true,
      store: store.key,
      storeName: store.name,
      pid: child.pid,
      script: path.basename(scriptPath),
    };

  } catch (err) {
    logEvent(
      store,
      "error",
      `Could not start ${store.shortName} automation: ${err.message}`
    );

    return {
      ok: false,
      store: store.key,
      storeName: store.name,
      error: err.message,
    };
  }
}


app.post("/api/run-now", (req, res) => {
  try {
    const requestedStore = String(
      req.query.store || req.body?.store || "akl"
    )
      .trim()
      .toLowerCase();


    // ==================================================
    // ALL STORES
    // ==================================================
    if (requestedStore === "all") {
      const results = [];

      for (const storeKey of ["akl", "wlg", "chch"]) {
        const store = STORES[storeKey];

        const result = startStoreAutomation(store);

        results.push(result);
      }

      const failed = results.filter(
        (result) => !result.ok
      );


      // --------------------------------------------------
      // ALL FAILED
      // --------------------------------------------------
      if (failed.length === results.length) {
        return res.status(500).json({
          ok: false,
          store: "all",
          results,
          error: "Could not start any store automation.",
        });
      }


      // --------------------------------------------------
      // LOG ALL STORES RUN
      // --------------------------------------------------
      logEvent(
        STORES.akl,
        "info",
        "Manual ALL STORES automation run triggered from dashboard"
      );


      // --------------------------------------------------
      // RETURN RESULT
      // --------------------------------------------------
      return res.json({
        ok: true,
        store: "all",
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
    const store = getStore(requestedStore);

    const result = startStoreAutomation(store);


    if (!result.ok) {
      return res.status(500).json(result);
    }


    return res.json({
      ok: true,
      store: store.key,
      storeName: store.name,
      pid: result.pid,
      script: result.script,
      message:
        `${store.shortName} automation started successfully.`,
    });

  } catch (err) {
    console.error("Run-now error:", err);

    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});


// ==================================================
// STORE CONFIG
// ==================================================
app.get("/api/stores", (req, res) => {
  res.json(
    Object.values(STORES).map((store) => ({
      key: store.key,
      name: store.name,
      shortName: store.shortName,
      shopifyTag: store.shopifyTag,
      metafield:
        `${store.shopifyMetafieldNamespace}.${store.shopifyMetafieldKey}`,
    }))
  );
});


// ==================================================
// ROOT
// ==================================================
app.get("/", (req, res) => {
  res.sendFile(path.join(ROOT_DIR, "dashboard", "index.html"));
});


// ==================================================
// START
// ==================================================
app.listen(PORT, () => {
  console.log("");
  console.log("======================================");
  console.log(" TSB PRE-SALE DASHBOARD");
  console.log("======================================");
  console.log(` Dashboard: http://localhost:${PORT}/`);
  console.log(` API: http://localhost:${PORT}/api/overview`);
  console.log("");
  console.log(" STORES");
  console.log(" --------------------------------------");
  console.log(" AKL → Auckland");
  console.log(" WLG → Wellington");
  console.log(" CHCH → Christchurch");
  console.log(" --------------------------------------");
  console.log("");
  console.log(" Store-specific endpoints:");
  console.log(" /api/overview?store=akl");
  console.log(" /api/overview?store=wlg");
  console.log(" /api/overview?store=chch");
  console.log("");
  console.log(` Automation interval: ${AUTOMATION_INTERVAL_HOURS} hours`);
  console.log("======================================");
  console.log("");
});
