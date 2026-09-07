require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// ==================================================
// BASE
// ==================================================
const ROOT_DIR = __dirname;
const LOG_FILE = path.join(ROOT_DIR, "auto-remove-presale-all.log");

// ==================================================
// STORE CONFIGURATION
// ==================================================
const STORES = [
  {
    key: "akl",
    name: "Auckland",
    script: path.join(ROOT_DIR, "AKL", "auto-remove-presale.js"),
  },
  {
    key: "wlg",
    name: "Wellington",
    script: path.join(ROOT_DIR, "WLG", "auto-remove-presale-wlg.js"),
  },
  {
    key: "chch",
    name: "Christchurch",
    script: path.join(ROOT_DIR, "CHCH", "auto-remove-presale-chch.js"),
  },
];

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
  const timestamp = new Date().toISOString();

  const entry = {
    time: timestamp,
    type,
    message,
  };

  const line = JSON.stringify(entry);

  if (type === "error") {
    console.error(`[${type.toUpperCase()}] ${message}`);
  } else {
    console.log(`[${type.toUpperCase()}] ${message}`);
  }

  ensureLogDirectory();
  fs.appendFileSync(LOG_FILE, line + "\n");
}

// ==================================================
// RUN ONE REMOVE-PRESALE SCRIPT
// ==================================================
function runStore(store, storeNumber) {
  return new Promise((resolve) => {
    log("info", "");
    log("info", "==================================================");
    log(
      "info",
      `STARTING ${store.name.toUpperCase()} REMOVE-PRESALE`
    );
    log("info", "==================================================");
    log("info", `Store: ${store.key.toUpperCase()}`);
    log("info", `Step: ${storeNumber} of ${STORES.length}`);
    log("info", `Script: ${store.script}`);
    log("info", "");

    // ------------------------------------------------
    // CHECK SCRIPT EXISTS
    // ------------------------------------------------
    if (!fs.existsSync(store.script)) {
      log(
        "error",
        `${store.name} remove-presale script not found`
      );
      log("error", `Expected path: ${store.script}`);

      resolve({
        success: false,
        store: store.key,
        name: store.name,
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
      child = spawn(process.execPath, [store.script], {
        cwd: ROOT_DIR,
        env: {
          ...process.env,
        },
        windowsHide: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      log(
        "error",
        `${store.name} remove-presale failed to start`
      );
      log("error", err.message);

      resolve({
        success: false,
        store: store.key,
        name: store.name,
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
        log(
          "info",
          `[${store.key.toUpperCase()}] ${trimmed}`
        );
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
        log(
          "error",
          `[${store.key.toUpperCase()}] ${trimmed}`
        );
      }
    });

    // ------------------------------------------------
    // PROCESS ERROR
    // ------------------------------------------------
    child.on("error", (err) => {
      log(
        "error",
        `${store.name} remove-presale child process error`
      );
      log("error", err.message);

      resolve({
        success: false,
        store: store.key,
        name: store.name,
        exitCode: null,
        error: err.message,
      });
    });

    // ------------------------------------------------
    // PROCESS FINISHED
    // ------------------------------------------------
    child.on("close", (code) => {
      if (code === 0) {
        log("success", "");
        log(
          "success",
          `${store.name.toUpperCase()} REMOVE-PRESALE COMPLETED`
        );
        log("info", "==================================================");
        log("info", "");

        resolve({
          success: true,
          store: store.key,
          name: store.name,
          exitCode: 0,
          error: null,
        });

        return;
      }

      log("error", "");
      log(
        "error",
        `${store.name.toUpperCase()} REMOVE-PRESALE FAILED`
      );
      log("error", `Exit code: ${code}`);
      log("info", "==================================================");
      log("info", "");

      resolve({
        success: false,
        store: store.key,
        name: store.name,
        exitCode: code,
        error: `Automation exited with code ${code}`,
      });
    });
  });
}

// ==================================================
// RUN ALL STORES
// ==================================================
async function runAllStores() {
  const startTime = Date.now();

  log("info", "");
  log("info", "##################################################");
  log("info", "# TSB PRESALE REMOVE AUTOMATION");
  log("info", "# AKL → WLG → CHCH");
  log("info", "##################################################");
  log("info", "");
  log("info", "All three store remove-presale scripts will run.");
  log("info", "A failure in one store will NOT stop the others.");
  log("info", "");

  const results = [];

  // ------------------------------------------------
  // RUN STORES SEQUENTIALLY
  // ------------------------------------------------
  for (let i = 0; i < STORES.length; i++) {
    const store = STORES[i];

    const result = await runStore(store, i + 1);

    results.push(result);

    // ------------------------------------------------
    // IMPORTANT:
    // DO NOT STOP IF ONE STORE FAILS
    // ------------------------------------------------
    if (!result.success) {
      log(
        "error",
        `${store.name} failed, but remaining stores will continue.`
      );
    }
  }

  // ------------------------------------------------
  // SUMMARY
  // ------------------------------------------------
  const successful = results.filter(
    (result) => result.success
  );

  const failed = results.filter(
    (result) => !result.success
  );

  const durationSeconds = (
    (Date.now() - startTime) /
    1000
  ).toFixed(1);

  log("info", "");
  log("info", "##################################################");
  log("info", "# REMOVE-PRESALE RUN SUMMARY");
  log("info", "##################################################");
  log("info", "");

  results.forEach((result) => {
    if (result.success) {
      log(
        "success",
        `${result.name}: SUCCESS`
      );
    } else {
      log(
        "error",
        `${result.name}: FAILED`
      );
    }
  });

  log("info", "");
  log(
    "info",
    `Successful stores: ${successful.length}/${STORES.length}`
  );
  log(
    "info",
    `Failed stores: ${failed.length}/${STORES.length}`
  );
  log("info", `Total duration: ${durationSeconds}s`);
  log("info", "");

  // ------------------------------------------------
  // FINAL RESULT
  // ------------------------------------------------
  if (failed.length === 0) {
    log("success", "##################################################");
    log("success", "# ALL REMOVE-PRESALE STORES COMPLETED");
    log("success", "##################################################");
    log("info", "");

    return true;
  }

  log("error", "##################################################");
  log("error", "# REMOVE-PRESALE COMPLETED WITH ERRORS");
  log("error", "##################################################");
  log("info", "");

  return false;
}

// ==================================================
// MAIN
// ==================================================
async function main() {
  log("info", "");
  log("info", "TSB REMOVE-PRESALE MASTER STARTED");
  log("info", `Started: ${new Date().toISOString()}`);
  log("info", "");

  try {
    const success = await runAllStores();

    if (success) {
      log(
        "success",
        "TSB REMOVE-PRESALE MASTER FINISHED SUCCESSFULLY"
      );

      process.exitCode = 0;
    } else {
      log(
        "error",
        "TSB REMOVE-PRESALE MASTER FINISHED WITH ERRORS"
      );

      // IMPORTANT:
      // The Railway job will show as failed if any store failed,
      // while all stores will still have been attempted.
      process.exitCode = 1;
    }
  } catch (err) {
    log("error", "Fatal master remove-presale error");
    log("error", err.stack || err.message);

    process.exitCode = 1;
  }
}

// ==================================================
// START
// ==================================================
main();

