require("dotenv").config();
const fs = require("fs");
const path = require("path");

const LOG_FILE = "./automation.log";

function log(type, msg) {
  const entry = {
    time: new Date().toISOString(),
    type,
    msg
  };

  console.log(`[${type.toUpperCase()}] ${msg}`);
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
}

const OAuth = require("oauth-1.0a");
const crypto = require("crypto");
const JSONbig = require("json-bigint")({ storeAsString: true });

const oauth = OAuth({
  consumer: { key: process.env.TV_CONSUMER_KEY, secret: process.env.TV_CONSUMER_SECRET },
  signature_method: "HMAC-SHA1",
  hash_function: (base, key) => crypto.createHmac("sha1", key).update(base).digest("base64"),
});
const token = { key: process.env.TV_ACCESS_TOKEN, secret: process.env.TV_ACCESS_TOKEN_SECRET };

// const WAREHOUSE_ID = "3920199020988197194"; // Pre Order-1
const { getOrAssignWarehouse } = require("./warehouse-assignment");
const PRESALE_QTY = 5;
const STATE_FILE = path.join(
  __dirname,
  "../json/AKL/processed-state.json"
);

// ---------- state (memory of what's already been done) ----------
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------- cycle-aware state helpers ----------

function isSameCycle(stateEntry, poNumber) {
  return (
    stateEntry &&
    String(stateEntry.poNumber || "").toUpperCase() ===
      String(poNumber || "").toUpperCase()
  );
}

// ---------- helpers ----------
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

async function apiGet(url) {
  const authHeader = oauth.toHeader(oauth.authorize({ url, method: "GET" }, token));
  const res = await fetch(url, { method: "GET", headers: { ...authHeader, Accept: "application/json" } });
  const text = await res.text();
  return { status: res.status, data: JSONbig.parse(text) };
}

async function apiPost(url, body) {
  const authHeader = oauth.toHeader(oauth.authorize({ url, method: "POST" }, token));
  const res = await fetch(url, {
    method: "POST",
    headers: { ...authHeader, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try { return { status: res.status, data: JSONbig.parse(text), raw: text }; }
  catch { return { status: res.status, data: null, raw: text }; }
}

// ---------- get ALL awaiting-receipt POs, not just one ----------
async function getAllAwaitingReceiptPOs() {
  const url = `https://api.tradevine.com/v1/PurchaseOrder?status=19001&pageSize=200`;
  const { data } = await apiGet(url);
  return data.List || [];
}

async function getProductByCode(code) {
  const url = `https://api.tradevine.com/v1/Product?code=${encodeURIComponent(code)}&pageSize=10`;
  const { data } = await apiGet(url);
  const list = data.List || data;
  return list.find((p) => p.Code === code) || null;
}

async function addInventory(productCode, quantity, warehouseCode) {

  const url = `https://api.tradevine.com/v1/ProductInventory/MakeAdjustment`;
  const body = {
    ProductCode: productCode,
    WarehouseCode: warehouseCode,
    InventoryType: 36009,
    QuantityChange: quantity,
    ProductCostPrice: 0.00,
    Notes: "Presale automation - initial stock",
  };
  const { status, raw } = await apiPost(url, body);
  log(
  status === 200 ? "success" : "error",
  `Inventory +${quantity} on ${productCode}: ${status === 200 ? "OK" : "FAILED - " + raw.slice(0, 200)}`
);
  return status === 200;
}

// async function prefixTitle(product, state, poNumber, supplierName) {
//   if (product.Name.startsWith("DS ")) {
//     console.log(`      Title already prefixed on ${product.Code}: "${product.Name}" — skipping`);
//     return true;
//   }
//   const newName = withDsPrefix(product.Name);
// if (newName.length > 80) {
//   state[`blocked:${product.Code}`] = {
//     poNumber,
//     supplier: supplierName,
//     reason: "Title exceeds 80 chars",
//     detectedAt: new Date().toISOString(),
//     productCode: product.Code
//   };

//   saveState(state);

//   log(
//     "warn",
//     `${product.Code} — title exceeds 80 chars, blocked`
//   );

//   return false;
// }
// }

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

  // ---- this part was missing ----
  const url = `https://api.tradevine.com/v1/Product/${product.ProductID}`;
  const { status, data, raw } = await apiPost(url, { ...product, Name: newName });

  log(
    status === 200 ? "success" : "error",
    `Title update on ${product.Code}: ${status === 200 ? `OK — "${data.Name}"` : "FAILED - " + raw.slice(0, 200)}`
  );

  return status === 200;
}

async function linkChildrenToParent(parent, childProductIds) {
  const existing = (parent.BoMComponents || []).filter((c) => c.BoMComponentProductID);
  const existingIds = new Set(existing.map((c) => String(c.BoMComponentProductID)));
  const newOnes = childProductIds.filter((id) => !existingIds.has(String(id)));

  if (newOnes.length === 0) {
    console.log(`      BOM link already complete for ${parent.Code}`);
    return true;
  }

  const merged = [
    ...existing.map((c) => ({ BoMComponentProductID: c.BoMComponentProductID, BoMComponentQuantity: c.BoMComponentQuantity || 1 })),
    ...newOnes.map((id) => ({ BoMComponentProductID: id, BoMComponentQuantity: 1 })),
  ];

  const url = `https://api.tradevine.com/v1/Product/SaveBoMComponents/${parent.ProductID}`;
  const { status, raw } = await apiPost(url, merged);
  console.log(`      BOM link for ${parent.Code}: ${status === 200 ? "OK" : "FAILED - " + raw.slice(0, 200)}`);
  return status === 200;
}
const GRADUATED_FILE = "./graduated-this-week.json";

function loadGraduated() {
  if (!fs.existsSync(GRADUATED_FILE)) return {};

  try {
    return JSON.parse(
      fs.readFileSync(GRADUATED_FILE, "utf8")
    );
  } catch {
    return {};
  }
}

function saveGraduated(data) {
  fs.writeFileSync(
    GRADUATED_FILE,
    JSON.stringify(data, null, 2)
  );
}

function recordGraduation(productCode, extra = {}) {
  const graduated = loadGraduated();

  graduated[productCode] = {
    productCode,
    date: new Date().toISOString(),
    ...extra
  };

  // Keep only the last 7 days
  const cutoff =
    Date.now() - 7 * 24 * 60 * 60 * 1000;

  for (const [code, entry] of Object.entries(graduated)) {
    if (
      !entry.date ||
      new Date(entry.date).getTime() < cutoff
    ) {
      delete graduated[code];
    }
  }

  saveGraduated(graduated);
}

// ---------- main ----------
async function main() {
  const state = loadState();
  const allPos = await getAllAwaitingReceiptPOs();

  // ---- SAFETY RESTRICTION: live account first test — only this PO ----
  const ALLOWED_PO_NUMBERS = ["PO4447"];
  const pos = allPos.filter((po) => ALLOWED_PO_NUMBERS.includes(po.OrderNumber));

  console.log(`Found ${allPos.length} total Awaiting Receipt PO(s) on this account.`);
  console.log(`Restricted to: ${ALLOWED_PO_NUMBERS.join(", ")}`);
  console.log(`Will process: ${pos.map((p) => p.OrderNumber).join(", ") || "(none matched — check PO number/status)"}\n`);

  const EXCLUDED_SUPPLIERS = ["Parmco Ltd"];

  for (const po of pos) {
    // ...rest of the loop body stays exactly the same as your current file
    const supplierName = po.Supplier?.Name || "";

    if (EXCLUDED_SUPPLIERS.some((s) => s.toLowerCase() === supplierName.toLowerCase())) {
        console.log(`=== ${po.OrderNumber} — SKIPPED (excluded supplier: "${supplierName}") ===\n`);
        continue;
    }

    console.log(`=== ${po.OrderNumber} (Supplier: ${supplierName}) ===`);
    // ...rest of existing loop body unchanged

    const childrenByParent = {};
    const standalone = [];

    for (const line of po.PurchaseOrderLines) {
      const { data: product } = await apiGet(`https://api.tradevine.com/v1/Product/${line.productId || line.ProductID}`);
      if (isExcludedByTitle(product.Name)) {
        console.log(`  ${product.Code}: title contains "NZ MADE" — excluded, skipping`);
        continue;
    }
      if (isChildCode(product.Code)) {
        const parentCode = parentCodeFromChildCode(product.Code);
        if (!childrenByParent[parentCode]) childrenByParent[parentCode] = [];
        childrenByParent[parentCode].push(product);
      } else {
        standalone.push(product);
      }
    }

    // --- BOM parent groups ---
    for (const parentCode of Object.keys(childrenByParent)) {
      console.log(`  Parent group: ${parentCode}`);
      const children = childrenByParent[parentCode];

      for (const child of children) {
        const invKey = `inv:${po.OrderNumber}:${child.Code}`;
        if (state[invKey]) {
          console.log(`    ${child.Code}: inventory already added for this PO — skipping`);
          continue;
        }
        const warehouseCode = await getOrAssignWarehouse(child.Code, state);
        const ok = await addInventory(child.Code, PRESALE_QTY, warehouseCode);
        if (ok) state[invKey] = { done: true, date: new Date().toISOString(), supplier: po.Supplier?.Name || null };
      }

      const parent = await getProductByCode(parentCode);
      if (!parent) {
        console.log(`    BLOCKED: could not find parent product for code ${parentCode}`);
        continue;
      }

      if (isExcludedByTitle(parent.Name)) {
        console.log(`    ${parent.Code}: title contains "NZ MADE" — excluded, skipping`);
        continue;
    }

      const bomKey = `bom:${parentCode}`;

      if (!isSameCycle(state[bomKey], po.OrderNumber)) {
        const ok = await linkChildrenToParent(
          parent,
          children.map((c) => c.ProductID)
        );

        if (ok) {
          state[bomKey] = {
            done: true,
            poNumber: po.OrderNumber,
            date: new Date().toISOString(),
            supplier: po.Supplier?.Name || null,
          };
        }
      } else {
        console.log(
          `    BOM already recorded for ${parentCode} in ${po.OrderNumber} — skipping`
        );
      }

      const titleKey = `title:${parentCode}`;

      if (!isSameCycle(state[titleKey], po.OrderNumber)) {
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
            poNumber: po.OrderNumber,
            date: new Date().toISOString(),
            supplier: po.Supplier?.Name || null,
          };
        }
      } else {
        console.log(
          `    Title already recorded for ${parentCode} in ${po.OrderNumber} — skipping`
        );
      }
    }

    // --- standalone products ---
    for (const product of standalone) {
      console.log(`  Standalone: ${product.Code}`);

      const invKey = `inv:${po.OrderNumber}:${product.Code}`;
      if (!state[invKey]) {
        const warehouseCode = await getOrAssignWarehouse(product.Code, state);
        const ok = await addInventory(product.Code, PRESALE_QTY, warehouseCode);
        if (ok) state[invKey] = { done: true, date: new Date().toISOString(), supplier: po.Supplier?.Name || null };
        } else {
        console.log(`    Inventory already added for this PO — skipping`);
      }

      const titleKey = `title:${product.Code}`;

      if (!isSameCycle(state[titleKey], po.OrderNumber)) {
        const ok = await prefixTitle(
          product,
          state,
          po.OrderNumber,
          po.Supplier?.Name || null
        );

        if (ok) {
          state[titleKey] = {
            done: true,
            poNumber: po.OrderNumber,
            date: new Date().toISOString(),
            supplier: po.Supplier?.Name || null,
          };
        }
      } else {
        console.log(
          `    Title already recorded for ${product.Code} in ${po.OrderNumber} — skipping`
        );
      }
    }

    console.log("");
  }

  saveState(state);
  console.log("Done. State saved to", STATE_FILE);
}

main().catch((err) => console.error("SCRIPT CRASHED:", err));