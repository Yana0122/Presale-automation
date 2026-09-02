require("dotenv").config();
const OAuth = require("oauth-1.0a");
const crypto = require("crypto");

const oauth = OAuth({
  consumer: { key: process.env.TV_CONSUMER_KEY, secret: process.env.TV_CONSUMER_SECRET },
  signature_method: "HMAC-SHA1",
  hash_function: (base, key) => crypto.createHmac("sha1", key).update(base).digest("base64"),
});
const token = { key: process.env.TV_ACCESS_TOKEN, secret: process.env.TV_ACCESS_TOKEN_SECRET };

async function apiGet(url) {
  const authHeader = oauth.toHeader(oauth.authorize({ url, method: "GET" }, token));
  const res = await fetch(url, { method: "GET", headers: { ...authHeader, Accept: "application/json" } });
  const text = await res.text();
  return { status: res.status, text };
}

// Returns true if "Pre Order-N" exists as a real warehouse in Tradevine
async function warehouseExists(code) {
  const url = `https://api.tradevine.com/v1/ProductInventory/GetProductsByWarehouse?warehouseCode=${encodeURIComponent(code)}&pageSize=1`;
  const { status } = await apiGet(url);
  return status === 200; // 200 = exists (even if empty), 500 = doesn't exist
}

// Finds the next Pre Order-N that (a) actually exists in Tradevine and (b) isn't already assigned to another product
async function findNextFreeWarehouse(state) {
  const usedCodes = new Set(
    Object.values(state)
      .filter((v) => v && v.warehouseCode)
      .map((v) => v.warehouseCode)
  );

  let n = 1;
  const MAX_CHECK = 200;

  while (n <= MAX_CHECK) {
    const code = `Pre Order-${n}`;

    if (!usedCodes.has(code)) {
      const exists = await warehouseExists(code);
      if (exists) {
        return code;
      } else {
        throw new Error(
          `No free warehouse available — "${code}" doesn't exist yet. Staff need to create it in Tradevine (Settings → Warehouses).`
        );
      }
    }
    n++;
  }

  throw new Error(`Checked ${MAX_CHECK} warehouse numbers with no free one found — check for a bug or raise the limit.`);
}

// Returns the warehouse code already assigned to this product, or assigns + records the next free one.
async function getOrAssignWarehouse(productCode, state) {
  const key = `warehouse:${productCode}`;

  if (state[key]) {
    return state[key].warehouseCode;
  }

  const code = await findNextFreeWarehouse(state);
  state[key] = { warehouseCode: code, date: new Date().toISOString() };
  console.log(`  Assigned ${productCode} → ${code}`);
  return code;
}

module.exports = { getOrAssignWarehouse, warehouseExists };