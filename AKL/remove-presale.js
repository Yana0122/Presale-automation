require("dotenv").config();

const fs = require("fs");
const path = require("path");
const OAuth = require("oauth-1.0a");
const crypto = require("crypto");
const JSONbig = require("json-bigint")({
  storeAsString: true,
});

const LOG_FILE = "./automation.log";
const STATE_FILE = path.join(
  __dirname,
  "..",
  "json",
  "AKL",
  "processed-state.json"
);
const GRADUATION_FILE = path.join(
  __dirname,
  "..",
  "json",
  "AKL",
  "graduated-this-week.json"
);

const TV_API = "https://api.tradevine.com";
const SHOPIFY_API_VERSION = "2026-07";

const REAL_WAREHOUSE_PATTERN =
  /^\d{1,2}-\d{1,2}-[A-Za-z]-\d{1,2}$/;

const EXCLUDED_SUPPLIERS = ["Parmco Ltd"];

const METAFIELD_NAMESPACE = "stock";
const METAFIELD_KEY = "akl_arriving_date";

/* =========================================================
   LOGGING
========================================================= */

function log(type, msg) {
  const entry = {
    time: new Date().toISOString(),
    type,
    msg,
  };

  console.log(
    `[${type.toUpperCase()}] ${msg}`
  );

  fs.appendFileSync(
    LOG_FILE,
    JSON.stringify(entry) + "\n"
  );
}

/* =========================================================
   TRADEVINE OAUTH
========================================================= */

const oauth = OAuth({
  consumer: {
    key: process.env.TV_CONSUMER_KEY,
    secret: process.env.TV_CONSUMER_SECRET,
  },

  signature_method: "HMAC-SHA1",

  hash_function: (base, key) =>
    crypto
      .createHmac("sha1", key)
      .update(base)
      .digest("base64"),
});

const token = {
  key: process.env.TV_ACCESS_TOKEN,
  secret: process.env.TV_ACCESS_TOKEN_SECRET,
};

/* =========================================================
   STATE
========================================================= */

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {};
  }

  return JSON.parse(
    fs.readFileSync(
      STATE_FILE,
      "utf8"
    )
  );
}

function saveState(state) {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      state,
      null,
      2
    )
  );
}

/* =========================================================
   EXCLUSIONS
========================================================= */

function isExcludedByTitle(name) {
  return (name || "")
    .toUpperCase()
    .includes("NZ MADE");
}

function isExcludedBySupplier(
  code,
  state
) {
  const invKeys = Object.keys(state)
    .filter(
      (k) =>
        k.startsWith("inv:") &&
        k.endsWith(`:${code}`)
    );

  return invKeys.some((k) => {
    const supplier =
      state[k].supplier;

    return (
      supplier &&
      EXCLUDED_SUPPLIERS.some(
        (s) =>
          s.toLowerCase() ===
          supplier.toLowerCase()
      )
    );
  });
}

function isBlocked(
  code,
  state
) {
  if (
    isExcludedBySupplier(
      code,
      state
    )
  ) {
    log(
      "info",
      `${code}: excluded supplier (Parmco Ltd) — skipping`
    );

    return true;
  }

  return false;
}

/* =========================================================
   TRADEVINE GET
========================================================= */

async function apiGet(url) {
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

  const res = await fetch(
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
    await res.text();

  try {
    return {
      status: res.status,
      data: JSONbig.parse(
        text
      ),
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

/* =========================================================
   TRADEVINE POST

   IMPORTANT:
   JSONbig.stringify() is required because Tradevine
   contains very large integer IDs.
========================================================= */

async function apiPost(
  url,
  body
) {
  const authHeader =
    oauth.toHeader(
      oauth.authorize(
        {
          url,
          method: "POST",
        },
        token
      )
    );

  const res = await fetch(
    url,
    {
      method: "POST",

      headers: {
        ...authHeader,
        "Content-Type":
          "application/json",
        Accept:
          "application/json",
      },

      body: JSONbig.stringify(
        body
      ),
    }
  );

  const text =
    await res.text();

  try {
    return {
      status: res.status,
      data: JSONbig.parse(
        text
      ),
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

/* =========================================================
   GET TRADEVINE PRODUCT
========================================================= */

async function getProductByCode(
  code
) {
  const url =
    `${TV_API}/v1/Product` +
    `?code=${encodeURIComponent(
      code
    )}` +
    `&pageSize=10`;

  const {
    data,
  } = await apiGet(url);

  if (!data) {
    return null;
  }

  const list =
    data.List || data;

  return (
    list.find(
      (p) => p.Code === code
    ) || null
  );
}

/* =========================================================
   GET ASSIGNED PRE-ORDER WAREHOUSE
========================================================= */

function getAssignedWarehouseCode(
  productCode,
  state
) {
  const entry =
    state[
      `warehouse:${productCode}`
    ];

  return entry
    ? entry.warehouseCode
    : null;
}

/* =========================================================
   ZERO PRE-ORDER STOCK
========================================================= */

async function zeroOutPreOrderStock(
  product,
  state
) {
  const warehouseCode =
    getAssignedWarehouseCode(
      product.Code,
      state
    );

  if (!warehouseCode) {
    log(
      "warn",
      `No stored warehouse assignment for ${product.Code} — cannot clear presale stock`
    );

    return false;
  }

  const preOrderLine =
    (
      product.PerWarehouseInventory ||
      []
    ).find(
      (w) =>
        w.WarehouseCode ===
        warehouseCode
    );

  const currentQty =
    preOrderLine
      ? preOrderLine.QuantityInStockSnapshot
      : 0;

  if (
    !currentQty ||
    currentQty <= 0
  ) {
    log(
      "info",
      `No ${warehouseCode} stock to clear (already 0) on ${product.Code}`
    );

    return true;
  }

  const url =
    `${TV_API}/v1/ProductInventory/MakeAdjustment`;

  const body = {
    ProductCode:
      product.Code,

    WarehouseCode:
      warehouseCode,

    // Confirmed correct "Reduce Stock"
    // InventoryType for this live account.
    InventoryType: 36015,

    QuantityChange:
      currentQty,

    ProductCostPrice: 0,

    Notes:
      "Presale automation - real stock arrived, clearing presale buffer",
  };

  const {
    status,
    raw,
  } = await apiPost(
    url,
    body
  );

  log(
    status === 200
      ? "success"
      : "error",

    `Zeroed ${warehouseCode} (-${currentQty}) on ${product.Code}: ${
      status === 200
        ? "OK"
        : "FAILED - " +
          (raw || "").slice(
            0,
            200
          )
    }`
  );

  return status === 200;
}

/* =========================================================
   REMOVE DS PREFIX FROM TRADEVINE PRODUCT TITLE
========================================================= */

async function stripDsPrefix(
  product
) {
  if (
    !product ||
    typeof product.Name !==
      "string"
  ) {
    log(
      "warn",
      `Cannot clean Tradevine title — invalid product`
    );

    return false;
  }

  if (
    !/^DS\s+/i.test(
      product.Name
    )
  ) {
    log(
      "info",
      `${product.Code}: title has no DS prefix already — skipping`
    );

    return true;
  }

  const newName =
    product.Name.replace(
      /^DS\s+/i,
      ""
    );

  const url =
    `${TV_API}/v1/Product/${String(
      product.ProductID
    )}`;

  const {
    status,
    data,
    raw,
  } = await apiPost(
    url,
    {
      ...product,
      Name: newName,
    }
  );

  log(
    status === 200
      ? "success"
      : "error",

    `Title reverted on ${product.Code}: ${
      status === 200
        ? `OK — "${data?.Name || newName}"`
        : "FAILED - " +
          (raw || "").slice(
            0,
            200
          )
    }`
  );

  return status === 200;
}

/* =========================================================
   REMOVE PRE-ORDER TAG
========================================================= */

function removePreOrderTag(
  tagsString
) {
  return (
    tagsString || ""
  )
    .split(",")
    .map(
      (tag) => tag.trim()
    )
    .filter(Boolean)
    .filter(
      (tag) =>
        tag.toLowerCase() !==
        "pre-order-auckland"
    )
    .join(", ");
}

/* =========================================================
   FIND TRADEVINE SHOPIFY PRODUCT RECORD

   IMPORTANT:
   Search by ProductCode instead of passing a
   Tradevine ProductID.

========================================================= */

async function getShopifyProductRecord(
  productCode
) {
  const url =
    `${TV_API}/v1/ShopifyProduct` +
    `?productCode=${encodeURIComponent(
      productCode
    )}` +
    `&pageSize=100`;

  const {
    status,
    data,
  } = await apiGet(url);

  if (
    status !== 200 ||
    !data
  ) {
    log(
      "warn",
      `${productCode}: ShopifyProduct lookup failed (HTTP ${status})`
    );

    return null;
  }

  const list =
    data.List || [];

  const record =
    list.find(
      (item) =>
        item.ProductCode ===
        productCode
    );

  if (!record) {
    log(
      "info",
      `${productCode}: no ShopifyProduct record found by ProductCode`
    );

    return null;
  }

  log(
    "info",
    `${productCode}: ShopifyProduct found — ShopifyProductID ${String(
      record.ShopifyProductID
    )}`
  );

  return record;
}

/* =========================================================
   CLEAN TRADEVINE SHOPIFY TAB

   Removes:
   - DS from Shopify tab Title
   - Pre-Order-Auckland tag

========================================================= */

async function stripDsPrefixAndTagFromShopify(
  productCode
) {
  const record =
    await getShopifyProductRecord(
      productCode
    );

  if (!record) {
    log(
      "info",
      `${productCode}: no ShopifyProduct record — skipping Shopify tab cleanup`
    );

    return true;
  }

  const updates = {};

  /* ---------- TITLE ---------- */

  if (
    typeof record.Title ===
      "string" &&
    /^DS\s+/i.test(
      record.Title
    )
  ) {
    updates.Title =
      record.Title.replace(
        /^DS\s+/i,
        ""
      );
  }

  /* ---------- TAGS ---------- */

  const cleanedTags =
    removePreOrderTag(
      record.Tags
    );

  if (
    cleanedTags !==
    (record.Tags || "").trim()
  ) {
    updates.Tags =
      cleanedTags;
  }

  /* ---------- ALREADY CLEAN ---------- */

  if (
    Object.keys(updates)
      .length === 0
  ) {
    log(
      "info",
      `${productCode}: Shopify tab already clean (title/tags)`
    );

    return true;
  }

  log(
    "info",
    `${productCode}: Shopify tab changes required`
  );

  if (
    updates.Title !==
    undefined
  ) {
    log(
      "info",
      `${productCode}: Shopify title "${record.Title}" -> "${updates.Title}"`
    );
  }

  if (
    updates.Tags !==
    undefined
  ) {
    log(
      "info",
      `${productCode}: Shopify tags "${record.Tags}" -> "${updates.Tags}"`
    );
  }

  /*
     IMPORTANT:

     ShopifyProductID is a very large Tradevine
     integer. JSONbig is used by apiPost().
  */

  const shopifyProductId =
    String(
      record.ShopifyProductID
    );

  const url =
    `${TV_API}/v1/ShopifyProduct/${shopifyProductId}`;

  const body = {
    ...record,
    ...updates,
  };

  const result =
    await apiPost(
      url,
      body
    );

  if (
    result.status !== 200
  ) {
    log(
      "error",
      `${productCode}: Shopify tab update FAILED — HTTP ${result.status}: ${
        result.raw || ""
      }`.slice(
        0,
        500
      )
    );

    return false;
  }

  log(
    "success",
    `${productCode}: Shopify tab updated (${Object.keys(
      updates
    ).join(", ")})`
  );

  /* ---------- VERIFY TRADEVINE SHOPIFY TAB ---------- */

  const verifiedRecord =
    await getShopifyProductRecord(
      productCode
    );

  if (!verifiedRecord) {
    log(
      "error",
      `${productCode}: could not verify Shopify tab after update`
    );

    return false;
  }

  const titleClean =
    !/^DS\s+/i.test(
      verifiedRecord.Title ||
        ""
    );

  const tagList =
    (
      verifiedRecord.Tags ||
      ""
    )
      .split(",")
      .map(
        (tag) =>
          tag.trim().toLowerCase()
      )
      .filter(Boolean);

  const tagClean =
    !tagList.includes(
      "pre-order-auckland"
    );

  if (
    !titleClean ||
    !tagClean
  ) {
    log(
      "error",
      `${productCode}: Shopify tab verification FAILED — title/tags are still not clean`
    );

    return false;
  }

  log(
    "success",
    `${productCode}: Shopify tab cleanup VERIFIED`
  );

  return true;
}

/* =========================================================
   SHOPIFY GRAPHQL
========================================================= */

async function shopifyGraphQL(
  query,
  variables = {}
) {
  const url =
    `https://${process.env.SHOPIFY_STORE}` +
    `/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const res = await fetch(
    url,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",

        "X-Shopify-Access-Token":
          process.env.SHOPIFY_ACCESS_TOKEN,
      },

      body: JSON.stringify({
        query,
        variables,
      }),
    }
  );

  const text =
    await res.text();

  let data;

  try {
    data = JSON.parse(
      text
    );
  } catch {
    throw new Error(
      `Shopify GraphQL returned invalid JSON: ${text}`
    );
  }

  if (!res.ok) {
    throw new Error(
      `Shopify GraphQL HTTP ${res.status}: ${text}`
    );
  }

  return data;
}

/* =========================================================
   FIND SHOPIFY PRODUCT BY SKU

   Finds:
   - Shopify Product GID
   - stock.akl_arriving_date metafield

========================================================= */

async function findShopifyProduct(
  productCode
) {
  const query = `
    query FindProduct($query: String!) {
      products(first: 10, query: $query) {
        edges {
          node {
            id
            title
            handle

            variants(first: 100) {
              edges {
                node {
                  id
                  sku
                }
              }
            }

            metafield(
              namespace: "stock"
              key: "akl_arriving_date"
            ) {
              id
              namespace
              key
              value
            }
          }
        }
      }
    }
  `;

  const result =
    await shopifyGraphQL(
      query,
      {
        query:
          `sku:${productCode}`,
      }
    );

  if (result.errors) {
    log(
      "error",
      `${productCode}: Shopify GraphQL lookup error: ${JSON.stringify(
        result.errors
      )}`
    );

    return null;
  }

  const products =
    result.data?.products
      ?.edges || [];

  if (
    products.length === 0
  ) {
    log(
      "info",
      `${productCode}: no Shopify product found by SKU`
    );

    return null;
  }

  const product =
    products[0].node;

  log(
    "info",
    `${productCode}: Shopify product found — ${product.id}`
  );

  if (
    product.metafield
  ) {
    log(
      "info",
      `${productCode}: arriving date found — ${product.metafield.value}`
    );
  } else {
    log(
      "info",
      `${productCode}: no arriving-date metafield found`
    );
  }

  return product;
}

/* =========================================================
   REMOVE ARRIVING DATE METAFIELD

   Uses the working Shopify metafieldsDelete mutation.

========================================================= */

async function clearArrivingDateMetafield(
  productCode
) {
  const product =
    await findShopifyProduct(
      productCode
    );

  if (!product) {
    log(
      "warn",
      `${productCode}: Shopify product not found — metafield cleanup skipped`
    );

    return false;
  }

  const metafield =
    product.metafield;

  if (!metafield) {
    log(
      "info",
      `${productCode}: no stock.akl_arriving_date metafield found — nothing to remove`
    );

    return true;
  }

  log(
    "info",
    `${productCode}: deleting stock.akl_arriving_date`
  );

  const mutation = `
    mutation DeleteMetafield(
      $metafields: [MetafieldIdentifierInput!]!
    ) {
      metafieldsDelete(
        metafields: $metafields
      ) {
        deletedMetafields {
          key
          namespace
          ownerId
        }

        userErrors {
          field
          message
        }
      }
    }
  `;

  const result =
    await shopifyGraphQL(
      mutation,
      {
        metafields: [
          {
            ownerId:
              product.id,

            namespace:
              METAFIELD_NAMESPACE,

            key:
              METAFIELD_KEY,
          },
        ],
      }
    );

  if (result.errors) {
    log(
      "error",
      `${productCode}: Shopify GraphQL metafield deletion error: ${JSON.stringify(
        result.errors
      )}`
    );

    return false;
  }

  const payload =
    result.data
      ?.metafieldsDelete;

  const errors =
    payload?.userErrors || [];

  if (
    errors.length > 0
  ) {
    log(
      "error",
      `${productCode}: metafield delete failed: ${JSON.stringify(
        errors
      )}`
    );

    return false;
  }

  const deleted =
    payload
      ?.deletedMetafields ||
    [];

  if (
    deleted.length > 0
  ) {
    log(
      "success",
      `${productCode}: arriving-date metafield removed`
    );
  } else {
    log(
      "info",
      `${productCode}: Shopify reported no metafield to delete`
    );
  }

  /* ---------- REMOVE FROM OUR STATE ---------- */

  const state =
    loadState();

  delete state[
    `metafield:${productCode}`
  ];

  saveState(state);

  return true;
}

/* =========================================================
   VERIFY METAFIELD REMOVED
========================================================= */

async function verifyMetafieldRemoved(
  productCode
) {
  const query = `
    query VerifyProduct($query: String!) {
      products(first: 10, query: $query) {
        edges {
          node {
            id

            metafield(
              namespace: "stock"
              key: "akl_arriving_date"
            ) {
              id
              namespace
              key
              value
            }
          }
        }
      }
    }
  `;

  const result =
    await shopifyGraphQL(
      query,
      {
        query:
          `sku:${productCode}`,
      }
    );

  if (result.errors) {
    log(
      "error",
      `${productCode}: metafield verification GraphQL error: ${JSON.stringify(
        result.errors
      )}`
    );

    return false;
  }

  const product =
    result.data?.products
      ?.edges?.[0]?.node;

  if (!product) {
    log(
      "warn",
      `${productCode}: Shopify product not found during metafield verification`
    );

    return false;
  }

  const metafield =
    product.metafield;

  if (!metafield) {
    log(
      "success",
      `${productCode}: stock.akl_arriving_date removal VERIFIED`
    );

    return true;
  }

  log(
    "error",
    `${productCode}: stock.akl_arriving_date STILL EXISTS`
  );

  return false;
}

/* =========================================================
   COMBINED SHOPIFY CLEANUP
========================================================= */

async function runShopifyGraduationCleanup(
  product
) {
  const productCode =
    product.Code;

  /* -----------------------------------------
     1. Tradevine Shopify tab
  ----------------------------------------- */

  const shopifyTabOk =
    await stripDsPrefixAndTagFromShopify(
      productCode
    );

  if (!shopifyTabOk) {
    log(
      "error",
      `${productCode}: Shopify tab cleanup failed — metafield cleanup will NOT be attempted`
    );

    return false;
  }

  /* -----------------------------------------
     2. Shopify metafield
  ----------------------------------------- */

  const metafieldOk =
    await clearArrivingDateMetafield(
      productCode
    );

  if (!metafieldOk) {
    log(
      "error",
      `${productCode}: metafield cleanup failed`
    );

    return false;
  }

  /* -----------------------------------------
     3. Verify metafield
  ----------------------------------------- */

  const verified =
    await verifyMetafieldRemoved(
      productCode
    );

  if (!verified) {
    log(
      "error",
      `${productCode}: metafield removal could not be verified`
    );

    return false;
  }

  return true;
}

/* =========================================================
   GRADUATE BOM PARENT
========================================================= */

async function graduateBomParent(
  parentCode,
  state
) {
  if (
    isBlocked(
      parentCode,
      state
    )
  ) {
    return false;
  }

  const parent =
    await getProductByCode(
      parentCode
    );

  if (!parent) {
    log(
      "warn",
      `${parentCode}: parent not found — skipping`
    );

    return false;
  }

  if (
    isExcludedByTitle(
      parent.Name
    )
  ) {
    log(
      "info",
      `${parentCode}: title contains "NZ MADE" — excluded, skipping`
    );

    return false;
  }

  const componentRefs =
    (
      parent.BoMComponents ||
      []
    ).filter(
      (c) =>
        c.BoMComponentProductCode
    );

  if (
    componentRefs.length ===
    0
  ) {
    log(
      "warn",
      `${parentCode}: no BOM components found — skipping`
    );

    return false;
  }

  log(
    "info",
    `${parentCode}: checking ${componentRefs.length} child component(s)...`
  );

  const childProducts =
    [];

  let allChildrenHaveRealStock =
    true;

  for (
    const ref of componentRefs
  ) {
    const childCode =
      ref.BoMComponentProductCode;

    const child =
      await getProductByCode(
        childCode
      );

    if (!child) {
      log(
        "warn",
        `  ${childCode}: not found — treating as not ready`
      );

      allChildrenHaveRealStock =
        false;

      continue;
    }

    const hasRealStock =
      (
        child.PerWarehouseInventory ||
        []
      ).some(
        (w) =>
          REAL_WAREHOUSE_PATTERN.test(
            w.WarehouseCode
          ) &&
          w.QuantityInStockSnapshot >
            0
      );

    log(
      "info",
      `  ${child.Code}: hasRealStock = ${hasRealStock}`
    );

    childProducts.push(
      child
    );

    if (
      !hasRealStock
    ) {
      allChildrenHaveRealStock =
        false;
    }
  }

  if (
    !allChildrenHaveRealStock
  ) {
    log(
      "info",
      `  ${parentCode}: not all children have real stock yet — no action`
    );

    return false;
  }

  log(
    "info",
    `  All children ready — graduating ${parentCode}`
  );

  /* -----------------------------------------
     Clear presale stock from children
  ----------------------------------------- */

  let allInventoryCleared =
    true;

  for (
    const child of childProducts
  ) {
    const ok =
      await zeroOutPreOrderStock(
        child,
        state
      );

    if (!ok) {
      allInventoryCleared =
        false;
    }
  }

  if (
    !allInventoryCleared
  ) {
    log(
      "error",
      `${parentCode}: one or more child presale inventory clearances failed — stopping graduation`
    );

    return false;
  }

  /* -----------------------------------------
     Refresh parent
  ----------------------------------------- */

  const freshParent =
    await getProductByCode(
      parentCode
    );

  if (!freshParent) {
    log(
      "error",
      `${parentCode}: could not refresh parent after inventory update`
    );

    return false;
  }

  /* -----------------------------------------
     Remove DS from Tradevine title
  ----------------------------------------- */

  const titleOk =
    await stripDsPrefix(
      freshParent
    );

  if (!titleOk) {
    log(
      "error",
      `${parentCode}: Tradevine title cleanup failed — Shopify cleanup will not run`
    );

    return false;
  }

  /* -----------------------------------------
     Shopify cleanup
  ----------------------------------------- */

  const shopifyOk =
    await runShopifyGraduationCleanup(
      freshParent
    );

  if (!shopifyOk) {
    log(
      "error",
      `${parentCode}: Shopify graduation cleanup failed — graduation not recorded`
    );

    return false;
  }

  /* -----------------------------------------
     Record successful graduation
  ----------------------------------------- */

  recordGraduation(
    freshParent,
    state
  );

  /* -----------------------------------------
     Remove from active state
  ----------------------------------------- */

  delete state[
    `title:${parentCode}`
  ];

  delete state[
    `bom:${parentCode}`
  ];

  delete state[
    `warehouse:${parentCode}`
  ];

  saveState(state);

  log(
    "success",
    `Graduated: ${parentCode} (and all children) removed from active presale tracking`
  );

  return true;
}
/* =========================================================
   GRADUATE STANDALONE PRODUCT
========================================================= */

async function graduateStandaloneProduct(
  code,
  state
) {
  if (
    isBlocked(
      code,
      state
    )
  ) {
    return false;
  }

  const product =
    await getProductByCode(
      code
    );

  if (!product) {
    log(
      "warn",
      `${code}: not found — skipping`
    );

    return false;
  }

  if (
    isExcludedByTitle(
      product.Name
    )
  ) {
    log(
      "info",
      `${code}: title contains "NZ MADE" — excluded, skipping`
    );

    return false;
  }

  /* -----------------------------------------
     Check real warehouse stock
  ----------------------------------------- */

  const hasRealStock =
    (
      product.PerWarehouseInventory ||
      []
    ).some(
      (w) =>
        REAL_WAREHOUSE_PATTERN.test(
          w.WarehouseCode
        ) &&
        w.QuantityInStockSnapshot >
          0
    );

  log(
    "info",
    `${code}: hasRealStock = ${hasRealStock}`
  );

  if (!hasRealStock) {
    log(
      "info",
      `${code}: still presale-only — no action`
    );

    return false;
  }

  /* -----------------------------------------
     Clear presale inventory
  ----------------------------------------- */

  const zeroOk =
    await zeroOutPreOrderStock(
      product,
      state
    );

  if (!zeroOk) {
    log(
      "error",
      `${code}: presale inventory could not be cleared — stopping this product`
    );

    return false;
  }

  /* -----------------------------------------
     Refresh product
  ----------------------------------------- */

  const freshProduct =
    await getProductByCode(
      code
    );

  if (!freshProduct) {
    log(
      "error",
      `${code}: could not refresh product after inventory update`
    );

    return false;
  }

  /* -----------------------------------------
     Remove DS from Tradevine title
  ----------------------------------------- */

  const titleOk =
    await stripDsPrefix(
      freshProduct
    );

  if (!titleOk) {
    log(
      "error",
      `${code}: Tradevine title cleanup failed — Shopify cleanup will not run`
    );

    return false;
  }

  /* -----------------------------------------
     Shopify tab + metafield cleanup
  ----------------------------------------- */

  const shopifyOk =
    await runShopifyGraduationCleanup(
      freshProduct
    );

  if (!shopifyOk) {
    log(
      "error",
      `${code}: Shopify cleanup failed — keeping product in state for retry`
    );

    return false;
  }

  /* -----------------------------------------
     Record successful graduation
  ----------------------------------------- */

  recordGraduation(
    freshProduct,
    state
  );

  /* -----------------------------------------
     Remove active cycle
  ----------------------------------------- */

  delete state[
    `title:${code}`
  ];

  delete state[
    `warehouse:${code}`
  ];

  saveState(state);

  log(
    "success",
    `Graduated: ${code}`
  );

  return true;
}

/* =========================================================
   REMOVE PRESALE FOR SPECIFIC PRODUCT + PO

   Used by the future automatic 6-hour stock watcher.

   IMPORTANT:
   productCode + poNumber identify the active
   presale cycle.
========================================================= */

async function removePresaleForProduct(
  productCode,
  poNumber
) {
  const code =
    String(productCode || "")
      .trim()
      .toUpperCase();

  const requestedPO =
    String(poNumber || "")
      .trim()
      .toUpperCase();

  if (!code) {
    log(
      "error",
      "removePresaleForProduct: productCode is required"
    );

    return false;
  }

  if (!requestedPO) {
    log(
      "error",
      `${code}: removePresaleForProduct requires poNumber`
    );

    return false;
  }

  const state =
    loadState();

  const titleEntry =
    state[`title:${code}`];

  const bomEntry =
    state[`bom:${code}`];

  const activeEntry =
    titleEntry ||
    bomEntry ||
    null;

  /* -----------------------------------------
     Product must currently be active
  ----------------------------------------- */

  if (!activeEntry) {
    log(
      "info",
      `${code} + ${requestedPO}: no active presale cycle found — nothing to remove`
    );

    return false;
  }

  /* -----------------------------------------
     Verify active PO
  ----------------------------------------- */

  const activePO =
    String(
      activeEntry.poNumber || ""
    )
      .trim()
      .toUpperCase();

  if (
    activePO !==
    requestedPO
  ) {
    log(
      "info",
      `${code}: active PO is ${activePO || "UNKNOWN"}, requested PO is ${requestedPO} — refusing to remove wrong cycle`
    );

    return false;
  }

  log(
    "info",
    `REMOVE PRESALE REQUEST: ${code} + ${requestedPO}`
  );

  /* -----------------------------------------
     BOM parent
  ----------------------------------------- */

  if (bomEntry) {
    log(
      "info",
      `${code} + ${requestedPO}: active cycle is a BOM parent`
    );

    return await graduateBomParent(
      code,
      state
    );
  }

  /* -----------------------------------------
     Standalone product
  ----------------------------------------- */

  log(
    "info",
    `${code} + ${requestedPO}: active cycle is standalone`
  );

  return await graduateStandaloneProduct(
    code,
    state
  );
}

/* =========================================================
   MAIN
========================================================= */

async function main() {
  const state =
    loadState();

  // Keep graduated-this-week.json limited
  // to the last 7 days.
  cleanGraduationHistory();

  /* =======================================================
     STANDALONE PRODUCTS
  ======================================================= */

  const standaloneCodes =
    Object.keys(state)
      .filter(
        (k) =>
          k.startsWith(
            "title:"
          )
      )
      .map(
        (k) =>
          k.replace(
            "title:",
            ""
          )
      )
      .filter(
        (code) =>
          !state[
            `bom:${code}`
          ]
      );

  log(
    "info",
    `Checking ${standaloneCodes.length} standalone product(s): ${
      standaloneCodes.length
        ? standaloneCodes.join(
            ", "
          )
        : "none"
    }`
  );

  for (
    const code of standaloneCodes
  ) {
    await graduateStandaloneProduct(
      code,
      state
    );
  }

  /* =======================================================
     BOM PARENTS
  ======================================================= */

  const bomParentCodes =
    Object.keys(state)
      .filter(
        (k) =>
          k.startsWith(
            "bom:"
          )
      )
      .map(
        (k) =>
          k.replace(
            "bom:",
            ""
          )
      );

  log(
    "info",
    `Checking ${bomParentCodes.length} BOM parent(s): ${
      bomParentCodes.length
        ? bomParentCodes.join(
            ", "
          )
        : "none"
    }`
  );

  for (
    const parentCode of bomParentCodes
  ) {
    await graduateBomParent(
      parentCode,
      state
    );
  }

  /* =======================================================
     SAVE STATE
  ======================================================= */

  saveState(state);

  log(
    "success",
    "Done."
  );
}
/* =========================================================
   GRADUATION HISTORY
========================================================= */

function loadGraduationHistory() {
  if (!fs.existsSync(GRADUATION_FILE)) {
    return [];
  }

  try {
    const data = JSON.parse(
      fs.readFileSync(
        GRADUATION_FILE,
        "utf8"
      )
    );

    return Array.isArray(data) ? data : [];
  } catch (err) {
    log(
      "error",
      `Could not read ${GRADUATION_FILE}: ${err.message}`
    );

    return [];
  }
}

function saveGraduationHistory(history) {
  fs.writeFileSync(
    GRADUATION_FILE,
    JSON.stringify(
      history,
      null,
      2
    )
  );
}

function cleanGraduationHistory() {
  const history =
    loadGraduationHistory();

  const weekAgo =
    Date.now() -
    7 * 24 * 60 * 60 * 1000;

  const cleaned =
    history.filter(
      (entry) => {
        if (!entry.date) {
          return false;
        }

        const timestamp =
          new Date(
            entry.date
          ).getTime();

        return (
          !isNaN(timestamp) &&
          timestamp >= weekAgo
        );
      }
    );

  if (
    cleaned.length !==
    history.length
  ) {
    saveGraduationHistory(
      cleaned
    );
  }

  return cleaned;
}

function recordGraduation(
  product,
  state
) {
  const history =
    cleanGraduationHistory();

  const code =
    String(product.Code || "")
      .trim()
      .toUpperCase();

  // Try to recover supplier / PO information
  const titleEntry =
    state[`title:${code}`];

  const bomEntry =
    state[`bom:${code}`];

  const cycleEntry =
    titleEntry ||
    bomEntry ||
    null;

  const poNumber =
    cycleEntry?.poNumber
      ? String(
          cycleEntry.poNumber
        )
          .trim()
          .toUpperCase()
      : null;

  /*
   * IMPORTANT:
   *
   * Graduation is cycle-aware.
   *
   * Same product + same PO = duplicate
   *
   * Same product + NEW PO = new cycle
   */
  const alreadyRecorded =
    history.some(
      (entry) =>
        String(
          entry.productCode || ""
        )
          .trim()
          .toUpperCase() === code &&
        String(
          entry.poNumber || ""
        )
          .trim()
          .toUpperCase() ===
          poNumber
    );

  if (alreadyRecorded) {
    log(
      "info",
      `${code} + ${poNumber || "NO-PO"}: graduation already recorded — skipping duplicate`
    );

    return;
  }

  const entry = {
    productCode: code,

    productName:
      product.Name || "",

    date:
      new Date().toISOString(),

    supplier:
      cycleEntry?.supplier ||
      null,

    poNumber,

    type:
      bomEntry
        ? "bom"
        : "standalone",
  };

  history.push(entry);

  saveGraduationHistory(
    history
  );

  log(
    "success",
    `${code} + ${poNumber || "NO-PO"}: graduation recorded in ${GRADUATION_FILE}`
  );
}

/* =========================================================
   START
========================================================= */

/* =========================================================
   START / EXPORTS
========================================================= */

if (
  require.main === module
) {
  main().catch(
    (err) => {
      log(
        "error",
        `SCRIPT CRASHED: ${err.message}`
      );

      console.error(
        err
      );
    }
  );
}

module.exports = {
  main,
  removePresaleForProduct,
  getProductByCode,
};