require("dotenv").config();

const fs = require("fs");
const path = require("path");

// ============================================================
// TSB PRESALE LIVE - FINAL PATH VERIFICATION
// ============================================================
//
// READ-ONLY SCRIPT
//
// This script DOES NOT:
// - modify files
// - rename files
// - move files
// - change JSON
// - change JS
//
// It only verifies the final structure and paths.
//
// Run from:
//     D:\tsb-presale-live
//
// Command:
//     node verify-paths.js
// ============================================================

const ROOT = __dirname;

let errors = 0;
let warnings = 0;

// ============================================================
// HELPERS
// ============================================================

function exists(relativePath) {
  return fs.existsSync(path.join(ROOT, relativePath));
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function ok(message) {
  console.log(`[OK] ${message}`);
}

function fail(message) {
  console.log(`[FAIL] ${message}`);
  errors++;
}

function warn(message) {
  console.log(`[WARNING] ${message}`);
}

function section(title) {
  console.log("");
  console.log("============================================================");
  console.log(` ${title}`);
  console.log("============================================================");
  console.log("");
}

// ============================================================
// START
// ============================================================

console.log("");
console.log("============================================================");
console.log(" TSB PRESALE LIVE - FINAL PATH VERIFICATION");
console.log("============================================================");
console.log("");

console.log(`Project root: ${ROOT}`);
console.log("");
console.log("READ-ONLY CHECK - NO FILES WILL BE MODIFIED");
console.log("");

// ============================================================
// 1. EXPECTED STRUCTURE
// ============================================================

section("CHECKING EXPECTED STRUCTURE");

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
  "WLG/wlg-tag-akl.js",

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

expectedFiles.forEach((file) => {
  exists(file) ? ok(file) : fail(`MISSING: ${file}`);
});

// ============================================================
// 2. VERIFY AKL PATHS
// ============================================================

section("VERIFYING AKL PATHS");

const aklFiles = [
  "AKL/bom-automation.js",
  "AKL/remove-presale.js",
  "AKL/resolve-blocked.js",
  "AKL/set-delivery-metafield.js",
  "AKL/shopify-old-listing.js",
  "AKL/test-shopify-old-listing.js",
  "AKL/warehouse-assignment.js",
];

const aklForbidden = ["../json/WLG/", "./json/WLG/", "json/WLG/"];
const aklExpected = ["../json/AKL/", "./json/AKL/"];

aklFiles.forEach((file) => {
  if (!exists(file)) return;

  const content = read(file);
  let hasAklPath = aklExpected.some((v) => content.includes(v));

  aklForbidden.forEach((value) => {
    if (content.includes(value)) {
      fail(`${file} contains WRONG WLG path: ${value}`);
    }
  });

  if (hasAklPath) ok(`${file} uses AKL JSON path`);
});

// ============================================================
// 3. VERIFY WLG PATHS
// ============================================================

section("VERIFYING WLG PATHS");

const wlgFiles = [
  "WLG/bom-automation.js",
  "WLG/remove-presale-wlg.js",
  "WLG/set-delivery-metafield-wlg.js",
  "WLG/wlg-tag-akl.js",
];

const wlgForbidden = ["../json/AKL/", "./json/AKL/", "json/AKL/"];
const wlgExpected = ["../json/WLG/", "./json/WLG/"];

wlgFiles.forEach((file) => {
  if (!exists(file)) return;

  const content = read(file);
  let hasWlgPath = wlgExpected.some((v) => content.includes(v));

  wlgForbidden.forEach((value) => {
    if (content.includes(value)) {
      fail(`${file} contains WRONG AKL path: ${value}`);
    }
  });

  if (hasWlgPath) ok(`${file} uses WLG JSON path`);
});

// ============================================================
// 4. VERIFY EXACT AKL JSON REFERENCES
// ============================================================

section("VERIFYING EXACT AKL JSON FILENAMES");

const aklChecks = [
  {
    file: "AKL/resolve-blocked.js",
    required: [
      "../json/AKL/processed-state.json",
      "../json/AKL/shopify-listing-results.json",
    ],
  },
  {
    file: "AKL/set-delivery-metafield.js",
    required: [
      "../json/AKL/shopify-listing-results.json",
      "../json/AKL/delivery-metafield-results.json",
    ],
  },
  {
    file: "AKL/shopify-old-listing.js",
    required: ["../json/AKL/processed-state.json"],
  },
  {
    file: "AKL/test-shopify-old-listing.js",
    required: [
      "../json/AKL/processed-state.json",
      "../json/AKL/shopify-listing-results.json",
    ],
  },
  {
    file: "AKL/remove-presale.js",
    required: [
      "../json/AKL/processed-state.json",
      "../json/AKL/graduated-this-week.json",
    ],
  },
];

aklChecks.forEach((check) => {
  if (!exists(check.file)) return;

  const content = read(check.file);

  check.required.forEach((requiredPath) => {
    content.includes(requiredPath)
      ? ok(`${check.file} -> ${requiredPath}`)
      : fail(`${check.file} missing expected path: ${requiredPath}`);
  });
});

// ============================================================
// 5. VERIFY EXACT WLG JSON REFERENCES
// ============================================================

section("VERIFYING EXACT WLG JSON FILENAMES");

const wlgChecks = [
  {
    file: "WLG/bom-automation.js",
    required: ["../json/WLG/processed-state-wlg.json"],
  },
  {
    file: "WLG/remove-presale-wlg.js",
    required: ["../json/WLG/processed-state-wlg.json"],
  },
  {
    file: "WLG/set-delivery-metafield-wlg.js",
    required: [
      "../json/WLG/processed-state-wlg.json",
      "../json/WLG/delivery-metafield-results-wlg.json",
    ],
  },
  {
    file: "WLG/wlg-tag-akl.js",
    required: [
      "../json/WLG/processed-state-wlg.json",
      "../json/WLG/wlg-tag-akl-state.json",
    ],
  },
];

wlgChecks.forEach((check) => {
  if (!exists(check.file)) return;

  const content = read(check.file);

  check.required.forEach((requiredPath) => {
    content.includes(requiredPath)
      ? ok(`${check.file} -> ${requiredPath}`)
      : fail(`${check.file} missing expected path: ${requiredPath}`);
  });
});

// ============================================================
// 6. CHECK FOR WRONG WLG DELIVERY FILENAME
// ============================================================

section("VERIFYING WLG DELIVERY FILENAME");

const correctWlgDelivery = "../json/WLG/delivery-metafield-results-wlg.json";

const wrongWlgDelivery = [
  "delivery-metafields-result-wlg.json",
  "../json/WLG/delivery-metafields-result-wlg.json",
  "./json/WLG/delivery-metafields-result-wlg.json",
];

if (exists("json/WLG/delivery-metafield-results-wlg.json")) {
  ok("Correct WLG delivery file exists:");
  console.log("    json/WLG/delivery-metafield-results-wlg.json");
} else {
  fail("Correct WLG delivery file is missing");
}

wlgFiles.forEach((file) => {
  if (!exists(file)) return;

  const content = read(file);

  wrongWlgDelivery.forEach((wrong) => {
    if (content.includes(wrong)) {
      fail(`${file} contains WRONG WLG delivery filename: ${wrong}`);
    }
  });

  if (content.includes(correctWlgDelivery)) {
    ok(`${file} uses correct WLG delivery filename`);
  }
});

// ============================================================
// 7. VERIFY DASHBOARD
// ============================================================

section("VERIFYING DASHBOARD PATHS");

if (exists("dashboard-server.js")) {
  const content = read("dashboard-server.js");

  if (
    content.includes("dashboard/index.html") ||
    content.includes("dashboard\\index.html")
  ) {
    ok("dashboard-server.js points to dashboard/index.html");
  } else {
    fail("dashboard-server.js does not clearly point to dashboard/index.html");
  }

  [
    "./json/AKL/processed-state.json",
    "./json/AKL/shopify-listing-results.json",
    "./json/AKL/shopify-resolved.json",
    "./json/AKL/graduated-this-week.json",
  ].forEach((requiredPath) => {
    if (content.includes(requiredPath)) {
      ok(`dashboard-server.js -> ${requiredPath}`);
    }
  });
}

// ============================================================
// 8. SEARCH FOR ACTUAL OLD ROOT-LEVEL PATHS
// ============================================================

section("SEARCHING FOR ACTUAL OLD ROOT-LEVEL JSON PATHS");

const jsDirectories = [ROOT, path.join(ROOT, "AKL"), path.join(ROOT, "WLG")];
const jsFiles = [];

jsDirectories.forEach((directory) => {
  if (!fs.existsSync(directory)) return;

  fs.readdirSync(directory).forEach((file) => {
    const fullPath = path.join(directory, file);

    if (
      fs.statSync(fullPath).isFile() &&
      file.endsWith(".js") &&
      file !== "update-paths.js" &&
      file !== "verify-paths.js"
    ) {
      jsFiles.push(fullPath);
    }
  });
});

const actualOldPatterns = [
  /path\.join\(__dirname,\s*["']processed-state\.json["']\)/,
  /path\.join\(__dirname,\s*["']shopify-listing-results\.json["']\)/,
  /path\.join\(__dirname,\s*["']shopify-resolved\.json["']\)/,
  /path\.join\(__dirname,\s*["']graduated-this-week\.json["']\)/,
  /path\.join\(__dirname,\s*["']delivery-metafield-results\.json["']\)/,
  /path\.join\(__dirname,\s*["']delivery-metafield-results-wlg\.json["']\)/,
  /path\.join\(__dirname,\s*["']processed-state-wlg\.json["']\)/,
];

let actualOldReferences = 0;

jsFiles.forEach((fullPath) => {
  const relativePath = path.relative(ROOT, fullPath);
  const lines = read(relativePath).split(/\r?\n/);

  lines.forEach((line, index) => {
    actualOldPatterns.forEach((pattern) => {
      if (pattern.test(line)) {
        console.log(`[OLD PATH] ${relativePath}:${index + 1}`);
        console.log(`           ${line.trim()}`);
        actualOldReferences++;
      }
    });
  });
});

if (actualOldReferences === 0) {
  ok("No actual root-level JSON path references found");
} else {
  fail(`${actualOldReferences} actual old root-level JSON path reference(s) found`);
}

// ============================================================
// 9. CHECK AKL/WLG CROSSOVER
// ============================================================

section("CHECKING AKL / WLG CROSSOVER");

aklFiles.forEach((file) => {
  if (!exists(file)) return;

  const content = read(file);

  if (content.includes("../json/WLG/")) {
    fail(`AKL file incorrectly references WLG JSON: ${file}`);
  }
});

wlgFiles.forEach((file) => {
  if (!exists(file)) return;

  const content = read(file);

  if (content.includes("../json/AKL/")) {
    fail(`WLG file incorrectly references AKL JSON: ${file}`);
  }
});

if (errors === 0) ok("No AKL/WLG JSON crossover detected");

// ============================================================
// 10. CHECK REQUIRED JSON DIRECTORIES
// ============================================================

section("CHECKING JSON DIRECTORIES");

exists("json/AKL") ? ok("json/AKL exists") : fail("json/AKL directory missing");
exists("json/WLG") ? ok("json/WLG exists") : fail("json/WLG directory missing");

// ============================================================
// 11. FINAL RESULT
// ============================================================

section("FINAL VERIFICATION RESULT");

console.log(`Errors:   ${errors}`);
console.log(`Warnings: ${warnings}`);
console.log("");

if (errors === 0) {
  console.log("============================================================");
  console.log(" [SUCCESS] PATH STRUCTURE PASSED");
  console.log("============================================================");
  console.log("");
  console.log("The AKL and WLG paths are structurally correct.");
  console.log("");
  console.log("NEXT STEP:");
  console.log("Do NOT run production automation yet.");
  console.log("Send this complete verification output back.");
  console.log("");
} else {
  console.log("============================================================");
  console.log(" [FAIL] PATH STRUCTURE NEEDS CORRECTION");
  console.log("============================================================");
  console.log("");
  console.log("Do NOT run production automation.");
  console.log("Send this complete verification output back.");
  console.log("");
}
