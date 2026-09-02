require("dotenv").config();
const fs = require("fs");
const path = require("path");

const LOG_FILE = "./automation.log";

// --------------------------------------------------
// LOGGING
// --------------------------------------------------

function log(type, msg) {
  const entry = {
    time: new Date().toISOString(),
    type,
    msg,
  };

  console.log(`[${type.toUpperCase()}] ${msg}`);
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
}

const OAuth = require("oauth-1.0a");
const crypto = require("crypto");
const JSONbig = require("json-bigint")({ storeAsString: true });

// --------------------------------------------------
// TRADEVINE AUTH
// --------------------------------------------------

const oauth = OAuth({
  consumer: {
    key: process.env.CHCH_TV_CONSUMER_KEY,
    secret: process.env.CHCH_TV_CONSUMER_SECRET,
  },
  signature_method: "HMAC-SHA1",
  hash_function: (base, key) =>
    crypto.createHmac("sha1", key).update(base).digest("base64"),
});

const token = {
  key: process.env.CHCH_TV_ACCESS_TOKEN,
  secret: process.env.CHCH_TV_ACCESS_TOKEN_SECRET,
};

// --------------------------------------------------
// SHARED AKL WAREHOUSE ASSIGNMENT
// --------------------------------------------------

const { getOrAssignWarehouse } = require("../AKL/warehouse-assignment");

const PRESALE_QTY = 5;

// --------------------------------------------------
// CHCH STATE FILE
// --------------------------------------------------

const STATE_FILE = path.join(__dirname, "..", "json", "CHCH", "processed-state-chch.json");

// --------------------------------------------------
// STATE
// --------------------------------------------------

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function withDsPrefix(title) {
  return title.startsWith("DS ") ? title : `DS ${title}`;
}

function isExcludedByTitle(name) {
  return (name || "").toUpperCase().includes("NZ MADE");
}

function isChildCode(code) {
  return /^.+-[A-Za-z0-9]+$/.test(code);
}

function parentCodeFromChildCode(childCode) {
  return childCode.replace(/-[A-Za-z0-9]+$/, "");
}

// --------------------------------------------------
// REQUIRED PRODUCT DATA CHECK
// --------------------------------------------------

function hasRequiredProductData(product) {
  const description = String(
    product.Description ??
    product.DescriptionHtml ??
    ""
  ).trim();

  const price = Number(
    product.Price ??
    product.SellingPrice ??
    product.RetailPrice ??
    0
  );

  return {
    valid: description.length > 0 && price > 0,
    hasDescription: description.length > 0,
    hasPrice: price > 0,
  };
}

function blockMissingProductData(
  product,
  state,
  poNumber,
  supplierName
) {
  const check = hasRequiredProductData(product);

  if (check.valid) {
    return false;
  }

  const missing = [];

  if (!check.hasDescription) {
    missing.push("description");
  }

  if (!check.hasPrice) {
    missing.push("price");
  }

  const reason = `Missing ${missing.join(" and ")}`;

  state[`blocked:${product.Code}`] = {
    poNumber,
    supplier: supplierName,
    reason,
    detectedAt: new Date().toISOString(),
    productCode: product.Code,
  };

  saveState(state);

  log(
    "warn",
    `${product.Code} — BLOCKED: ${reason}`
  );

  console.log(
    `    ${product.Code}: BLOCKED — ${reason}`
  );

  return true;
}

// --------------------------------------------------
// API GET
// --------------------------------------------------

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

  return {
    status: res.status,
    data: JSONbig.parse(text),
  };
}

// --------------------------------------------------
// API POST
// --------------------------------------------------

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

// --------------------------------------------------
// GET ALL AWAITING RECEIPT POS
// --------------------------------------------------

async function getAllAwaitingReceiptPOs() {
  const url = "https://api.tradevine.com/v1/PurchaseOrder?status=19001&pageSize=200";
  const { data } = await apiGet(url);
  return data.List || [];
}

// --------------------------------------------------
// GET PRODUCT BY CODE
// --------------------------------------------------

async function getProductByCode(code) {
  const url = `https://api.tradevine.com/v1/Product?code=${encodeURIComponent(code)}&pageSize=10`;
  const { data } = await apiGet(url);

  const list = data.List || data;
  return list.find((p) => p.Code === code) || null;
}

// --------------------------------------------------
// ADD INVENTORY
// --------------------------------------------------

async function addInventory(productCode, quantity, warehouseCode) {
  const url = "https://api.tradevine.com/v1/ProductInventory/MakeAdjustment";

  const body = {
    ProductCode: productCode,
    WarehouseCode: warehouseCode,
    InventoryType: 36009,
    QuantityChange: quantity,
    ProductCostPrice: 0.0,
    Notes: "Presale automation - initial stock",
  };

  const { status, raw } = await apiPost(url, body);

  log(
    status === 200 ? "success" : "error",
    `Inventory +${quantity} on ${productCode}: ${
      status === 200 ? "OK" : "FAILED - " + raw.slice(0, 200)
    }`
  );

  return status === 200;
}

// --------------------------------------------------
// PREFIX DS TITLE
// --------------------------------------------------

async function prefixTitle(product, state, poNumber, supplierName) {
  if (product.Name.startsWith("DS ")) {
    console.log(`      Title already prefixed on ${product.Code}: "${product.Name}" — skipping`);
    return true;
  }

  const newName = withDsPrefix(product.Name);

  if (newName.length > 80) {
    state[`blocked:${product.Code}`] = {
      poNumber,
      supplier: supplierName,
      reason: "Title exceeds 80 chars",
      detectedAt: new Date().toISOString(),
      productCode: product.Code,
    };

    saveState(state);

    log("warn", `${product.Code} — title exceeds 80 chars, blocked`);
    return false;
  }

  const url = `https://api.tradevine.com/v1/Product/${product.ProductID}`;

  const { status, data, raw } = await apiPost(url, { ...product, Name: newName });

  log(
    status === 200 ? "success" : "error",
    `Title update on ${product.Code}: ${
      status === 200 ? `OK — "${data.Name}"` : "FAILED - " + raw.slice(0, 200)
    }`
  );

  return status === 200;
}

// --------------------------------------------------
// LINK BOM CHILDREN
// --------------------------------------------------

async function linkChildrenToParent(parent, childProductIds) {
  const existing = (parent.BoMComponents || []).filter((c) => c.BoMComponentProductID);
  const existingIds = new Set(existing.map((c) => String(c.BoMComponentProductID)));

  const newOnes = childProductIds.filter((id) => !existingIds.has(String(id)));

  if (newOnes.length === 0) {
    console.log(`      BOM link already complete for ${parent.Code}`);
    return true;
  }

  const merged = [
    ...existing.map((c) => ({
      BoMComponentProductID: c.BoMComponentProductID,
      BoMComponentQuantity: c.BoMComponentQuantity || 1,
    })),
    ...newOnes.map((id) => ({
      BoMComponentProductID: id,
      BoMComponentQuantity: 1,
    })),
  ];

  const url = `https://api.tradevine.com/v1/Product/SaveBoMComponents/${parent.ProductID}`;
  const { status, raw } = await apiPost(url, merged);

  console.log(`      BOM link for ${parent.Code}: ${status === 200 ? "OK" : "FAILED - " + raw.slice(0, 200)}`);

  return status === 200;
}

// --------------------------------------------------
// MAIN
// --------------------------------------------------

async function main() {
  const state = loadState();
  const allPos = await getAllAwaitingReceiptPOs();

  const ALLOWED_PO_NUMBERS = ["PO1589"];

  const pos = allPos.filter((po) => ALLOWED_PO_NUMBERS.includes(po.OrderNumber));

  console.log(`Found ${allPos.length} total Awaiting Receipt PO(s) on this account.`);
  console.log(`Restricted to: ${ALLOWED_PO_NUMBERS.join(", ")}`);
  console.log(
    `Will process: ${
      pos.map((p) => p.OrderNumber).join(", ") || "(none matched — check PO number/status)"
    }\n`
  );

  const EXCLUDED_SUPPLIERS = ["Parmco Ltd"];

  for (const po of pos) {
    const supplierName = po.Supplier?.Name || "";

    if (EXCLUDED_SUPPLIERS.some((s) => s.toLowerCase() === supplierName.toLowerCase())) {
      console.log(`=== ${po.OrderNumber} — SKIPPED (excluded supplier: "${supplierName}") ===\n`);
      continue;
    }

    console.log(`=== ${po.OrderNumber} (Supplier: ${supplierName}) ===`);

    const childrenByParent = {};
    const standalone = [];

    // ------------------------------------------------
    // READ PO PRODUCTS
    // ------------------------------------------------

    for (const line of po.PurchaseOrderLines) {
      const { data: product } = await apiGet(
        `https://api.tradevine.com/v1/Product/${line.productId || line.ProductID}`
      );

      if (isExcludedByTitle(product.Name)) {
        console.log(`  ${product.Code}: title contains "NZ MADE" — excluded, skipping`);
        continue;
      }

      if (isChildCode(product.Code)) {
        const parentCode = parentCodeFromChildCode(product.Code);

        if (!childrenByParent[parentCode]) {
          childrenByParent[parentCode] = [];
        }

        childrenByParent[parentCode].push(product);
      } else {
        standalone.push(product);
      }
    }

    // ------------------------------------------------
    // BOM PARENT GROUPS
    // ------------------------------------------------

    for (const parentCode of Object.keys(childrenByParent)) {
      console.log(`  Parent group: ${parentCode}`);

      const children = childrenByParent[parentCode];

      // ----------------------------------------------
      // CHILD INVENTORY
      // ----------------------------------------------

      for (const child of children) {
        if (
          blockMissingProductData(
            child,
            state,
            po.OrderNumber,
            po.Supplier?.Name || null
          )
        ) {
          continue;
        }

        const invKey = `inv:${po.OrderNumber}:${child.Code}`;

        if (state[invKey]) {
          console.log(`    ${child.Code}: inventory already added for this PO — skipping`);
          continue;
        }

        const warehouseCode = await getOrAssignWarehouse(child.Code, state);
        const ok = await addInventory(child.Code, PRESALE_QTY, warehouseCode);

        if (ok) {
          state[invKey] = {
            done: true,
            date: new Date().toISOString(),
            supplier: po.Supplier?.Name || null,
          };
        }
      }

      // ----------------------------------------------
      // GET PARENT
      // ----------------------------------------------

      const parent = await getProductByCode(parentCode);

      if (!parent) {
        console.log(`    BLOCKED: could not find parent product for code ${parentCode}`);
        continue;
      }

      if (
        blockMissingProductData(
          parent,
          state,
          po.OrderNumber,
          po.Supplier?.Name || null
        )
      ) {
        continue;
      }

      // ----------------------------------------------
      // BOM LINK
      // ----------------------------------------------

      const bomKey = `bom:${parentCode}`;

      if (!state[bomKey]) {
        const ok = await linkChildrenToParent(
          parent,
          children.map((c) => c.ProductID)
        );

        if (ok) {
          state[bomKey] = {
            done: true,
            date: new Date().toISOString(),
            supplier: po.Supplier?.Name || null,
          };
        }
      } else {
        console.log(`    BOM link already recorded as done for ${parentCode}`);
      }

      // ----------------------------------------------
      // PARENT TITLE
      // ----------------------------------------------

      const titleKey = `title:${parentCode}`;

      if (!state[titleKey]) {
        const freshParent = await getProductByCode(parentCode);

        const ok = await prefixTitle(
          freshParent,
          state,
          po.OrderNumber,
          po.Supplier?.Name || null
        );

        if (ok) {
          state[titleKey] = {
            done: true,
            date: new Date().toISOString(),
            supplier: po.Supplier?.Name || null,
          };
        }
      } else {
        console.log(`    Title already recorded as done for ${parentCode}`);
      }
    }

    // ------------------------------------------------
    // STANDALONE PRODUCTS
    // ------------------------------------------------

    for (const product of standalone) {
      console.log(`  Standalone: ${product.Code}`);

      if (
        blockMissingProductData(
          product,
          state,
          po.OrderNumber,
          po.Supplier?.Name || null
        )
      ) {
        continue;
      }

      const invKey = `inv:${po.OrderNumber}:${product.Code}`;

      if (!state[invKey]) {
        const warehouseCode = await getOrAssignWarehouse(product.Code, state);
        const ok = await addInventory(product.Code, PRESALE_QTY, warehouseCode);

        if (ok) {
          state[invKey] = {
            done: true,
            date: new Date().toISOString(),
            supplier: po.Supplier?.Name || null,
          };
        }
      } else {
        console.log(`    Inventory already added for this PO — skipping`);
      }

      const titleKey = `title:${product.Code}`;

      if (!state[titleKey]) {
        const ok = await prefixTitle(
          product,
          state,
          po.OrderNumber,
          po.Supplier?.Name || null
        );

        if (ok) {
          state[titleKey] = {
            done: true,
            date: new Date().toISOString(),
            supplier: po.Supplier?.Name || null,
          };
        }
      } else {
        console.log(`    Title already recorded as done — skipping`);
      }
    }

    console.log("");
  }

  saveState(state);

  console.log("Done. State saved to", STATE_FILE);
}

// --------------------------------------------------
// RUN
// --------------------------------------------------

main().catch((err) => console.error("SCRIPT CRASHED:", err));
