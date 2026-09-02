require("dotenv").config();

const fs = require("fs");
const path = require("path");

// ============================================================
// TSB PRESALE LIVE - FINAL PATH MIGRATION
// ============================================================
//
// PURPOSE:
// 1. Creates a backup before modifying files.
// 2. Updates AKL JSON paths.
// 3. Updates WLG JSON paths.
// 4. Updates dashboard path.
// 5. Does NOT rename JSON files.
// 6. Corrects exact WLG filenames.
// 7. Can safely be run again.
//
// RUN FROM:
//     D:\tsb-presale-live
//
// COMMAND:
//     node update-paths.js
// ============================================================

const ROOT = __dirname;

const BACKUP_DIR = path.join(
  ROOT,
  `path-migration-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`
);

// ============================================================
// HELPERS
// ============================================================

function backupFile(relativePath) {
  const source = path.join(ROOT, relativePath);

  if (!fs.existsSync(source)) {
    console.log(`[SKIP] ${relativePath} does not exist`);
    return false;
  }

  const destination = path.join(BACKUP_DIR, relativePath);

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);

  console.log(`[BACKUP] ${relativePath}`);
  return true;
}

function exists(relativePath) {
  return fs.existsSync(path.join(ROOT, relativePath));
}

function replaceAll(content, oldValue, newValue) {
  if (!content.includes(oldValue)) {
    return { changed: false, count: 0, content };
  }

  const count = content.split(oldValue).length - 1;

  return {
    changed: true,
    count,
    content: content.split(oldValue).join(newValue),
  };
}

function updateFile(relativePath, replacements) {
  const fullPath = path.join(ROOT, relativePath);

  if (!fs.existsSync(fullPath)) {
    console.log(`[SKIP] ${relativePath} does not exist`);
    return;
  }

  let content = fs.readFileSync(fullPath, "utf8");
  let total = 0;

  replacements.forEach(([oldValue, newValue]) => {
    const result = replaceAll(content, oldValue, newValue);

    if (result.changed) {
      content = result.content;
      total += result.count;

      console.log(`  ${result.count}x`);
      console.log(`    "${oldValue}"`);
      console.log(`    -> "${newValue}"`);
    }
  });

  if (total > 0) {
    fs.writeFileSync(fullPath, content, "utf8");
    console.log(`[UPDATED] ${relativePath}`);
  } else {
    console.log(`[UNCHANGED] ${relativePath}`);
  }
}

// ============================================================
// FILES TO BACK UP
// ============================================================

const filesToBackup = [
  // ROOT
  "dashboard-server.js",
  "fix-shopify-pr15245.js",
  "test-connection.js",
  "test-inventory.js",

  // AKL
  "AKL/bom-automation.js",
  "AKL/remove-presale.js",
  "AKL/resolve-blocked.js",
  "AKL/set-delivery-metafield.js",
  "AKL/shopify-old-listing.js",
  "AKL/test-shopify-old-listing.js",
  "AKL/warehouse-assignment.js",

  // WLG
  "WLG/bom-automation.js",
  "WLG/remove-presale-wlg.js",
  "WLG/set-delivery-metafield-wlg.js",
  "WLG/wig-tag-akl.js",
];

// ============================================================
// EXACT PATHS
// ============================================================

// AKL
const AKL_STATE = "../json/AKL/processed-state.json";
const AKL_LISTING_RESULTS = "../json/AKL/shopify-listing-results.json";
const AKL_DELIVERY_RESULTS = "../json/AKL/delivery-metafield-results.json";
const AKL_SHOPIFY_RESOLVED = "../json/AKL/shopify-resolved.json";
const AKL_GRADUATED = "../json/AKL/graduated-this-week.json";

// WLG
const WLG_STATE = "../json/WLG/processed-state-wlg.json";
const WLG_DELIVERY_RESULTS = "../json/WLG/delivery-metafield-results-wlg.json";
const WLG_TAG_STATE = "../json/WLG/wlg-tag-akl-state.json";

// ============================================================
// START
// ============================================================

console.log("");
console.log("============================================================");
console.log(" TSB PRESALE LIVE - FINAL PATH MIGRATION");
console.log("============================================================");
console.log("");
console.log(`Project root: ${ROOT}`);
console.log("");

// ============================================================
// 1. BACKUP
// ============================================================

console.log("");
console.log("============================================================");
console.log(" CREATING BACKUP");
console.log("============================================================");
console.log("");

fs.mkdirSync(BACKUP_DIR, { recursive: true });

let backupCount = 0;

filesToBackup.forEach((file) => {
  if (backupFile(file)) backupCount++;
});

console.log("");
console.log(`Backup created: ${BACKUP_DIR}`);
console.log(`Files backed up: ${backupCount}`);

// ============================================================
// 2. AKL PATHS
// ============================================================

console.log("");
console.log("============================================================");
console.log(" UPDATING AKL PATHS");
console.log("============================================================");
console.log("");

updateFile("AKL/bom-automation.js", [
  ["processed-state.json", AKL_STATE],
  ["processed-state-wlg.json", AKL_STATE],
]);

updateFile("AKL/remove-presale.js", [
  ["processed-state.json", AKL_STATE],
  ["graduated-this-week.json", AKL_GRADUATED],
]);

updateFile("AKL/resolve-blocked.js", [
  ["processed-state.json", AKL_STATE],
  ["shopify-listing-results.json", AKL_LISTING_RESULTS],
]);

updateFile("AKL/set-delivery-metafield.js", [
  ["processed-state.json", AKL_STATE],
  ["shopify-listing-results.json", AKL_LISTING_RESULTS],
  ["delivery-metafield-results.json", AKL_DELIVERY_RESULTS],
]);

updateFile("AKL/shopify-old-listing.js", [
  ["processed-state.json", AKL_STATE],
]);

updateFile("AKL/test-shopify-old-listing.js", [
  ["processed-state.json", AKL_STATE],
  ["shopify-listing-results.json", AKL_LISTING_RESULTS],
]);

updateFile("AKL/warehouse-assignment.js", [
  ["processed-state.json", AKL_STATE],
]);

// ============================================================
// 3. WLG PATHS
// ============================================================

console.log("");
console.log("============================================================");
console.log(" UPDATING WLG PATHS");
console.log("============================================================");
console.log("");

updateFile("WLG/bom-automation.js", [
  ["processed-state-wlg.json", WLG_STATE],
  ["processed-state.json", WLG_STATE],
]);

updateFile("WLG/remove-presale-wlg.js", [
  ["processed-state-wlg.json", WLG_STATE],
  ["processed-state.json", WLG_STATE],
  ["wlg-tag-akl-state.json", WLG_TAG_STATE],
  ["../json/wlg-tag-akl-state.json", WLG_TAG_STATE],
  ["./wlg-tag-akl-state.json", WLG_TAG_STATE],
]);

updateFile("WLG/set-delivery-metafield-wlg.js", [
  ["processed-state-wlg.json", WLG_STATE],
  ["processed-state.json", WLG_STATE],
  ["delivery-metafield-results-wlg.json", WLG_DELIVERY_RESULTS],
  ["delivery-metafields-results-wlg.json", WLG_DELIVERY_RESULTS],
  ["delivery-metafields-result-wlg.json", WLG_DELIVERY_RESULTS],
  ["delivery-metafield-result-wlg.json", WLG_DELIVERY_RESULTS],
  ["./delivery-metafield-results-wlg.json", WLG_DELIVERY_RESULTS],
  ["./delivery-metafields-results-wlg.json", WLG_DELIVERY_RESULTS],
]);

updateFile("WLG/wig-tag-akl.js", [
  ["processed-state-wlg.json", WLG_STATE],
  ["processed-state.json", WLG_STATE],
  ["wlg-tag-akl-state.json", WLG_TAG_STATE],
]);

// ============================================================
// 4. DASHBOARD
// ============================================================

console.log("");
console.log("============================================================");
console.log(" UPDATING DASHBOARD PATHS");
console.log("============================================================");
console.log("");

const dashboardPath = path.join(ROOT, "dashboard-server.js");

if (fs.existsSync(dashboardPath)) {
  let content = fs.readFileSync(dashboardPath, "utf8");
  let changed = false;

  const dashboardReplacements = [
    ['"index.html"', '"dashboard/index.html"'],

    ['"./processed-state.json"', '"./json/AKL/processed-state.json"'],
    ["'./processed-state.json'", "'./json/AKL/processed-state.json'"],

    ['"./shopify-listing-results.json"', '"./json/AKL/shopify-listing-results.json"'],
    ["'./shopify-listing-results.json'", "'./json/AKL/shopify-listing-results.json'"],

    ['"./shopify-resolved.json"', '"./json/AKL/shopify-resolved.json"'],
    ["'./shopify-resolved.json'", "'./json/AKL/shopify-resolved.json'"],

    ['"./graduated-this-week.json"', '"./json/AKL/graduated-this-week.json"'],
    ["'./graduated-this-week.json'", "'./json/AKL/graduated-this-week.json'"],
  ];

  dashboardReplacements.forEach(([oldValue, newValue]) => {
    if (content.includes(oldValue)) {
      content = content.split(oldValue).join(newValue);
      console.log(`  "${oldValue}"`);
      console.log(`  -> "${newValue}"`);
      changed = true;
    }
  });

  if (changed) {
    fs.writeFileSync(dashboardPath, content, "utf8");
    console.log("[UPDATED] dashboard-server.js");
  } else {
    console.log("[UNCHANGED] dashboard-server.js");
  }
} else {
  console.log("[SKIP] dashboard-server.js does not exist");
}

// ============================================================
// 5. VERIFY EXACT FILE STRUCTURE
// ============================================================

console.log("");
console.log("============================================================");
console.log(" VERIFYING REQUIRED STRUCTURE");
console.log("============================================================");
console.log("");

const expectedFiles = [
  // Root
  "dashboard-server.js",
  "fix-shopify-pr15245.js",
  "test-connection.js",
  "test-inventory.js",
  "package.json",
  "package-lock.json",
  ".env",

  // Dashboard
  "dashboard/index.html",

  // AKL
  "AKL/bom-automation.js",
  "AKL/remove-presale.js",
  "AKL/resolve-blocked.js",
  "AKL/set-delivery-metafield.js",
  "AKL/shopify-old-listing.js",
  "AKL/test-shopify-old-listing.js",
  "AKL/warehouse-assignment.js",

  // WLG
  "WLG/bom-automation.js",
  "WLG/remove-presale-wlg.js",
  "WLG/set-delivery-metafield-wlg.js",
  "WLG/wig-tag-akl.js",

  // AKL JSON
  "json/AKL/delivery-metafield-results.json",
  "json/AKL/graduated-this-week.json",
  "json/AKL/processed-state.json",
  "json/AKL/shopify-listing-results.json",
  "json/AKL/shopify-resolved.json",

  // WLG JSON
  "json/WLG/delivery-metafield-results-wlg.json",
  "json/WLG/processed-state-wlg.json",
  "json/WLG/wlg-tag-akl-state.json",
];

let missingFiles = [];

expectedFiles.forEach((file) => {
  if (exists(file)) {
    console.log(`[OK] ${file}`);
  } else {
    console.log(`[MISSING] ${file}`);
    missingFiles.push(file);
  }
});

// ============================================================
// 6. VERIFY EXACT WLG REFERENCES
// ============================================================

console.log("");
console.log("============================================================");
console.log(" VERIFYING EXACT WLG PATHS");
console.log("============================================================");
console.log("");

function verifyContains(file, expectedPath) {
  const fullPath = path.join(ROOT, file);

  if (!fs.existsSync(fullPath)) {
    console.log(`[MISSING FILE] ${file}`);
    return false;
  }

  const content = fs.readFileSync(fullPath, "utf8");

  if (content.includes(expectedPath)) {
    console.log(`[OK] ${file} -> ${expectedPath}`);
    return true;
  }

  console.log(`[FAIL] ${file} missing expected path: ${expectedPath}`);
  return false;
}

let pathErrors = 0;

[
  ["WLG/remove-presale-wlg.js", WLG_STATE],
  ["WLG/remove-presale-wlg.js", WLG_TAG_STATE],
  ["WLG/set-delivery-metafield-wlg.js", WLG_STATE],
  ["WLG/set-delivery-metafield-wlg.js", WLG_DELIVERY_RESULTS],
  ["WLG/wig-tag-akl.js", WLG_STATE],
  ["WLG/wig-tag-akl.js", WLG_TAG_STATE],
].forEach(([file, expected]) => {
  if (!verifyContains(file, expected)) pathErrors++;
});

// ============================================================
// 7. VERIFY AKL PATHS
// ============================================================

console.log("");
console.log("============================================================");
console.log(" VERIFYING AKL PATHS");
console.log("============================================================");
console.log("");

[
  ["AKL/resolve-blocked.js", AKL_STATE],
  ["AKL/resolve-blocked.js", AKL_LISTING_RESULTS],
  ["AKL/set-delivery-metafield.js", AKL_STATE],
  ["AKL/set-delivery-metafield.js", AKL_LISTING_RESULTS],
  ["AKL/set-delivery-metafield.js", AKL_DELIVERY_RESULTS],
  ["AKL/shopify-old-listing.js", AKL_STATE],
  ["AKL/test-shopify-old-listing.js", AKL_STATE],
  ["AKL/test-shopify-old-listing.js", AKL_LISTING_RESULTS],
  ["AKL/remove-presale.js", AKL_STATE],
  ["AKL/remove-presale.js", AKL_GRADUATED],
].forEach(([file, expected]) => {
  if (!verifyContains(file, expected)) pathErrors++;
});

// ============================================================
// 8. CHECK AKL / WLG CROSSOVER
// ============================================================

console.log("");
console.log("============================================================");
console.log(" CHECKING AKL / WLG CROSSOVER");
console.log("============================================================");
console.log("");

function checkForbidden(file, forbidden) {
  const fullPath = path.join(ROOT, file);

  if (!fs.existsSync(fullPath)) return;

  const content = fs.readFileSync(fullPath, "utf8");

  if (content.includes(forbidden)) {
    console.log(`[WARNING] ${file} contains forbidden path: ${forbidden}`);
  }
}

[
  "AKL/bom-automation.js",
  "AKL/remove-presale.js",
  "AKL/resolve-blocked.js",
  "AKL/set-delivery-metafield.js",
  "AKL/shopify-old-listing.js",
  "AKL/test-shopify-old-listing.js",
].forEach((file) => checkForbidden(file, "../json/WLG/"));

[
  "WLG/bom-automation.js",
  "WLG/remove-presale-wlg.js",
  "WLG/set-delivery-metafield-wlg.js",
  "WLG/wig-tag-akl.js",
].forEach((file) => checkForbidden(file, "../json/AKL/"));

// ============================================================
// 9. FINAL REPORT
// ============================================================

console.log("");
console.log("============================================================");
console.log(" FINAL PATH MIGRATION RESULT");
console.log("============================================================");
console.log("");

console.log(`Missing structure files: ${missingFiles.length}`);
console.log(`Path verification errors: ${pathErrors}`);
console.log("");
console.log(`Backup location: ${BACKUP_DIR}`);
console.log("");

if (missingFiles.length === 0 && pathErrors === 0) {
  console.log("============================================================");
  console.log(" [SUCCESS] PATH STRUCTURE IS CORRECT");
  console.log("============================================================");
  console.log("");
  console.log("All AKL and WLG paths point to the correct JSON folders.");
  console.log("All expected files exist.");
  console.log("");
  console.log("NEXT STEP:");
  console.log("Run:");
  console.log("");
  console.log("    node verify-paths.js");
  console.log("");
  console.log("Then send me the verification output.");
} else {
  console.log("============================================================");
  console.log(" [FAIL] PATH STRUCTURE STILL NEEDS CORRECTION");
  console.log("============================================================");
  console.log("");
  console.log("Do NOT run production automation.");
  console.log("");
  console.log("Run verify-paths.js again after this migration.");
}

console.log("");
