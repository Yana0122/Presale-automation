require("dotenv").config();

const fs = require("fs");
const path = require("path");
const OAuth = require("oauth-1.0a");
const crypto = require("crypto");
const JSONbig = require("json-bigint")({ storeAsString: true });

// ============================================================
// CONFIG
// ============================================================

// Christchurch ../json/CHCH/processed-state-chch.json
const CHCH_STATE_FILE = path.join(__dirname, "../json/CHCH/processed-state-chch.json");

// Separate state for this tagging operation
const TAG_STATE_FILE = path.join(__dirname, "../json/CHCH/chch-tag-akl-state.json");

const TV_API = "https://api.tradevine.com";

// Tag we want to add to the AKL Shopify tab
const REQUIRED_TAG = "Pre-Order-Christchurch";

// ============================================================
// AUCKLAND TRADEVINE OAUTH
// ============================================================

const oauth = OAuth({
  consumer: {
    key: process.env.TV_CONSUMER_KEY,
    secret: process.env.TV_CONSUMER_SECRET,
  },
  signature_method: "HMAC-SHA1",
  hash_function: (base, key) =>
    crypto.createHmac("sha1", key).update(base).digest("base64"),
});

const token = {
  key: process.env.TV_ACCESS_TOKEN,
  secret: process.env.TV_ACCESS_TOKEN_SECRET,
};

// ============================================================
// API GET
// ============================================================

async function apiGet(url) {
  const authHeader = oauth.toHeader(oauth.authorize({ url, method: "GET" }, token));

  const res = await fetch(url, {
    method: "GET",
    headers: {
      ...authHeader,
      Accept: "application/json",
    },
  });

  const text = await res.text();

  let data = null;
  try {
    data = JSONbig.parse(text);
  } catch {
    data = null;
  }

  return { status: res.status, data, raw: text };
}

// ============================================================
// API POST
// ============================================================

async function apiPost(url, body) {
  const authHeader = oauth.toHeader(oauth.authorize({ url, method: "POST" }, token));

  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...authHeader,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();

  let data = null;
  try {
    data = JSONbig.parse(text);
  } catch {
    data = null;
  }

  return { status: res.status, data, raw: text };
}

// ============================================================
// LOAD CHRISTCHURCH PROCESSED STATE
// ============================================================

function loadChristchurchState() {
  if (!fs.existsSync(CHCH_STATE_FILE)) {
    throw new Error(`Could not find Christchurch state file: ${CHCH_STATE_FILE}`);
  }

  try {
    return JSON.parse(fs.readFileSync(CHCH_STATE_FILE, "utf8"));
  } catch (err) {
    throw new Error(`Could not read Christchurch ../json/CHCH/processed-state-chch.json: ${err.message}`);
  }
}

// ============================================================
// LOAD TAG STATE
// ============================================================

function loadTagState() {
  if (!fs.existsSync(TAG_STATE_FILE)) return {};

  try {
    return JSON.parse(fs.readFileSync(TAG_STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

// ============================================================
// SAVE TAG STATE
// ============================================================

function saveTagState(state) {
  fs.writeFileSync(TAG_STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================
// EXTRACT PRODUCT CODE
// ============================================================

function extractProductCode(key) {
  if (!key) return null;

  if (key.startsWith("inv:")) {
    const parts = key.split(":");
    if (parts.length >= 3) return parts.slice(2).join(":").trim().toUpperCase();
  }

  if (key.startsWith("title:")) {
    return key.replace(/^title:/i, "").trim().toUpperCase();
  }

  if (key.startsWith("bom:")) {
    return key.replace(/^bom:/i, "").trim().toUpperCase();
  }

  return null;
}

// ============================================================
// CHILD PRODUCT CHECK
// ============================================================

function isChildProduct(productCode) {
  return /^PR\d+-[A-Z]$/i.test(String(productCode || "").trim());
}

// ============================================================
// GET PRODUCTS THAT WERE ACTIONED IN CHRISTCHURCH
// ============================================================

function getActionedProducts(state) {
  const products = new Set();

  for (const [key, value] of Object.entries(state)) {
    if (!value || value.done !== true) continue;

    const productCode = extractProductCode(key);
    if (!productCode) continue;

    if (isChildProduct(productCode)) continue;

    products.add(productCode);
  }

  return Array.from(products);
}

// ============================================================
// FIND AKL SHOPIFY PRODUCT RECORD
// ============================================================

async function findAklShopifyProduct(productCode) {
  const url =
    `${TV_API}/v1/ShopifyProduct` +
    `?productCode=${encodeURIComponent(productCode)}` +
    `&pageSize=100`;

  console.log("");
  console.log("GET:");
  console.log(url);

  const result = await apiGet(url);

  console.log(`HTTP: ${result.status}`);

  if (result.status !== 200) {
    console.log("Response:", result.raw?.slice(0, 500));
    return null;
  }

  const list = result.data?.List || result.data?.list || [];

  return (
    list.find(
      (item) =>
        String(item.ProductCode || "").toUpperCase() === String(productCode).toUpperCase()
    ) || null
  );
}

// ============================================================
// BUILD TAG LIST
// ============================================================

function addChristchurchTag(existingTags) {
  const tags = [];

  if (existingTags) {
    String(existingTags)
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
      .forEach((tag) => {
        if (!tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) {
          tags.push(tag);
        }
      });
  }

  if (!tags.some((tag) => tag.toLowerCase() === REQUIRED_TAG.toLowerCase())) {
    tags.push(REQUIRED_TAG);
  }

  return tags.join(", ");
}

// ============================================================
// SAVE AKL SHOPIFY TAB
// ============================================================

async function saveAklShopifyProduct(shopifyProduct) {
  const shopifyProductId = shopifyProduct.ShopifyProductID;
  if (!shopifyProductId) throw new Error("ShopifyProductID missing");

  const url = `${TV_API}/v1/ShopifyProduct/${shopifyProductId}`;

  console.log("");
  console.log("POST:");
  console.log(url);

  const result = await apiPost(url, shopifyProduct);

  console.log(`HTTP: ${result.status}`);

  if (result.status !== 200 && result.status !== 201) {
    throw new Error(
      `ShopifyProduct save failed (${result.status}): ${result.raw?.slice(0, 500) || ""}`
    );
  }

  return result;
}

// ============================================================
// VERIFY TAG
// ============================================================

async function verifyChristchurchTag(productCode) {
  const fresh = await findAklShopifyProduct(productCode);

  if (!fresh) throw new Error("Could not reload ShopifyProduct after save");

  const tags = String(fresh.Tags || "")
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);

  if (!tags.includes(REQUIRED_TAG.toLowerCase())) {
    throw new Error(`${REQUIRED_TAG} was not found after reload`);
  }

  return fresh;
}

// ============================================================
// TAG ONE PRODUCT
// ============================================================

async function tagProduct(productCode, tagState) {
  console.log("");
  console.log("========================================");
  console.log(`PROCESSING ${productCode}`);
  console.log("========================================");

  if (tagState[productCode]?.done === true) {
    console.log(`${productCode}: already tagged previously — SKIPPING`);
    return { ok: true, skipped: true };
  }

  const shopifyProduct = await findAklShopifyProduct(productCode);

  if (!shopifyProduct) {
    console.log(`${productCode}: BLOCKED — no AKL ShopifyProduct record found`);
    return { ok: false, reason: "no_akl_shopify_record" };
  }

  console.log("");
  console.log(`${productCode}: AKL ShopifyProduct found`);
  console.log(`ShopifyProductID: ${shopifyProduct.ShopifyProductID}`);
  console.log(`Current tags: "${shopifyProduct.Tags || ""}"`);

  const newTags = addChristchurchTag(shopifyProduct.Tags);

  console.log("");
  console.log(`New tags: "${newTags}"`);

  if (
    String(shopifyProduct.Tags || "")
      .split(",")
      .map((tag) => tag.trim().toLowerCase())
      .includes(REQUIRED_TAG.toLowerCase())
  ) {
    console.log(`${productCode}: ${REQUIRED_TAG} already exists ✓`);

    tagState[productCode] = {
      done: true,
      alreadyPresent: true,
      date: new Date().toISOString(),
      shopifyProductId: String(shopifyProduct.ShopifyProductID),
    };

    saveTagState(tagState);

    return { ok: true, alreadyPresent: true };
  }

  shopifyProduct.Tags = newTags;

  try {
    await saveAklShopifyProduct(shopifyProduct);
    console.log("");
    console.log(`${productCode}: tag save successful ✓`);
  } catch (err) {
    console.log("");
    console.log(`${productCode}: TAG SAVE FAILED`);
    console.log(err.message);

    return { ok: false, reason: "tag_save_failed", error: err.message };
  }

  try {
    const fresh = await verifyChristchurchTag(productCode);

    console.log("");
    console.log(`${productCode}: ${REQUIRED_TAG} verified ✓`);
    console.log(`Final tags: "${fresh.Tags}"`);

    tagState[productCode] = {
      done: true,
      date: new Date().toISOString(),
      shopifyProductId: String(fresh.ShopifyProductID),
      tags: fresh.Tags,
    };

    saveTagState(tagState);

    return { ok: true, tags: fresh.Tags };
  } catch (err) {
    console.log("");
    console.log(`${productCode}: VERIFICATION FAILED`);
    console.log(err.message);

    return { ok: false, reason: "verification_failed", error: err.message };
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("");
  console.log("==============================================");
  console.log(" CHCH → AKL SHOPIFY TAG AUTOMATION");
  console.log("==============================================");

  const requiredEnv = [
    "TV_CONSUMER_KEY",
    "TV_CONSUMER_SECRET",
    "TV_ACCESS_TOKEN",
    "TV_ACCESS_TOKEN_SECRET",
  ];

  for (const name of requiredEnv) {
    if (!process.env[name]) throw new Error(`Missing ${name} in .env`);
  }

  console.log("");
  console.log("✓ Auckland Tradevine credentials found");

  const chchState = loadChristchurchState();
  const products = getActionedProducts(chchState);

  console.log("");
  console.log(
    `Found ${products.length} eligible CHCH product(s) in ../json/CHCH/processed-state-chch.json.`
  );

  if (products.length === 0) {
    console.log("Nothing to process.");
    return;
  }

  console.log("");
  console.log("Products to check in AKL:");
  products.forEach((code) => console.log(`  - ${code}`));

  const tagState = loadTagState();

  let tagged = 0;
  let alreadyDone = 0;
  let blocked = 0;

  for (const productCode of products) {
    const result = await tagProduct(productCode, tagState);

    if (result.ok) {
      if (result.skipped || result.alreadyPresent) {
        alreadyDone++;
      } else {
        tagged++;
      }
    } else {
      blocked++;
    }

    console.log("");
  }

  console.log("");
  console.log("==============================================");
  console.log(" CHCH → AKL TAGGING COMPLETE");
  console.log("==============================================");

  console.log(`Total CHCH products: ${products.length}`);
  console.log(`Newly tagged:        ${tagged}`);
  console.log(`Already tagged:      ${alreadyDone}`);
  console.log(`Blocked/failed:      ${blocked}`);
  console.log("");
  console.log(`Required tag: ${REQUIRED_TAG}`);
  console.log(`Tag state saved to: ${TAG_STATE_FILE}`);
  console.log("==============================================");
}

// ============================================================
// RUN
// ============================================================

main().catch((err) => {
  console.error("");
  console.error("==============================================");
  console.error(" CHCH → AKL TAGGING FAILED");
  console.error("==============================================");
  console.error(err.stack || err.message || err);
  process.exit(1);
});
