require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// ==================================================
// BASE
// ==================================================
const ROOT_DIR = __dirname;
const LOG_FILE = path.join(ROOT_DIR, "automation-orchestrator.log");

// ==================================================
// STORE CONFIGURATION
// ==================================================
//
// FLOW
//
// AKL:
// 1. BOM Automation
// 2. Shopify Old Listing
// 3. Delivery Metafield
//
// WLG:
// 1. BOM Automation
// 2. WLG → AKL Tag
// 3. Delivery Metafield
//
// CHCH:
// 1. BOM Automation
// 2. CHCH → AKL Tag
// 3. Delivery Metafield
//
// ==================================================
const STORES = {
  akl: {
    key: "akl",
    name: "Auckland",
    steps: [
      {
        name: "BOM Automation",
        script: path.join(ROOT_DIR, "AKL", "bom-automation.js"),
      },
      {
        name: "Shopify Old Listing",
        script: path.join(ROOT_DIR, "AKL", "test-shopify-old-listing.js"),
      },
      {
        name: "Delivery Metafield",
        script: path.join(ROOT_DIR, "AKL", "set-delivery-metafield.js"),
      },
    ],
  },

  wlg: {
    key: "wlg",
    name: "Wellington",
    steps: [
      {
        name: "BOM Automation",
        script: path.join(ROOT_DIR, "WLG", "bom-automation-wlg.js"),
      },
      {
        name: "WLG → AKL Tag",
        script: path.join(ROOT_DIR, "WLG", "wlg-tag-akl.js"),
      },
      {
        name: "Delivery Metafield",
        script: path.join(ROOT_DIR, "WLG", "set-delivery-metafield-wlg.js"),
      },
    ],
  },

  chch: {
    key: "chch",
    name: "Christchurch",
    steps: [
      {
        name: "BOM Automation",
        script: path.join(ROOT_DIR, "CHCH", "bom-automation-chch.js"),
      },
      {
        name: "CHCH → AKL Tag",
        script: path.join(ROOT_DIR, "CHCH", "chch-tag-akl.js"),
      },
      {
        name: "Delivery Metafield",
        script: path.join(ROOT_DIR, "CHCH", "set-delivery-metafield-chch.js"),
      },
    ],
  },
};

// ==================================================
// LOGGING
// ==================================================
function ensureLogDirectory() {
  const directory = path.dirname(LOG_FILE);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

function log(type, message) {
  const entry = {
    time: new Date().toISOString(),
    type,
    message,
  };

  const line = JSON.stringify(entry);

  console.log(`[${type.toUpperCase()}] ${message}`);
  ensureLogDirectory();
  fs.appendFileSync(LOG_FILE, line + "\n");
}

// ==================================================
// RUN ONE SCRIPT
// ==================================================
function runScript(store, step, stepNumber) {
  return new Promise((resolve) => {
    log("info", "--------------------------------------------------");
    log("info", `${store.name} - STEP ${stepNumber}: ${step.name}`);
    log("info", `Script: ${step.script}`);

    // ------------------------------------------------
    // CHECK SCRIPT EXISTS
    // ------------------------------------------------
    if (!fs.existsSync(step.script)) {
      log("error", `${store.name} - ${step.name}: script not found`);
      log("error", `Expected path: ${step.script}`);

      resolve({
        success: false,
        store: store.key,
        step: step.name,
        stepNumber,
        exitCode: null,
        error: "Script not found",
      });

      return;
    }

    // ------------------------------------------------
    // START CHILD PROCESS
    // ------------------------------------------------
    let child;

    try {
      child = spawn(process.execPath, [step.script], {
        cwd: ROOT_DIR,
        env: { ...process.env },
        windowsHide: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      log("error", `${store.name} - ${step.name}: failed to start`);
      log("error", err.message);

      resolve({
        success: false,
        store: store.key,
        step: step.name,
        stepNumber,
        exitCode: null,
        error: err.message,
      });

      return;
    }

    // ------------------------------------------------
    // STDOUT
    // ------------------------------------------------
    child.stdout.on("data", (data) => {
      const output = data.toString();
      process.stdout.write(output);

      const trimmed = output.trim();
      if (trimmed) {
        log("info", `[${store.key.toUpperCase()} - ${step.name}] ${trimmed}`);
      }
    });

    // ------------------------------------------------
    // STDERR
    // ------------------------------------------------
    child.stderr.on("data", (data) => {
      const output = data.toString();
      process.stderr.write(output);

      const trimmed = output.trim();
      if (trimmed) {
        log("error", `[${store.key.toUpperCase()} - ${step.name}] ${trimmed}`);
      }
    });

    // ------------------------------------------------
    // PROCESS ERROR
    // ------------------------------------------------
    child.on("error", (err) => {
      log("error", `${store.name} - ${step.name}: child process error`);
      log("error", err.message);

      resolve({
        success: false,
        store: store.key,
        step: step.name,
        stepNumber,
        exitCode: null,
        error: err.message,
      });
    });

    // ------------------------------------------------
    // PROCESS FINISHED
    // ------------------------------------------------
    child.on("close", (code) => {
      if (code === 0) {
        log(
          "success",
          `${store.name} - STEP ${stepNumber} COMPLETED: ${step.name}`
        );
        log("info", "--------------------------------------------------");

        resolve({
          success: true,
          store: store.key,
          step: step.name,
          stepNumber,
          exitCode: 0,
          error: null,
        });

        return;
      }

      log("error", `${store.name} - STEP ${stepNumber} FAILED: ${step.name}`);
      log("error", `Exit code: ${code}`);
      log("info", "--------------------------------------------------");

      resolve({
        success: false,
        store: store.key,
        step: step.name,
        stepNumber,
        exitCode: code,
        error: `Automation exited with code ${code}`,
      });
    });
  });
}
// ==================================================
// RUN ONE STORE
// ==================================================
async function runStore(store) {
  log("info", "");
  log("info", "==================================================");
  log("info", `STARTING ${store.name.toUpperCase()} AUTOMATION`);
  log("info", "==================================================");
  log("info", `Store: ${store.key.toUpperCase()}`);
  log("info", `Total steps: ${store.steps.length}`);
  log("info", "");

  const results = [];

  // ------------------------------------------------
  // RUN STEPS IN ORDER
  // ------------------------------------------------
  for (let i = 0; i < store.steps.length; i++) {
    const step = store.steps[i];
    const stepNumber = i + 1;

    const result = await runScript(store, step, stepNumber);
    results.push(result);

    // ------------------------------------------------
    // STOP STORE IF STEP FAILED
    // ------------------------------------------------
    if (!result.success) {
      log("error", "");
      log("error", `${store.name.toUpperCase()} AUTOMATION STOPPED`);
      log("error", `Failed step: ${step.name}`);
      log("error", `Step ${stepNumber} of ${store.steps.length}`);
      log("error", "Remaining steps will NOT run.");
      log("info", "");

      return {
        success: false,
        store: store.key,
        results,
      };
    }
  }

  // ------------------------------------------------
  // STORE COMPLETE
  // ------------------------------------------------
  log("info", "");
  log("success", "==================================================");
  log("success", `${store.name.toUpperCase()} AUTOMATION COMPLETED`);
  log("success", "==================================================");
  log("info", "");

  return {
    success: true,
    store: store.key,
    results,
  };
}

// ==================================================
// RUN ALL STORES
// ==================================================
async function runAllStores() {
  log("info", "");
  log("info", "##################################################");
  log("info", "# TSB PRESALE AUTOMATION - ALL STORES");
  log("info", "# AKL → WLG → CHCH");
  log("info", "##################################################");
  log("info", "");

  // ------------------------------------------------
  // AKL
  // ------------------------------------------------
  const aklResult = await runStore(STORES.akl);
  if (!aklResult.success) {
    log("error", "AKL automation failed.");
    log("error", "ALL-STORE automation stopped.");
    log("error", "WLG and CHCH will NOT run.");
    return false;
  }

  // ------------------------------------------------
  // WLG
  // ------------------------------------------------
  const wlgResult = await runStore(STORES.wlg);
  if (!wlgResult.success) {
    log("error", "WLG automation failed.");
    log("error", "ALL-STORE automation stopped.");
    log("error", "CHCH will NOT run.");
    return false;
  }

  // ------------------------------------------------
  // CHCH
  // ------------------------------------------------
  const chchResult = await runStore(STORES.chch);
  if (!chchResult.success) {
    log("error", "CHCH automation failed.");
    return false;
  }

  // ------------------------------------------------
  // ALL SUCCESS
  // ------------------------------------------------
  log("info", "");
  log("success", "##################################################");
  log("success", "# ALL STORES COMPLETED SUCCESSFULLY");
  log("success", "##################################################");
  log("info", "");

  return true;
}

// ==================================================
// RUN SINGLE STORE
// ==================================================
async function runSingleStore(storeKey) {
  const store = STORES[storeKey];

  if (!store) {
    log("error", `Unknown store: ${storeKey}`);
    log("info", "Valid options: akl, wlg, chch");
    return false;
  }

  log("info", "");
  log("info", "==================================================");
  log("info", `RUNNING ${store.name.toUpperCase()} ONLY`);
  log("info", "==================================================");
  log("info", "");

  const result = await runStore(store);

  if (result.success) {
    log("success", `${store.name.toUpperCase()} only-run completed successfully`);
    return true;
  }

  log("error", `${store.name.toUpperCase()} only-run FAILED`);
  return false;
}

// ==================================================
// HELP
// ==================================================
function showHelp() {
  console.log("");
  console.log("==================================================");
  console.log(" TSB PRESALE AUTOMATION");
  console.log("==================================================");
  console.log("");

  console.log("ALL STORES:");
  console.log(" node run-presale-automation.js");
  console.log(" Runs: AKL → WLG → CHCH");
  console.log("");

  console.log("AKL ONLY:");
  console.log(" node run-presale-automation.js akl");
  console.log(" BOM → Shopify Listing → Delivery Metafield");
  console.log("");

  console.log("WLG ONLY:");
  console.log(" node run-presale-automation.js wlg");
  console.log(" BOM → WLG/AKL Tag → Delivery Metafield");
  console.log("");

  console.log("CHCH ONLY:");
  console.log(" node run-presale-automation.js chch");
  console.log(" BOM → CHCH/AKL Tag → Delivery Metafield");
  console.log("");

  console.log("HELP:");
  console.log(" node run-presale-automation.js help");
  console.log("");
}
// ==================================================
// MAIN
// ==================================================
async function main() {
  const argument = String(process.argv[2] || "")
    .trim()
    .toLowerCase();

  log("info", "");
  log("info", "TSB PRESALE AUTOMATION STARTED");
  log("info", `Command: node run-presale-automation.js${argument ? ` ${argument}` : ""}`);

  let success = false;

  // ------------------------------------------------
  // NO ARGUMENT
  // ------------------------------------------------
  if (!argument) {
    success = await runAllStores();
  }

  // ------------------------------------------------
  // AKL
  // ------------------------------------------------
  else if (argument === "akl") {
    success = await runSingleStore("akl");
  }

  // ------------------------------------------------
  // WLG
  // ------------------------------------------------
  else if (argument === "wlg") {
    success = await runSingleStore("wlg");
  }

  // ------------------------------------------------
  // CHCH
  // ------------------------------------------------
  else if (argument === "chch") {
    success = await runSingleStore("chch");
  }

  // ------------------------------------------------
  // HELP
  // ------------------------------------------------
  else if (argument === "help" || argument === "--help" || argument === "-h") {
    showHelp();
    process.exitCode = 0;
    return;
  }

  // ------------------------------------------------
  // INVALID
  // ------------------------------------------------
  else {
    log("error", `Invalid command: ${argument}`);

    console.log("");
    console.log("Valid commands:");
    console.log(" node run-presale-automation.js");
    console.log(" node run-presale-automation.js akl");
    console.log(" node run-presale-automation.js wlg");
    console.log(" node run-presale-automation.js chch");
    console.log("");

    process.exitCode = 1;
    return;
  }

  // ------------------------------------------------
  // FINAL RESULT
  // ------------------------------------------------
  if (success) {
    log("success", "");
    log("success", "TSB PRESALE AUTOMATION FINISHED SUCCESSFULLY");
    process.exitCode = 0;
  } else {
    log("error", "");
    log("error", "TSB PRESALE AUTOMATION FINISHED WITH ERRORS");
    process.exitCode = 1;
  }
}

// ==================================================
// START
// ==================================================
main().catch((err) => {
  console.error("Fatal orchestrator error:", err);
  log("error", `Fatal orchestrator error: ${err.stack || err.message}`);
  process.exitCode = 1;
});
