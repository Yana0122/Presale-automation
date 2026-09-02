require("dotenv").config();
const OAuth = require("oauth-1.0a");
const crypto = require("crypto");

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

async function apiPost(url, body) {
  const authHeader = oauth.toHeader(
    oauth.authorize({ url, method: "POST" }, token)
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

  return {
    status: res.status,
    raw: text,
  };
}

async function run() {
  const url =
    "https://api.tradevine.com/v1/ProductInventory/MakeAdjustment";

  const body = {
    ProductCode: "PR13374", // ← use the numeric ID, like the UI does, instead of ProductCode
    WarehouseID: 3922276600514218849,
    InventoryType: 36014,
    QuantityChange: 2,
    ProductCostPrice: 0,
    Notes: "TEST",
  };

  console.log("\n===== REQUEST =====");
  console.log(JSON.stringify(body, null, 2));

  const result = await apiPost(url, body);

  console.log("\n===== RESPONSE =====");
  console.log("Status:", result.status);
  console.log(result.raw);
}

run().catch((err) => {
  console.error("CRASHED:", err);
});