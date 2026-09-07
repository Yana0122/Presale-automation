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
        script: path.join(
          ROOT_DIR,
          "AKL",
          "test-shopify-old-listing.js"
        ),
      },
      {
        name: "Delivery Metafield",
        script: path.join(
          ROOT_DIR,
          "AKL",
          "set-delivery-metafield.js"
        ),
      },
    ],
  },

  wlg: {
    key: "wlg",
    name: "Wellington",

    steps: [
      {
        name: "BOM Automation",
        script: path.join(
          ROOT_DIR,
          "WLG",
          "bom-automation-wlg.js"
        ),
      },
      {
        name: "WLG → AKL Tag",
        script: path.join(
          ROOT_DIR,
          "WLG",
          "wlg-tag-akl.js"
        ),
      },
      {
        name: "Delivery Metafield",
        script: path.join(
          ROOT_DIR,
          "WLG",
          "set-delivery-metafield-wlg.js"
        ),
      },
    ],
  },

  chch: {
    key: "chch",
    name: "Christchurch",

    steps: [
      {
        name: "BOM Automation",
        script: path.join(
          ROOT_DIR,
          "CHCH",
          "bom-automation-chch.js"
        ),
      },
      {
        name: "CHCH → AKL Tag",
        script: path.join(
          ROOT_DIR,
          "CHCH",
          "chch-tag-akl.js"
        ),
      },
      {
        name: "Delivery Metafield",
        script: path.join(
          ROOT_DIR,
          "CHCH",
          "set-delivery-metafield-chch.js"
        ),
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
    fs.mkdirSync(directory, {
      recursive: true,
    });
  }
}

function log(type, message, extra = {}) {
  const entry = {
    time: new Date().toISOString(),
    type,
    message,
    ...extra,
  };

  const line = JSON.stringify(entry);

  console.log(`[${type.toUpperCase()}] ${message}`);

  ensureLogDirectory();

  fs.appendFileSync(
    LOG_FILE,
    line + "\n",
    "utf8"
  );
}

// ==================================================
// NORMALISE OUTPUT
// ==================================================

function normaliseOutput(output) {
  return String(output || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

// ==================================================
// EXTRACT NUMBER
// ==================================================

function extractNumber(lines, patterns) {
  for (const line of lines) {
    for (const pattern of patterns) {
      const match = line.match(pattern);

      if (match) {
        return Number(match[1]);
      }
    }
  }

  return null;
}

// ==================================================
// EXTRACT STEP SUMMARY
// ==================================================

function extractStepSummary(stepName, stdout, stderr) {
  const stdoutLines = normaliseOutput(stdout);
  const stderrLines = normaliseOutput(stderr);

  const allLines = [
    ...stdoutLines,
    ...stderrLines,
  ];

  const summary = {
    status: "success",
  };

  // ------------------------------------------------
  // BOM AUTOMATION
  // ------------------------------------------------

  if (stepName === "BOM Automation") {
    summary.posChecked = extractNumber(
      allLines,
      [
        /Found\s+(\d+)\s+Awaiting Receipt PO/i,
        /Found\s+(\d+)\s+Awaiting Receipt POs/i,
        /Awaiting Receipt POs?:\s*(\d+)/i,
      ]
    );

    summary.eligible = extractNumber(
      allLines,
      [
        /Eligible PO\(s\):\s*(\d+)/i,
        /Eligible:\s*(\d+)/i,
        /(\d+)\s+eligible PO/i,
      ]
    );

    summary.processed = extractNumber(
      allLines,
      [
        /Processed:\s*(\d+)/i,
        /Processed\s+(\d+)/i,
      ]
    );

    summary.blocked = extractNumber(
      allLines,
      [
        /Blocked:\s*(\d+)/i,
        /Blocked\s+(\d+)/i,
      ]
    );

    summary.skipped = extractNumber(
      allLines,
      [
        /Skipped:\s*(\d+)/i,
        /Skipped\s+(\d+)/i,
      ]
    );

    return summary;
  }

  // ------------------------------------------------
  // SHOPIFY OLD LISTING
  // ------------------------------------------------

  if (stepName === "Shopify Old Listing") {
    summary.checked = extractNumber(
      allLines,
      [
        /Total:\s*(\d+)/i,
        /Total products?:\s*(\d+)/i,
      ]
    );

    summary.eligible = extractNumber(
      allLines,
      [
        /Eligible:\s*(\d+)/i,
        /Found\s+(\d+)\s+eligible products?/i,
      ]
    );

    summary.listed = extractNumber(
      allLines,
      [
        /Listed:\s*(\d+)/i,
        /Successfully listed:\s*(\d+)/i,
      ]
    );

    summary.blocked = extractNumber(
      allLines,
      [
        /Blocked:\s*(\d+)/i,
      ]
    );

    summary.skipped = extractNumber(
      allLines,
      [
        /Skipped:\s*(\d+)/i,
      ]
    );

    return summary;
  }

  // ------------------------------------------------
  // DELIVERY METAFIELD
  // ------------------------------------------------

  if (stepName === "Delivery Metafield") {
    summary.checked = extractNumber(
      allLines,
      [
        /Total:\s*(\d+)/i,
        /Checked:\s*(\d+)/i,
        /Found\s+(\d+)\s+.*listing records?/i,
      ]
    );

    summary.updated = extractNumber(
      allLines,
      [
        /Updated:\s*(\d+)/i,
        /Successfully updated:\s*(\d+)/i,
      ]
    );

    summary.blocked = extractNumber(
      allLines,
      [
        /Blocked:\s*(\d+)/i,
      ]
    );

    summary.skipped = extractNumber(
      allLines,
      [
        /Skipped:\s*(\d+)/i,
      ]
    );

    return summary;
  }

  // ------------------------------------------------
  // TAG STEPS
  // ------------------------------------------------

  if (
    stepName === "WLG → AKL Tag" ||
    stepName === "CHCH → AKL Tag"
  ) {
    summary.checked = extractNumber(
      allLines,
      [
        /Total:\s*(\d+)/i,
        /Checked:\s*(\d+)/i,
      ]
    );

    summary.updated = extractNumber(
      allLines,
      [
        /Updated:\s*(\d+)/i,
        /Tagged:\s*(\d+)/i,
        /Successfully updated:\s*(\d+)/i,
      ]
    );

    summary.blocked = extractNumber(
      allLines,
      [
        /Blocked:\s*(\d+)/i,
      ]
    );

    summary.skipped = extractNumber(
      allLines,
      [
        /Skipped:\s*(\d+)/i,
      ]
    );

    return summary;
  }

  return summary;
}

// ==================================================
// RUN ONE SCRIPT
// ==================================================

function runScript(store, step, stepNumber) {
  return new Promise((resolve) => {
    const startTime = Date.now();

    // ------------------------------------------------
    // STEP START
    // ------------------------------------------------

    log(
      "step_start",
      `${store.name} - STEP ${stepNumber}: ${step.name}`,
      {
        store: store.key,
        step: step.name,
        stepNumber,
      }
    );

    // ------------------------------------------------
    // CHECK SCRIPT EXISTS
    // ------------------------------------------------

    if (!fs.existsSync(step.script)) {
      log(
        "step_failed",
        `${store.name} - ${step.name}: script not found`,
        {
          store: store.key,
          step: step.name,
          stepNumber,
          status: "failed",
          error: "Script not found",
        }
      );

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

    let stdoutData = "";
    let stderrData = "";

    try {
      child = spawn(
        process.execPath,
        [step.script],
        {
          cwd: ROOT_DIR,
          env: {
            ...process.env,
          },
          windowsHide: false,
          stdio: [
            "ignore",
            "pipe",
            "pipe",
          ],
        }
      );
    } catch (err) {
      log(
        "step_failed",
        `${store.name} - ${step.name}: failed to start`,
        {
          store: store.key,
          step: step.name,
          stepNumber,
          status: "failed",
          error: err.message,
        }
      );

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

      // Keep terminal output exactly as before.
      process.stdout.write(output);

      // Capture internally for summary extraction.
      stdoutData += output;
    });

    // ------------------------------------------------
    // STDERR
    // ------------------------------------------------

    child.stderr.on("data", (data) => {
      const output = data.toString();

      // Keep terminal error output.
      process.stderr.write(output);

      // Capture internally.
      stderrData += output;
    });

    // ------------------------------------------------
    // PROCESS ERROR
    // ------------------------------------------------

    child.on("error", (err) => {
      log(
        "step_failed",
        `${store.name} - ${step.name}: child process error`,
        {
          store: store.key,
          step: step.name,
          stepNumber,
          status: "failed",
          error: err.message,
        }
      );

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
      const durationMs = Date.now() - startTime;

      // ------------------------------------------------
      // FAILED
      // ------------------------------------------------

      if (code !== 0) {
        log(
          "step_summary",
          `${store.name} - ${step.name} FAILED`,
          {
            store: store.key,
            step: step.name,
            stepNumber,
            status: "failed",
            exitCode: code,
            durationMs,
          }
        );

        resolve({
          success: false,
          store: store.key,
          step: step.name,
          stepNumber,
          exitCode: code,
          error: `Automation exited with code ${code}`,
          durationMs,
        });

        return;
      }

      // ------------------------------------------------
      // SUCCESS
      // ------------------------------------------------

      const summary = extractStepSummary(
        step.name,
        stdoutData,
        stderrData
      );

      log(
        "step_summary",
        `${store.name} - ${step.name} completed`,
        {
          store: store.key,
          step: step.name,
          stepNumber,
          status: "success",
          durationMs,
          ...summary,
        }
      );

      resolve({
        success: true,
        store: store.key,
        step: step.name,
        stepNumber,
        exitCode: 0,
        error: null,
        durationMs,
        summary,
      });
    });
  });
}

// ==================================================
// RUN ONE STORE
// ==================================================

async function runStore(store) {
  const storeStartTime = Date.now();

  // ------------------------------------------------
  // AUTOMATION START
  // ------------------------------------------------

  log(
    "automation_start",
    `${store.name} automation started`,
    {
      store: store.key,
      status: "started",
      stepsTotal: store.steps.length,
    }
  );

  const results = [];

  // ------------------------------------------------
  // RUN STEPS IN ORDER
  // ------------------------------------------------

  for (let i = 0; i < store.steps.length; i++) {
    const step = store.steps[i];
    const stepNumber = i + 1;

    const result = await runScript(
      store,
      step,
      stepNumber
    );

    results.push(result);

    // ------------------------------------------------
    // STOP STORE IF STEP FAILED
    // ------------------------------------------------

    if (!result.success) {
      const durationMs =
        Date.now() - storeStartTime;

      log(
        "automation_complete",
        `${store.name} automation failed`,
        {
          store: store.key,
          status: "failed",
          stepsCompleted: results.filter(
            (item) => item.success
          ).length,
          stepsTotal: store.steps.length,
          failedStep: step.name,
          durationMs,
        }
      );

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

  const durationMs =
    Date.now() - storeStartTime;

  log(
    "automation_complete",
    `${store.name} automation completed`,
    {
      store: store.key,
      status: "success",
      stepsCompleted: results.length,
      stepsTotal: store.steps.length,
      durationMs,
    }
  );

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
  log(
    "all_stores_start",
    "TSB Presale Automation - All Stores",
    {
      stores: [
        "akl",
        "wlg",
        "chch",
      ],
    }
  );

  // ------------------------------------------------
  // AKL
  // ------------------------------------------------

  const aklResult =
    await runStore(STORES.akl);

  if (!aklResult.success) {
    log(
      "all_stores_failed",
      "AKL automation failed. WLG and CHCH will not run.",
      {
        status: "failed",
        failedStore: "akl",
      }
    );

    return false;
  }

  // ------------------------------------------------
  // WLG
  // ------------------------------------------------

  const wlgResult =
    await runStore(STORES.wlg);

  if (!wlgResult.success) {
    log(
      "all_stores_failed",
      "WLG automation failed. CHCH will not run.",
      {
        status: "failed",
        failedStore: "wlg",
      }
    );

    return false;
  }

  // ------------------------------------------------
  // CHCH
  // ------------------------------------------------

  const chchResult =
    await runStore(STORES.chch);

  if (!chchResult.success) {
    log(
      "all_stores_failed",
      "CHCH automation failed.",
      {
        status: "failed",
        failedStore: "chch",
      }
    );

    return false;
  }

  // ------------------------------------------------
  // ALL SUCCESS
  // ------------------------------------------------

  log(
    "all_stores_complete",
    "All stores completed successfully",
    {
      status: "success",
      storesCompleted: 3,
      storesTotal: 3,
    }
  );

  return true;
}

// ==================================================
// RUN SINGLE STORE
// ==================================================

async function runSingleStore(storeKey) {
  const store = STORES[storeKey];

  if (!store) {
    log(
      "error",
      `Unknown store: ${storeKey}`,
      {
        status: "failed",
      }
    );

    console.log(
      "Valid options: akl, wlg, chch"
    );

    return false;
  }

  const result =
    await runStore(store);

  if (result.success) {
    log(
      "success",
      `${store.name} only-run completed successfully`,
      {
        store: store.key,
        status: "success",
      }
    );

    return true;
  }

  log(
    "error",
    `${store.name} only-run FAILED`,
    {
      store: store.key,
      status: "failed",
    }
  );

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
  const argument = String(
    process.argv[2] || ""
  )
    .trim()
    .toLowerCase();

  log(
    "automation_command",
    "TSB Presale Automation started",
    {
      command: argument
        ? `node run-presale-automation.js ${argument}`
        : "node run-presale-automation.js",
    }
  );

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

  else if (
    argument === "help" ||
    argument === "--help" ||
    argument === "-h"
  ) {
    showHelp();

    process.exitCode = 0;

    return;
  }

  // ------------------------------------------------
  // INVALID
  // ------------------------------------------------

  else {
    log(
      "error",
      `Invalid command: ${argument}`,
      {
        status: "failed",
      }
    );

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
    log(
      "automation_finished",
      "TSB Presale Automation finished successfully",
      {
        status: "success",
      }
    );

    process.exitCode = 0;
  } else {
    log(
      "automation_finished",
      "TSB Presale Automation finished with errors",
      {
        status: "failed",
      }
    );

    process.exitCode = 1;
  }
}

// ==================================================
// START
// ==================================================

main().catch((err) => {
  console.error(
    "Fatal orchestrator error:",
    err
  );

  log(
    "fatal_error",
    "Fatal orchestrator error",
    {
      status: "failed",
      error: err.stack || err.message,
    }
  );

  process.exitCode = 1;
});