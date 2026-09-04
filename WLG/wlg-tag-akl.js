require("dotenv").config();

const fs = require("fs");
const path = require("path");
const OAuth = require("oauth-1.0a");
const crypto = require("crypto");
const JSONbig = require("json-bigint")({ storeAsString: true });

// ============================================================
// CONFIG
// ============================================================

const WLG_STATE_FILE = path.join(
  __dirname,
  "../json/WLG/processed-state-wlg.json"
);

const TAG_STATE_FILE = path.join(
  __dirname,
  "../json/WLG/wlg-tag-akl-state.json"
);

const TV_API = "https://api.tradevine.com";
const REQUIRED_TAG = "Pre-Order-Wellington";

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

  let data = null;

  try {
    data = JSONbig.parse(text);
  } catch {
    data = null;
  }

  return {
    status: res.status,
    data,
    raw: text,
  };
}

// ============================================================
// API POST
// ============================================================

async function apiPost(url, body) {
  const authHeader = oauth.toHeader(
    oauth.authorize(
      {
        url,
        method: "POST",
      },
      token
    )
  );

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

  return {
    status: res.status,
    data,
    raw: text,
  };
}

// ============================================================
// LOAD WELLINGTON PROCESSED STATE
// ============================================================

function loadWellingtonState() {
  if (!fs.existsSync(WLG_STATE_FILE)) {
    throw new Error(
      `Could not find Wellington state file: ${WLG_STATE_FILE}`
    );
  }

  try {
    return JSON.parse(fs.readFileSync(WLG_STATE_FILE, "utf8"));
  } catch (err) {
    throw new Error(
      `Could not read Wellington processed state: ${err.message}`
    );
  }
}

// ============================================================
// LOAD TAG STATE
// ============================================================

function loadTagState() {
  if (!fs.existsSync(TAG_STATE_FILE)) {
    return {};
  }

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
  if (!key) {
    return null;
  }

  // inv:PO1560:PR15242
  if (key.startsWith("inv:")) {
    const parts = key.split(":");
    if (parts.length >= 3) {
      return parts.slice(2).join(":").trim().toUpperCase();
    }
  }

  // title:PR15242
  if (key.startsWith("title:")) {
    return key.replace(/^title:/i, "").trim().toUpperCase();
  }

  // bom:PR15242
  if (key.startsWith("bom:")) {
    return key.replace(/^bom:/i, "").trim().toUpperCase();
  }

  return null;
}

// ============================================================
// EXTRACT PO NUMBER FROM STATE ENTRY
// ============================================================

function extractPoNumber(value, key) {
  if (value?.poNumber) {
    return String(value.poNumber).trim().toUpperCase();
  }

  // Fallback for old inventory state format: inv:PO1560:PR15242
  if (key?.startsWith("inv:")) {
    const parts = key.split(":");
    if (parts.length >= 3) {
      return String(parts[1]).trim().toUpperCase();
    }
  }

  return null;
}

// ============================================================
// GET DATE FROM STATE ENTRY
// ============================================================

function getStateDate(value) {
  if (!value?.date) {
    return 0;
  }

  const timestamp = new Date(value.date).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

// ============================================================
// CHILD PRODUCT CHECK
// ============================================================
//
// PR15242-A
// PR15242-B
//
// These are NOT tagged individually.
// Only PR15242 is tagged.

function isChildProduct(productCode) {
  return /^PR\d+-[A-Z]$/i.test(String(productCode || "").trim());
}

// ============================================================
// GET CURRENT WLG PRODUCTS + THEIR CURRENT PO
// ============================================================
//
// IMPORTANT:
//
// processed-state-wlg.json keeps historical records.
//
// Example:
//
// inv:PO1560:PR13374
// inv:PO1600:PR13374
//
// We must NOT simply say:
// "PR13374 exists in state -> skip"
//
// Instead we find the newest completed state entry
// for that product and use its PO as the current cycle.

function getParentCode(productCode) {
  const match = String(productCode).match(/^(PR\d+)-[A-Z]$/i);
  return match ? match[1].toUpperCase() : null;
}

function getActionedProducts(state) {
  // First pass: discover PO numbers from inv: keys
  // (including child products so BOM parents get mapped too)
  const poFromInv = {};

  for (const [key, value] of Object.entries(state)) {
    if (!key.startsWith("inv:")) continue;

    const parts = key.split(":");
    if (parts.length < 3) continue;

    const po = String(parts[1]).trim().toUpperCase();
    const code = parts.slice(2).join(":").trim().toUpperCase();

    if (!po || !code) continue;

    // Map PO to the exact code found
    poFromInv[code] = po;

    // If this is a child code (PR15242-A), also map to parent (PR15242)
    const parent = getParentCode(code);
    if (parent && !poFromInv[parent]) {
      poFromInv[parent] = po;
    }
  }

  // Second pass: also pick up poNumber from any done entry
  for (const [key, value] of Object.entries(state)) {
    if (!value || !value.poNumber) continue;

    const code = extractProductCode(key);
    if (!code) continue;

    const po = String(value.poNumber).trim().toUpperCase();
    if (!poFromInv[code]) {
      poFromInv[code] = po;
    }
  }

  // Build product list from done entries
  const products = {};

  for (const [key, value] of Object.entries(state)) {
    if (!value || value.done !== true) continue;

    const productCode = extractProductCode(key);
    if (!productCode) continue;

    if (isChildProduct(productCode)) continue;

    let poNumber = extractPoNumber(value, key);
    if (!poNumber) poNumber = poFromInv[productCode] || null;

    const date = getStateDate(value);

    if (!products[productCode]) {
      products[productCode] = { productCode, poNumber, date };
      continue;
    }

    if (date >= products[productCode].date) {
      products[productCode] = { productCode, poNumber, date };
    }
  }

  return Object.values(products);
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

  const record = list.find(
    (item) =>
      String(item.ProductCode || "").toUpperCase() ===
      String(productCode).toUpperCase()
  );

  return record || null;
}

// ============================================================
// BUILD TAG LIST
// ============================================================

function addWellingtonTag(existingTags) {
  const tags = [];

  if (existingTags) {
    String(existingTags)
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
      .forEach((tag) => {
        if (
          !tags.some(
            (existing) => existing.toLowerCase() === tag.toLowerCase()
          )
        ) {
          tags.push(tag);
        }
      });
  }

  // Do not duplicate tag
  if (
    !tags.some(
      (tag) => tag.toLowerCase() === REQUIRED_TAG.toLowerCase()
    )
  ) {
    tags.push(REQUIRED_TAG);
  }

  return tags.join(", ");
}

// ============================================================
// SAVE AKL SHOPIFY TAB
// ============================================================

async function saveAklShopifyProduct(shopifyProduct) {
  const shopifyProductId = shopifyProduct.ShopifyProductID;

  if (!shopifyProductId) {
    throw new Error("ShopifyProductID missing");
  }

  const url = `${TV_API}/v1/ShopifyProduct/${shopifyProductId}`;

  console.log("");
  console.log("POST:");
  console.log(url);

  const result = await apiPost(url, shopifyProduct);
  console.log(`HTTP: ${result.status}`);

  if (result.status !== 200 && result.status !== 201) {
    throw new Error(
      `ShopifyProduct save failed (${result.status}): ${
        result.raw?.slice(0, 500) || ""
      }`
    );
  }

  return result;
}

// ============================================================
// VERIFY TAG
// ============================================================

async function verifyWellingtonTag(productCode) {
  const fresh = await findAklShopifyProduct(productCode);

  if (!fresh) {
    throw new Error("Could not reload ShopifyProduct after save");
  }

  const tags = String(fresh.Tags || "")
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);

  const found = tags.includes(REQUIRED_TAG.toLowerCase());

  if (!found) {
    throw new Error(`${REQUIRED_TAG} was not found after reload`);
  }

  return fresh;
}

// ============================================================
// TAG ONE PRODUCT
// ============================================================

async function tagProduct(productCode, currentPoNumber, tagState) {
  console.log("");
  console.log("========================================");
  console.log(`PROCESSING ${productCode}`);
  console.log(`CURRENT WLG PO: ${currentPoNumber || "UNKNOWN"}`);
  console.log("========================================");

  const savedState = tagState[productCode];
  const savedPoNumber = savedState?.poNumber
    ? String(savedState.poNumber).trim().toUpperCase()
    : null;

  const normalizedCurrentPo = currentPoNumber
    ? String(currentPoNumber).trim().toUpperCase()
    : null;

  // Safety: already completed for this exact cycle
  if (
    savedState?.done === true &&
    savedPoNumber &&
    normalizedCurrentPo &&
    savedPoNumber === normalizedCurrentPo
  ) {
    console.log(
      `${productCode}: already tagged for ${normalizedCurrentPo} — SKIPPING`
    );

    return { ok: true, skipped: true };
  }

  // Old state / different cycle
  if (
    savedState?.done === true &&
    savedPoNumber &&
    normalizedCurrentPo &&
    savedPoNumber !== normalizedCurrentPo
  ) {
    console.log(`${productCode}: previous tag cycle was ${savedPoNumber}`);
    console.log(`${productCode}: new WLG cycle detected → ${normalizedCurrentPo}`);
    console.log(`${productCode}: will process again`);
  }

  // Legacy state without PO number
  if (savedState?.done === true && !savedPoNumber) {
    console.log(`${productCode}: existing tag state has no PO number`);
    console.log(`${productCode}: treating current cycle as a new cycle`);
  }

  // Find AKL Shopify tab
  const shopifyProduct = await findAklShopifyProduct(productCode);

  if (!shopifyProduct) {
    console.log(`${productCode}: BLOCKED — no AKL ShopifyProduct record found`);

    return {
      ok: false,
      reason: "no_akl_shopify_record",
    };
  }

  console.log("");
  console.log(`${productCode}: AKL ShopifyProduct found`);
  console.log(`ShopifyProductID: ${shopifyProduct.ShopifyProductID}`);
  console.log(`Current tags: "${shopifyProduct.Tags || ""}"`);

  // Add Wellington tag
  const newTags = addWellingtonTag(shopifyProduct.Tags);

  console.log("");
  console.log(`New tags: "${newTags}"`);

  // Already has tag
  const hasTag = String(shopifyProduct.Tags || "")
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .includes(REQUIRED_TAG.toLowerCase());

  if (hasTag) {
    console.log(`${productCode}: ${REQUIRED_TAG} already exists ✓`);
    console.log(
      `${productCode}: recording it as completed for ${
        normalizedCurrentPo || "current cycle"
      }`
    );

    tagState[productCode] = {
      done: true,
      alreadyPresent: true,
      poNumber: normalizedCurrentPo,
      date: new Date().toISOString(),
      shopifyProductId: String(shopifyProduct.ShopifyProductID),
      tags: shopifyProduct.Tags,
    };

    saveTagState(tagState);

    return { ok: true, alreadyPresent: true };
  }

  // Save
  shopifyProduct.Tags = newTags;

  try {
    await saveAklShopifyProduct(shopifyProduct);

    console.log("");
    console.log(`${productCode}: tag save successful ✓`);
  } catch (err) {
    console.log("");
    console.log(`${productCode}: TAG SAVE FAILED`);
    console.log(err.message);

    return {
      ok: false,
      reason: "tag_save_failed",
      error: err.message,
    };
  }

  // Reload + verify
  try {
    const fresh = await verifyWellingtonTag(productCode);

    console.log("");
    console.log(`${productCode}: ${REQUIRED_TAG} verified ✓`);
    console.log(`Final tags: "${fresh.Tags}"`);

    // Only mark done after verification
    tagState[productCode] = {
      done: true,
      poNumber: normalizedCurrentPo,
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

    return {
      ok: false,
      reason: "verification_failed",
      error: err.message,
    };
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("");
  console.log("==============================================");
  console.log(" WLG → AKL SHOPIFY TAG AUTOMATION");
  console.log("==============================================");

  // Check AKL credentials
  const requiredEnv = [
    "TV_CONSUMER_KEY",
    "TV_CONSUMER_SECRET",
    "TV_ACCESS_TOKEN",
    "TV_ACCESS_TOKEN_SECRET",
  ];

  for (const name of requiredEnv) {
    if (!process.env[name]) {
      throw new Error(`Missing ${name} in .env`);
    }
  }

  console.log("");
  console.log("✓ Auckland Tradevine credentials found");

  // Load Wellington state
  const wlgState = loadWellingtonState();
  const products = getActionedProducts(wlgState);

  console.log("");
  console.log(
    `Found ${products.length} eligible WLG product(s) in ../json/WLG/processed-state-wlg.json.`
  );

  if (products.length === 0) {
    console.log("Nothing to process.");
    return;
  }

  console.log("");
  console.log("Products to check in AKL:");

  products.forEach((item) => {
    console.log(`  - ${item.productCode} → ${item.poNumber || "PO UNKNOWN"}`);
  });

  // Load tag state
  const tagState = loadTagState();

  let tagged = 0;
  let alreadyDone = 0;
  let blocked = 0;

  // Process
  for (const item of products) {
    const result = await tagProduct(item.productCode, item.poNumber, tagState);

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

  // Summary
  console.log("");
  console.log("==============================================");
  console.log(" WLG → AKL TAGGING COMPLETE");
  console.log("==============================================");
  console.log(`Total WLG products: ${products.length}`);
  console.log(`Newly tagged:       ${tagged}`);
  console.log(`Already tagged:     ${alreadyDone}`);
  console.log(`Blocked/failed:     ${blocked}`);
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
  console.error(" WLG → AKL TAGGING FAILED");
  console.error("==============================================");
  console.error(err.stack || err.message || err);
  process.exit(1);
});