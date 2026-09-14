"use strict";

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const RUNTIME_DIR = "/var/lib/unknown-home";
const ENABLED_FILE = path.join(RUNTIME_DIR, "account-terms-guard.enabled");
const HOME_REDIRECT_ENABLED_FILE = path.join(RUNTIME_DIR, "home-button.enabled");
const PID_FILE = "/tmp/unknown-home-account-terms-guard.pid";
const LOG_FILE = "/tmp/unknown-home-account-terms-guard.log";
const STOCK_HOME_BYPASS_FILE = "/tmp/unknown-home-stock-home.until";
const EULA_POLICY_SCRIPT = path.join(__dirname, "unknown-home-eula-launch-policy.js");
const LIFE_URI = "luna://com.webos.applicationManager/getAppLifeEvents";
const FOREGROUND_URI = "luna://com.webos.applicationManager/getForegroundAppInfo";
const CLOSE_URI = "luna://com.webos.applicationManager/closeByAppId";
const LAUNCH_URI = "luna://com.webos.applicationManager/launch";
const FALLBACK_APP_ID = "org.unknown.core";
const STOCK_HOME_APP_ID = "com.webos.app.home";
const HOME_REDIRECT_COOLDOWN_MS = 2500;
const BLOCKED_APP_IDS = new Set([
  "com.webos.app.membership",
  "com.webos.app.overlaymembership",
  "com.webos.app.firstuse-overlay"
]);

function log(message) {
  try {
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + " " + message + "\n");
  } catch (error) {
    // Logging is best effort.
  }
}

function enabled() {
  return fs.existsSync(ENABLED_FILE);
}

function homeRedirectEnabled() {
  return false;
}

function shouldRun() {
  return enabled() || homeRedirectEnabled();
}

function runLaunchPolicy(command) {
  if (!fs.existsSync(EULA_POLICY_SCRIPT)) {
    return { available: false, changesAcceptanceState: false };
  }
  const result = childProcess.spawnSync(
    process.execPath,
    [EULA_POLICY_SCRIPT, command],
    { encoding: "utf8", timeout: 30000, maxBuffer: 512 * 1024 }
  );
  let status = {};
  try {
    status = JSON.parse(String(result.stdout || "").trim() || "{}");
  } catch (error) {
    status = {};
  }
  status.available = !result.error && status.available !== false;
  status.changesAcceptanceState = false;
  if (result.error || result.status !== 0) {
    status.errorText = String(result.stderr || (result.error && result.error.message) ||
      "EULA launch policy failed").trim();
    log("launch policy " + command + " failed: " + status.errorText.slice(-400));
  }
  return status;
}

function readPid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
    return Number.isInteger(pid) && pid > 1 ? pid : 0;
  } catch (error) {
    return 0;
  }
}

function ownedProcess(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    const command = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").replace(/\0/g, " ");
    return command.indexOf(path.basename(__filename)) >= 0 && command.indexOf("daemon") >= 0;
  } catch (error) {
    return false;
  }
}

function running() {
  return ownedProcess(readPid());
}

function status() {
  const daemonRunning = running();
  const launchPolicy = runLaunchPolicy("status");
  return {
    available: typeof process.getuid === "function" && process.getuid() === 0 &&
      fs.existsSync("/usr/bin/luna-send"),
    enabled: enabled(),
    running: daemonRunning,
    homeRedirectEnabled: homeRedirectEnabled(),
    homeRedirectRunning: homeRedirectEnabled() && daemonRunning,
    blockedAppIds: Array.from(BLOCKED_APP_IDS),
    launchPolicy: launchPolicy,
    protectedAppIds: launchPolicy.protectedAppIds || [],
    protectedAppCount: Number(launchPolicy.protectedCount || 0),
    samReloadRequired: launchPolicy.samReloadRequired === true,
    changesAcceptanceState: false
  };
}

function writeStatusAndExit(code) {
  process.stdout.write(JSON.stringify(status()) + "\n");
  process.exit(code || 0);
}

function stop() {
  const pid = readPid();
  if (ownedProcess(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      log("stop failed: " + error.message);
    }
  }
  try {
    fs.unlinkSync(PID_FILE);
  } catch (error) {
    if (error.code !== "ENOENT") {
      log("pid cleanup failed: " + error.message);
    }
  }
}

function ensureDaemon() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o755 });
  if (!shouldRun() || running()) {
    return;
  }
  const child = childProcess.spawn(process.execPath, [__filename, "daemon"], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

function start() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o755 });
  fs.closeSync(fs.openSync(ENABLED_FILE, "a", 0o600));
  fs.chmodSync(ENABLED_FILE, 0o600);
  runLaunchPolicy("reconcile-safe");
  ensureDaemon();
}

function runDaemon() {
  if (!shouldRun()) {
    process.exit(0);
  }
  fs.writeFileSync(PID_FILE, String(process.pid) + "\n", { mode: 0o600 });

  const observers = new Map();
  const restartTimers = new Map();
  const suppressTimers = new Map();
  let restoreTimer = null;
  let homeRedirectTimer = null;
  let lastSafeAppId = "";
  let lastHomeRedirectAt = 0;
  let stockHomeAllowed = false;
  let shuttingDown = false;
  let policyTimer = null;

  function lunaRequest(uri, payload, callback) {
    childProcess.execFile(
      "/usr/bin/luna-send",
      ["-n", "1", "-f", uri, JSON.stringify(payload || {})],
      { timeout: 10000, maxBuffer: 128 * 1024 },
      (error, stdout) => {
        let reply = {};
        if (stdout) {
          try {
            reply = JSON.parse(stdout);
          } catch (parseError) {
            reply = {};
          }
        }
        callback(error, reply);
      }
    );
  }

  function closeBlockedApp(appId, reason) {
    if (!enabled() || !BLOCKED_APP_IDS.has(appId)) {
      return;
    }
    log("blocked " + appId + " reason=" + reason);
    lunaRequest(CLOSE_URI, { id: appId }, (error, reply) => {
      if (error || reply.returnValue === false) {
        log("close failed " + appId + ": " +
          (error ? error.message : (reply.errorText || "unknown error")));
      }
    });
    clearTimeout(restoreTimer);
    restoreTimer = setTimeout(ensureRestored, 180);
    setTimeout(() => runLaunchPolicy("reconcile-safe"), 500);
  }

  function scheduleSuppression(appId, reason, delay) {
    if (!BLOCKED_APP_IDS.has(appId)) {
      return;
    }
    clearTimeout(suppressTimers.get(appId));
    suppressTimers.set(appId, setTimeout(() => {
      suppressTimers.delete(appId);
      closeBlockedApp(appId, reason);
    }, delay || 0));
  }

  function launchFallback() {
    const appId = lastSafeAppId && !BLOCKED_APP_IDS.has(lastSafeAppId)
      ? lastSafeAppId
      : FALLBACK_APP_ID;
    lunaRequest(LAUNCH_URI, {
      id: appId,
      params: { source: "account-terms-guard" }
    }, (error, reply) => {
      if (error || reply.returnValue === false) {
        log("fallback launch failed " + appId);
      }
    });
  }

  function ensureRestored() {
    restoreTimer = null;
    lunaRequest(FOREGROUND_URI, {}, (error, reply) => {
      if (error) {
        log("foreground check failed: " + error.message);
        return;
      }
      if (reply && BLOCKED_APP_IDS.has(reply.appId)) {
        closeBlockedApp(reply.appId, "foreground verification");
        setTimeout(launchFallback, 120);
      }
    });
  }

  function removeStockHomeBypass() {
    try {
      fs.unlinkSync(STOCK_HOME_BYPASS_FILE);
    } catch (error) {
      if (error.code !== "ENOENT") log("stock Home bypass cleanup failed: " + error.message);
    }
  }

  function stockHomeBypassActive() {
    try {
      const deadline = Number(fs.readFileSync(STOCK_HOME_BYPASS_FILE, "utf8").trim());
      const now = Date.now();
      if (Number.isFinite(deadline) && deadline >= now && deadline <= now + (15 * 60 * 1000)) {
        return true;
      }
    } catch (error) {
      if (error.code !== "ENOENT") log("stock Home bypass read failed: " + error.message);
    }
    removeStockHomeBypass();
    return false;
  }

  function redirectStockHome(reason) {
    homeRedirectTimer = null;
    if (!homeRedirectEnabled() || stockHomeAllowed) {
      return;
    }
    if (stockHomeBypassActive()) {
      stockHomeAllowed = true;
      return;
    }
    const now = Date.now();
    if (now - lastHomeRedirectAt < HOME_REDIRECT_COOLDOWN_MS) {
      return;
    }
    lastHomeRedirectAt = now;
    log("redirecting unexpected stock Home reason=" + reason);
    lunaRequest(LAUNCH_URI, {
      id: FALLBACK_APP_ID,
      params: { source: "unknown-home-idle-fallback", reason: reason }
    }, (error, reply) => {
      if (error || reply.returnValue === false) {
        log("stock Home redirect failed: " +
          (error ? error.message : (reply.errorText || "unknown error")));
      }
    });
  }

  function scheduleHomeRedirect(reason, delay) {
    if (!homeRedirectEnabled()) {
      return;
    }
    if (stockHomeAllowed || stockHomeBypassActive()) {
      stockHomeAllowed = true;
      clearTimeout(homeRedirectTimer);
      homeRedirectTimer = null;
      return;
    }
    clearTimeout(homeRedirectTimer);
    homeRedirectTimer = setTimeout(() => redirectStockHome(reason), delay || 0);
  }

  function handleLifeEvent(reply) {
    if (!reply || typeof reply.appId !== "string") {
      return;
    }
    if (reply.appId === STOCK_HOME_APP_ID &&
        (reply.event === "splash" || reply.event === "launch" || reply.event === "foreground")) {
      scheduleHomeRedirect("life " + reply.event, reply.event === "splash" ? 25 : 0);
    }
    if (!enabled() || !BLOCKED_APP_IDS.has(reply.appId)) {
      return;
    }
    if (reply.event === "splash") {
      scheduleSuppression(reply.appId, "life splash", 35);
    } else if (reply.event === "launch") {
      scheduleSuppression(reply.appId, "life launch", 0);
    }
  }

  function handleForeground(reply) {
    if (!reply || reply.returnValue !== true || typeof reply.appId !== "string") {
      return;
    }
    if (reply.appId === STOCK_HOME_APP_ID) {
      scheduleHomeRedirect("foreground", 0);
      return;
    }
    clearTimeout(homeRedirectTimer);
    homeRedirectTimer = null;
    if (stockHomeAllowed) {
      stockHomeAllowed = false;
      removeStockHomeBypass();
    }
    if (BLOCKED_APP_IDS.has(reply.appId)) {
      scheduleSuppression(reply.appId, "foreground", 0);
      return;
    }
    if (reply.appId) {
      lastSafeAppId = reply.appId;
    }
  }

  function handleLine(name, line, handler) {
    const text = line.trim();
    if (!text) {
      return;
    }
    try {
      handler(JSON.parse(text));
    } catch (error) {
      log(name + " observer parse failed");
    }
  }

  function startObserver(name, uri, handler) {
    if (observers.has(name) || shuttingDown || !shouldRun()) {
      return;
    }
    let buffer = "";
    const child = childProcess.spawn(
      "/usr/bin/luna-send",
      ["-i", uri, JSON.stringify({ subscribe: true })],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    observers.set(name, child);
    log(name + " observer started");
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        handleLine(name, buffer.slice(0, newline), handler);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        log(name + " observer: " + message.slice(-300));
      }
    });
    child.on("error", (error) => {
      log(name + " observer failed: " + error.message);
    });
    child.on("exit", (code) => {
      if (observers.get(name) === child) {
        observers.delete(name);
      }
      if (buffer) {
        handleLine(name, buffer, handler);
        buffer = "";
      }
      if (!shuttingDown && shouldRun()) {
        log(name + " observer exited code=" + code);
        restartTimers.set(name, setTimeout(() => {
          restartTimers.delete(name);
          startObserver(name, uri, handler);
        }, 1000));
      }
    });
  }

  function closeAll() {
    shuttingDown = true;
    clearTimeout(restoreTimer);
    clearTimeout(homeRedirectTimer);
    clearInterval(policyTimer);
    restartTimers.forEach((timer) => clearTimeout(timer));
    suppressTimers.forEach((timer) => clearTimeout(timer));
    observers.forEach((child) => {
      try {
        child.kill("SIGTERM");
      } catch (error) {
        // The observer may already have exited.
      }
    });
    try {
      if (readPid() === process.pid) {
        fs.unlinkSync(PID_FILE);
      }
    } catch (error) {
      // The pid file may already be gone.
    }
  }

  process.on("SIGTERM", () => {
    closeAll();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    closeAll();
    process.exit(0);
  });
  process.on("exit", closeAll);

  log("daemon started");
  if (enabled()) runLaunchPolicy("reconcile-safe");
  policyTimer = setInterval(() => {
    if (enabled()) runLaunchPolicy("reconcile-safe");
  }, 60000);
  startObserver("foreground", FOREGROUND_URI, handleForeground);
  startObserver("lifecycle", LIFE_URI, handleLifeEvent);
}

function main() {
  const command = process.argv[2] || "status";
  if (command === "daemon") {
    runDaemon();
    return;
  }
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    throw new Error("root is required");
  }
  if (command === "on") {
    start();
    setTimeout(() => writeStatusAndExit(0), 350);
    return;
  }
  if (command === "off") {
    try {
      fs.unlinkSync(ENABLED_FILE);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    runLaunchPolicy("reconcile-safe");
    if (shouldRun()) {
      ensureDaemon();
    } else {
      stop();
    }
    setTimeout(() => writeStatusAndExit(0), 120);
    return;
  }
  if (command === "start-enabled") {
    if (enabled()) runLaunchPolicy("reconcile-safe");
    if (shouldRun()) {
      ensureDaemon();
    } else {
      stop();
    }
    setTimeout(() => writeStatusAndExit(0), 350);
    return;
  }
  if (command === "restart-enabled") {
    stop();
    setTimeout(() => {
      if (enabled()) runLaunchPolicy("reconcile-safe");
      if (shouldRun()) ensureDaemon();
      setTimeout(() => writeStatusAndExit(0), 350);
    }, 250);
    return;
  }
  if (command === "status") {
    writeStatusAndExit(0);
    return;
  }
  throw new Error("unsupported command");
}

try {
  main();
} catch (error) {
  process.stderr.write(String(error && error.stack ? error.stack : error) + "\n");
  process.exit(1);
}
