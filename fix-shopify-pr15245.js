require("dotenv").config();

const OAuth = require("oauth-1.0a");
const crypto = require("crypto");
const JSONbig = require("json-bigint")({
  storeAsString: true,
});

const PRODUCT_CODE = "PR15245";

const SHOPIFY_API_VERSION = "2026-07";
const METAFIELD_NAMESPACE = "stock";
const METAFIELD_KEY = "akl_arriving_date";

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

/* =======================================================
   TRADEVINE GET
======================================================= */

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
    // leave data null
  }

  return {
    status: res.status,
    data,
    raw: text,
  };
}

/* =======================================================
   TRADEVINE POST

   IMPORTANT:
   JSONbig.stringify() is used so Tradevine's very large
   integer IDs do not lose precision.
======================================================= */

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

    body: JSONbig.stringify(body),
  });

  const text = await res.text();

  let data = null;

  try {
    data = JSONbig.parse(text);
  } catch {
    // leave data null
  }

  return {
    status: res.status,
    data,
    raw: text,
  };
}

/* =======================================================
   FIND TRADEVINE SHOPIFY PRODUCT
======================================================= */

async function getShopifyProduct() {
  const url =
    `https://api.tradevine.com/v1/ShopifyProduct` +
    `?productCode=${encodeURIComponent(PRODUCT_CODE)}` +
    `&pageSize=100`;

  console.log("\nLooking up Tradevine ShopifyProduct...");
  console.log("Product:", PRODUCT_CODE);

  const result = await apiGet(url);

  if (result.status !== 200 || !result.data) {
    throw new Error(
      `ShopifyProduct lookup failed: HTTP ${result.status}\n${result.raw}`
    );
  }

  const list = result.data.List || [];

  const record = list.find(
    (item) => item.ProductCode === PRODUCT_CODE
  );

  if (!record) {
    throw new Error(
      `No ShopifyProduct record found for ${PRODUCT_CODE}`
    );
  }

  console.log("\nTradevine ShopifyProduct found:");
  console.log(
    "  ShopifyProductID:",
    String(record.ShopifyProductID)
  );
  console.log(
    "  ProductID:",
    String(record.ProductID)
  );
  console.log(
    "  ProductCode:",
    record.ProductCode
  );
  console.log(
    "  ExternalShopifyProductID:",
    String(record.ExternalShopifyProductID)
  );

  return record;
}

/* =======================================================
   CLEAN TRADEVINE SHOPIFY TAB

   We preserve the complete existing record but use
   JSONbig so large IDs remain exact.
======================================================= */

async function cleanShopifyTab(record) {
  console.log("\nCurrent Shopify tab:");
  console.log(`  Title: ${record.Title}`);
  console.log(`  Tags: ${record.Tags}`);

  const updates = {};

  /* ---------- TITLE ---------- */

  if (
    typeof record.Title === "string" &&
    /^DS\s+/i.test(record.Title)
  ) {
    updates.Title = record.Title.replace(
      /^DS\s+/i,
      ""
    );
  }

  /* ---------- TAGS ---------- */

  const cleanedTags = (record.Tags || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .filter(
      (tag) =>
        tag.toLowerCase() !==
        "pre-order-auckland"
    )
    .join(", ");

  if (
    cleanedTags !==
    (record.Tags || "").trim()
  ) {
    updates.Tags = cleanedTags;
  }

  /* ---------- NOTHING TO CHANGE ---------- */

  if (Object.keys(updates).length === 0) {
    console.log(
      "\nShopify tab is already clean."
    );

    return true;
  }

  console.log("\nChanges to make:");

  if (updates.Title !== undefined) {
    console.log(
      `  Title: "${record.Title}" -> "${updates.Title}"`
    );
  }

  if (updates.Tags !== undefined) {
    console.log(
      `  Tags: "${record.Tags}" -> "${updates.Tags}"`
    );
  }

  /*
     IMPORTANT:
     Keep exact large Tradevine IDs.
  */

  const body = {
    ...record,
    ...updates,
  };

  const shopifyProductId =
    String(record.ShopifyProductID);

  const url =
    `https://api.tradevine.com/v1/ShopifyProduct/` +
    shopifyProductId;

  console.log(
    "\nUpdating Tradevine ShopifyProduct..."
  );

  console.log(
    "ShopifyProductID:",
    shopifyProductId
  );

  const result = await apiPost(
    url,
    body
  );

  if (result.status !== 200) {
    console.error(
      "\nSHOPIFY TAB UPDATE FAILED"
    );

    console.error(
      "HTTP:",
      result.status
    );

    console.error(
      "Response:",
      result.raw
    );

    return false;
  }

  console.log(
    "\nSUCCESS: Tradevine Shopify tab updated."
  );

  /* ---------- VERIFY ---------- */

  const verify =
    await getShopifyProduct();

  console.log("\nVerification:");
  console.log(
    `  Title: ${verify.Title}`
  );
  console.log(
    `  Tags: ${verify.Tags}`
  );

  const titleClean =
    !/^DS\s+/i.test(
      verify.Title || ""
    );

  const tagClean =
    !(verify.Tags || "")
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .includes("pre-order-auckland");

  if (!titleClean || !tagClean) {
    console.error(
      "\nWARNING: Shopify tab verification failed."
    );

    return false;
  }

  console.log(
    "VERIFIED: Shopify tab title and tag are clean."
  );

  return true;
}

/* =======================================================
   SHOPIFY GRAPHQL
======================================================= */

async function shopifyGraphQL(
  query,
  variables = {}
) {
  const url =
    `https://${process.env.SHOPIFY_STORE}` +
    `/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const res = await fetch(url, {
    method: "POST",

    headers: {
      "Content-Type": "application/json",

      "X-Shopify-Access-Token":
        process.env.SHOPIFY_ACCESS_TOKEN,
    },

    body: JSON.stringify({
      query,
      variables,
    }),
  });

  const text = await res.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Shopify GraphQL returned invalid JSON:\n${text}`
    );
  }

  if (!res.ok) {
    throw new Error(
      `Shopify GraphQL HTTP ${res.status}:\n${text}`
    );
  }

  return data;
}

/* =======================================================
   FIND SHOPIFY PRODUCT

   We use SKU = PR15245.
======================================================= */

async function findShopifyProduct() {
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
        query: `sku:${PRODUCT_CODE}`,
      }
    );

  if (result.errors) {
    throw new Error(
      "Shopify GraphQL errors:\n" +
        JSON.stringify(
          result.errors,
          null,
          2
        )
    );
  }

  const products =
    result.data?.products?.edges || [];

  if (products.length === 0) {
    console.log(
      `\nNo Shopify product found for SKU ${PRODUCT_CODE}.`
    );

    return null;
  }

  const product =
    products[0].node;

  console.log(
    "\nShopify product found:"
  );

  console.log(
    "  Product GID:",
    product.id
  );

  console.log(
    "  Shopify title:",
    product.title
  );

  if (product.metafield) {
    console.log(
      "  arriving-date:",
      product.metafield.value
    );
  } else {
    console.log(
      "  arriving-date: NOT FOUND"
    );
  }

  return product;
}

/* =======================================================
   DELETE ARRIVING DATE METAFIELD

   Uses Shopify's current metafieldsDelete mutation.
======================================================= */

async function removeArrivingDateMetafield(
  product
) {
  if (!product) {
    return false;
  }

  const metafield =
    product.metafield;

  if (!metafield) {
    console.log(
      "\nNo stock.akl_arriving_date metafield exists."
    );

    return true;
  }

  console.log(
    "\nFound metafield:"
  );

  console.log(
    "  ID:",
    metafield.id
  );

  console.log(
    "  Namespace:",
    metafield.namespace
  );

  console.log(
    "  Key:",
    metafield.key
  );

  console.log(
    "  Value:",
    metafield.value
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
            ownerId: product.id,
            namespace: METAFIELD_NAMESPACE,
            key: METAFIELD_KEY,
          },
        ],
      }
    );

  if (result.errors) {
    console.error(
      "\nGraphQL error:"
    );

    console.error(
      JSON.stringify(
        result.errors,
        null,
        2
      )
    );

    return false;
  }

  const payload =
    result.data?.metafieldsDelete;

  const errors =
    payload?.userErrors || [];

  if (errors.length > 0) {
    console.error(
      "\nMETAFIELD DELETE FAILED:"
    );

    console.error(
      JSON.stringify(
        errors,
        null,
        2
      )
    );

    return false;
  }

  const deleted =
    payload?.deletedMetafields || [];

  if (deleted.length > 0) {
    console.log(
      "\nSUCCESS: akl_arriving_date metafield deleted."
    );
  } else {
    console.log(
      "\nShopify reported no metafield to delete."
    );
  }

  return true;
}

/* =======================================================
   VERIFY METAFIELD IS ACTUALLY GONE
======================================================= */

async function verifyMetafieldRemoved() {
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
        query: `sku:${PRODUCT_CODE}`,
      }
    );

  if (result.errors) {
    throw new Error(
      "Verification GraphQL error:\n" +
        JSON.stringify(
          result.errors,
          null,
          2
        )
    );
  }

  const product =
    result.data?.products?.edges?.[0]?.node;

  if (!product) {
    console.log(
      "\nWARNING: Shopify product could not be found during verification."
    );

    return false;
  }

  const metafield =
    product.metafield;

  if (!metafield) {
    console.log(
      "\nVERIFIED: stock.akl_arriving_date is completely removed."
    );

    return true;
  }

  console.error(
    "\nWARNING: stock.akl_arriving_date STILL EXISTS:"
  );

  console.error(
    JSON.stringify(
      metafield,
      null,
      2
    )
  );

  return false;
}

/* =======================================================
   MAIN
======================================================= */

async function main() {
  console.log(
    `\n========================================`
  );

  console.log(
    ` ONE-TIME CLEANUP: ${PRODUCT_CODE}`
  );

  console.log(
    `========================================`
  );

  /* ---------------------------------------
     1. TRADEVINE SHOPIFY TAB
  --------------------------------------- */

  const record =
    await getShopifyProduct();

  const shopifyTabOk =
    await cleanShopifyTab(
      record
    );

  if (!shopifyTabOk) {
    throw new Error(
      "Shopify tab cleanup failed. Stopping before metafield cleanup."
    );
  }

  /* ---------------------------------------
     2. SHOPIFY METAFIELD
  --------------------------------------- */

  const product =
    await findShopifyProduct();

  if (!product) {
    throw new Error(
      `Could not find Shopify product for ${PRODUCT_CODE}.`
    );
  }

  const metafieldOk =
    await removeArrivingDateMetafield(
      product
    );

  if (!metafieldOk) {
    throw new Error(
      "Metafield deletion failed."
    );
  }

  /* ---------------------------------------
     3. VERIFY
  --------------------------------------- */

  const verified =
    await verifyMetafieldRemoved();

  if (!verified) {
    throw new Error(
      "Metafield verification failed — it may still exist."
    );
  }

  console.log(
    `\n========================================`
  );

  console.log(
    ` CLEANUP COMPLETE: ${PRODUCT_CODE}`
  );

  console.log(
    `========================================`
  );

  console.log(
    "\nNo inventory was changed by this script."
  );

  console.log(
    "No Tradevine product title was changed by this script."
  );
}

main().catch((err) => {
  console.error(
    "\nSCRIPT CRASHED:",
    err.message
  );

  console.error(err);
});