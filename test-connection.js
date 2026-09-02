require("dotenv").config();
const OAuth = require("oauth-1.0a");
const crypto = require("crypto");
const JSONbig = require("json-bigint")({ storeAsString: true });

const oauth = OAuth({
  consumer: { key: process.env.TV_CONSUMER_KEY, secret: process.env.TV_CONSUMER_SECRET },
  signature_method: "HMAC-SHA1",
  hash_function: (base, key) => crypto.createHmac("sha1", key).update(base).digest("base64"),
});
const token = { key: process.env.TV_ACCESS_TOKEN, secret: process.env.TV_ACCESS_TOKEN_SECRET };

async function testConnection() {
  const url = "https://api.tradevine.com/v1/PurchaseOrder?pageSize=1";

  const authHeader = oauth.toHeader(oauth.authorize({ url, method: "GET" }, token));

  const res = await fetch(url, { method: "GET", headers: { ...authHeader, Accept: "application/json" } });
  console.log("Status:", res.status);

  const text = await res.text();
  try {
    const data = JSONbig.parse(text);
    console.log(JSON.stringify(data, null, 2));
  } catch {
    console.log("Raw response:", text);
  }
}

testConnection().catch((err) => console.error("Connection failed:", err));