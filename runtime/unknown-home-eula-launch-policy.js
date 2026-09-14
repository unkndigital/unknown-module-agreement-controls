"use strict";

const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BASE_DIR = process.env.UNKNOWN_HOME_EULA_POLICY_STATE_DIR ||
  "/var/lib/unknown-home/eula-launch-policy";
const STATE_FILE = path.join(BASE_DIR, "state.json");
const BACKUP_DIR = path.join(BASE_DIR, "backups");
const ENABLED_FILE = process.env.UNKNOWN_HOME_EULA_POLICY_ENABLED_FILE ||
  "/var/lib/unknown-home/account-terms-guard.enabled";
const DEFAULT_APP_ROOTS = [
  "/media/cryptofs/apps/usr/palm/applications"
];
const APP_ROOTS = process.env.UNKNOWN_HOME_EULA_POLICY_ROOTS_JSON
  ? JSON.parse(process.env.UNKNOWN_HOME_EULA_POLICY_ROOTS_JSON)
  : DEFAULT_APP_ROOTS;
const REQUIRED_EULA = "generalTerms";
const SAFE_RELOAD_APP_IDS = new Set([
  "org.unknown.home",
  "com.webos.app.home"
]);
const SYSTEMD_RUNTIME_DIR = process.env.UNKNOWN_HOME_EULA_POLICY_SYSTEMD_DIR ||
  "/run/systemd/system";
const POLICY_UNIT_NAME = "unknown-home-eula-policy.service";
const POLICY_UNIT_FILE = path.join(SYSTEMD_RUNTIME_DIR, POLICY_UNIT_NAME);
const SAM_DROPIN_DIR = path.join(SYSTEMD_RUNTIME_DIR, "sam.service.d");
const SAM_DROPIN_FILE = path.join(SAM_DROPIN_DIR, "unknown-home-eula-policy.conf");
const POLICY_UNIT = [
  "[Unit]",
  "Description=Unknown Home downloaded-app agreement launch policy",
  "DefaultDependencies=no",
  "After=mount-readonly-volatile.service",
  "Before=sam.service",
  "",
  "[Service]",
  "Type=oneshot",
  "ExecStart=/usr/bin/node " + __filename + " apply-enabled",
  "TimeoutStartSec=20",
  "RemainAfterExit=yes",
  ""
].join("\n");
const SAM_DROPIN = [
  "[Unit]",
  "Wants=" + POLICY_UNIT_NAME,
  "After=" + POLICY_UNIT_NAME,
  ""
].join("\n");

function hash(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return fallback;
  }
}

function fsyncDirectory(directory) {
  let fd = -1;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
  } catch (error) {
    // Some filesystems do not permit directory fsync.
  } finally {
    if (fd >= 0) fs.closeSync(fd);
  }
}

function writeAtomic(file, data, metadata) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
  const temporary = file + ".unknown-home." + process.pid + ".tmp";
  let fd = -1;
  try {
    fd = fs.openSync(temporary, "wx", metadata && metadata.mode !== undefined
      ? metadata.mode
      : 0o600);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = -1;
    if (metadata && Number.isInteger(metadata.uid) && Number.isInteger(metadata.gid)) {
      try {
        fs.chownSync(temporary, metadata.uid, metadata.gid);
      } catch (error) {
        if (process.platform !== "win32") throw error;
      }
    }
    if (metadata && metadata.mode !== undefined) {
      fs.chmodSync(temporary, metadata.mode);
    }
    fs.renameSync(temporary, file);
    fsyncDirectory(directory);
  } catch (error) {
    if (fd >= 0) fs.closeSync(fd);
    try {
      fs.unlinkSync(temporary);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") {
        // Preserve the original error.
      }
    }
    throw error;
  }
}

function writeIfChanged(file, data, metadata) {
  try {
    if (fs.readFileSync(file, "utf8") === data) return false;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  writeAtomic(file, data, metadata);
  return true;
}

function loadState() {
  const state = readJson(STATE_FILE, null);
  if (!state || state.version !== 1 || !state.entries || typeof state.entries !== "object") {
    return { version: 1, entries: {} };
  }
  return state;
}

function saveState(state) {
  writeAtomic(STATE_FILE, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

function rootContains(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== "..");
}

function discoverAppInfos() {
  const found = [];
  APP_ROOTS.forEach((configuredRoot) => {
    let root;
    try {
      root = fs.realpathSync(configuredRoot);
    } catch (error) {
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(root);
    } catch (error) {
      return;
    }
    entries.forEach((entry) => {
      if (!/^[A-Za-z0-9._-]+$/.test(entry)) return;
      const appDirectory = path.join(root, entry);
      const appInfoPath = path.join(appDirectory, "appinfo.json");
      try {
        if (!fs.lstatSync(appDirectory).isDirectory()) return;
        if (!fs.lstatSync(appInfoPath).isFile()) return;
        const resolved = fs.realpathSync(appInfoPath);
        if (!rootContains(root, resolved)) return;
        const raw = fs.readFileSync(resolved);
        const info = JSON.parse(raw.toString("utf8"));
        if (!info || typeof info.id !== "string" || !/^[A-Za-z0-9._-]+$/.test(info.id)) {
          return;
        }
        found.push({
          appId: info.id,
          appInfoPath: resolved,
          info: info,
          raw: raw,
          stat: fs.statSync(resolved)
        });
      } catch (error) {
        // Invalid or transient app directories are ignored.
      }
    });
  });
  return found;
}

function backupPath(appId, originalHash) {
  return path.join(BACKUP_DIR, appId, originalHash + ".json");
}

function ensureBackup(app, originalHash) {
  const file = backupPath(app.appId, originalHash);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) {
    if (hash(fs.readFileSync(file)) !== originalHash) {
      throw new Error("backup checksum mismatch for " + app.appId);
    }
    return file;
  }
  writeAtomic(file, app.raw, { mode: 0o600 });
  if (hash(fs.readFileSync(file)) !== originalHash) {
    throw new Error("backup verification failed for " + app.appId);
  }
  return file;
}

function descriptorMetadata(stat) {
  return {
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode & 0o777
  };
}

function applyPolicy() {
  const state = loadState();
  const changedAppIds = [];
  const errors = [];
  discoverAppInfos().forEach((app) => {
    if (app.info.requiredEULA !== REQUIRED_EULA) return;
    try {
      const originalHash = hash(app.raw);
      const backup = ensureBackup(app, originalHash);
      const patchedInfo = Object.assign({}, app.info);
      delete patchedInfo.requiredEULA;
      const patchedRaw = Buffer.from(JSON.stringify(patchedInfo, null, 2) + "\n", "utf8");
      const patchedHash = hash(patchedRaw);
      writeAtomic(app.appInfoPath, patchedRaw, descriptorMetadata(app.stat));

      const verified = fs.readFileSync(app.appInfoPath);
      const verifiedInfo = JSON.parse(verified.toString("utf8"));
      if (hash(verified) !== patchedHash || Object.prototype.hasOwnProperty.call(verifiedInfo, "requiredEULA")) {
        writeAtomic(app.appInfoPath, app.raw, descriptorMetadata(app.stat));
        throw new Error("patched descriptor verification failed for " + app.appId);
      }
      const expected = Object.assign({}, app.info);
      delete expected.requiredEULA;
      if (JSON.stringify(verifiedInfo) !== JSON.stringify(expected)) {
        writeAtomic(app.appInfoPath, app.raw, descriptorMetadata(app.stat));
        throw new Error("descriptor changed beyond requiredEULA for " + app.appId);
      }

      state.entries[app.appId] = {
        appId: app.appId,
        appInfoPath: app.appInfoPath,
        appVersion: String(app.info.version || ""),
        originalHash: originalHash,
        patchedHash: patchedHash,
        backupPath: backup,
        patchedAt: new Date().toISOString()
      };
      changedAppIds.push(app.appId);
    } catch (error) {
      errors.push(app.appId + ": " + error.message);
    }
  });
  saveState(state);
  return { changedAppIds: changedAppIds.sort(), errors: errors };
}

function restorePolicy() {
  const state = loadState();
  const restoredAppIds = [];
  const skippedAppIds = [];
  const errors = [];
  Object.keys(state.entries).forEach((key) => {
    const entry = state.entries[key];
    try {
      const allowed = APP_ROOTS.some((root) => {
        try {
          return rootContains(fs.realpathSync(root), fs.realpathSync(entry.appInfoPath));
        } catch (error) {
          return false;
        }
      });
      if (!allowed || !rootContains(BACKUP_DIR, path.resolve(entry.backupPath))) {
        throw new Error("state path is outside the managed roots");
      }
      const backup = fs.readFileSync(entry.backupPath);
      if (hash(backup) !== entry.originalHash) {
        throw new Error("backup checksum mismatch");
      }
      const current = fs.readFileSync(entry.appInfoPath);
      const currentHash = hash(current);
      if (currentHash === entry.originalHash) {
        delete state.entries[key];
        return;
      }
      if (currentHash !== entry.patchedHash) {
        skippedAppIds.push(entry.appId);
        return;
      }
      const currentStat = fs.statSync(entry.appInfoPath);
      writeAtomic(entry.appInfoPath, backup, descriptorMetadata(currentStat));
      if (hash(fs.readFileSync(entry.appInfoPath)) !== entry.originalHash) {
        throw new Error("restored descriptor verification failed");
      }
      delete state.entries[key];
      restoredAppIds.push(entry.appId);
    } catch (error) {
      errors.push(String(entry && entry.appId ? entry.appId : key) + ": " + error.message);
    }
  });
  saveState(state);
  return {
    restoredAppIds: restoredAppIds.sort(),
    skippedAppIds: skippedAppIds.sort(),
    errors: errors
  };
}

function lunaRequest(uri, payload) {
  if (!fs.existsSync("/usr/bin/luna-send")) return null;
  const result = childProcess.spawnSync(
    "/usr/bin/luna-send",
    ["-n", "1", "-f", uri, JSON.stringify(payload || {})],
    { encoding: "utf8", timeout: 5000, maxBuffer: 512 * 1024 }
  );
  if (result.error || result.status !== 0 || !result.stdout) return null;
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    return null;
  }
}

function samRequiredEulaMap() {
  const reply = lunaRequest(
    "luna://com.webos.applicationManager/listApps",
    { properties: ["id", "requiredEULA"] }
  );
  if (!reply || reply.returnValue !== true || !Array.isArray(reply.apps)) return null;
  const result = new Map();
  reply.apps.forEach((app) => {
    if (app && typeof app.id === "string") {
      result.set(app.id, app.requiredEULA);
    }
  });
  return result;
}

function inspectPolicy(checkSam) {
  const state = loadState();
  const apps = discoverAppInfos();
  const appById = new Map(apps.map((app) => [app.appId, app]));
  const pendingAppIds = [];
  const protectedAppIds = [];
  const staleAppIds = [];

  apps.forEach((app) => {
    if (app.info.requiredEULA === REQUIRED_EULA) pendingAppIds.push(app.appId);
  });
  Object.keys(state.entries).forEach((key) => {
    const entry = state.entries[key];
    const app = appById.get(entry.appId);
    if (!app || hash(app.raw) !== entry.patchedHash ||
        Object.prototype.hasOwnProperty.call(app.info, "requiredEULA")) {
      staleAppIds.push(entry.appId);
      return;
    }
    protectedAppIds.push(entry.appId);
  });

  const samMismatchedAppIds = [];
  let samAvailable = false;
  if (checkSam) {
    const samApps = samRequiredEulaMap();
    samAvailable = samApps !== null;
    apps.forEach((app) => {
      if (app.info.requiredEULA !== REQUIRED_EULA && protectedAppIds.indexOf(app.appId) < 0) {
        return;
      }
      if (!samApps || !samApps.has(app.appId)) return;
      const diskRequires = app.info.requiredEULA === REQUIRED_EULA;
      const samRequires = samApps.get(app.appId) === REQUIRED_EULA;
      if (diskRequires !== samRequires) samMismatchedAppIds.push(app.appId);
    });
  }

  return {
    available: true,
    enabled: fs.existsSync(ENABLED_FILE),
    requiredEulaValue: REQUIRED_EULA,
    protectedAppIds: protectedAppIds.sort(),
    protectedCount: protectedAppIds.length,
    pendingAppIds: pendingAppIds.sort(),
    pendingCount: pendingAppIds.length,
    staleAppIds: staleAppIds.sort(),
    staleCount: staleAppIds.length,
    samAvailable: samAvailable,
    samMismatchedAppIds: samMismatchedAppIds.sort(),
    samReloadRequired: samMismatchedAppIds.length > 0,
    changesAcceptanceState: false
  };
}

function foregroundAppId() {
  const reply = lunaRequest(
    "luna://com.webos.applicationManager/getForegroundAppInfo",
    {}
  );
  return reply && reply.returnValue === true && typeof reply.appId === "string"
    ? reply.appId
    : "";
}

function restartSamWhenSafe(status) {
  if (process.env.UNKNOWN_HOME_EULA_POLICY_NO_SAM_RESTART !== "allow-explicit-restart" ||
      process.env.UNKNOWN_HOME_EULA_POLICY_NO_SYSTEMCTL === "1" ||
      !status.samReloadRequired || !fs.existsSync("/bin/systemctl") &&
      !fs.existsSync("/usr/bin/systemctl")) {
    return false;
  }
  const foreground = foregroundAppId();
  if (!SAFE_RELOAD_APP_IDS.has(foreground)) return false;
  const systemctl = fs.existsSync("/bin/systemctl") ? "/bin/systemctl" : "/usr/bin/systemctl";
  const restarted = childProcess.spawnSync(
    systemctl,
    ["restart", "sam.service"],
    { encoding: "utf8", timeout: 20000, maxBuffer: 128 * 1024 }
  );
  return !restarted.error && restarted.status === 0;
}

function systemctlPath() {
  if (process.env.UNKNOWN_HOME_EULA_POLICY_NO_SYSTEMCTL === "1") return "";
  if (fs.existsSync("/bin/systemctl")) return "/bin/systemctl";
  if (fs.existsSync("/usr/bin/systemctl")) return "/usr/bin/systemctl";
  return "";
}

function runSystemctl(args, allowFailure) {
  const systemctl = systemctlPath();
  if (!systemctl) return { skipped: true };
  const result = childProcess.spawnSync(systemctl, args, {
    encoding: "utf8",
    timeout: 20000,
    maxBuffer: 128 * 1024
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(String(result.stderr || (result.error && result.error.message) ||
      "systemctl failed").trim());
  }
  return result;
}

function installRuntimeUnit() {
  verifyRuntimeUnitOwnership();
  const unitChanged = writeIfChanged(POLICY_UNIT_FILE, POLICY_UNIT, { mode: 0o644 });
  const dropinChanged = writeIfChanged(SAM_DROPIN_FILE, SAM_DROPIN, { mode: 0o644 });
  if (unitChanged || dropinChanged) runSystemctl(["daemon-reload"], false);
  const active = runSystemctl(["is-active", "--quiet", POLICY_UNIT_NAME], true);
  if (!active.skipped && active.status !== 0) {
    runSystemctl(["start", POLICY_UNIT_NAME], false);
  }
  return {
    runtimeUnitInstalled: fs.existsSync(POLICY_UNIT_FILE) && fs.existsSync(SAM_DROPIN_FILE),
    runtimeUnitChanged: unitChanged || dropinChanged
  };
}

function removeRuntimeUnit() {
  verifyRuntimeUnitOwnership();
  runSystemctl(["stop", POLICY_UNIT_NAME], true);
  let changed = false;
  [SAM_DROPIN_FILE, POLICY_UNIT_FILE].forEach((file) => {
    try {
      fs.unlinkSync(file);
      changed = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  });
  try {
    fs.rmdirSync(SAM_DROPIN_DIR);
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
  }
  if (changed) runSystemctl(["daemon-reload"], true);
  return { runtimeUnitInstalled: false, runtimeUnitChanged: changed };
}

function verifyRuntimeUnitOwnership() {
  const prior=POLICY_UNIT.replace(__filename,"/var/lib/unknown-home/unknown-home-eula-launch-policy.js");
  for(const [file,allowed] of [[POLICY_UNIT_FILE,[POLICY_UNIT,prior]],[SAM_DROPIN_FILE,[SAM_DROPIN]]]){
    if(!fs.existsSync(file))continue;
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||!allowed.includes(fs.readFileSync(file,"utf8")))throw Error("Runtime unit was changed outside this module; leaving it untouched");
  }
}

function requireRoot() {
  if (process.env.UNKNOWN_HOME_EULA_POLICY_ALLOW_NON_ROOT === "1") return;
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    throw new Error("root is required");
  }
}

function main() {
  requireRoot();
  const command = process.argv[2] || "status";
  let operation = {};
  if (command === "apply") {
    operation = applyPolicy();
  } else if (command === "apply-enabled") {
    if (fs.existsSync(ENABLED_FILE)) operation = applyPolicy();
  } else if (command === "restore") {
    operation = restorePolicy();
  } else if (command === "install-runtime-unit") {
    operation = installRuntimeUnit();
  } else if (command === "remove-runtime-unit") {
    operation = removeRuntimeUnit();
  } else if (command !== "status" && command !== "reconcile-safe") {
    throw new Error("unsupported command");
  }

  if (command === "reconcile-safe") {
    operation = fs.existsSync(ENABLED_FILE) ? applyPolicy() : restorePolicy();
  }
  const checkSam = command !== "apply-enabled" && command !== "install-runtime-unit" &&
    command !== "remove-runtime-unit";
  let status = inspectPolicy(checkSam);
  let samReloaded = false;
  if (command === "reconcile-safe") {
    samReloaded = restartSamWhenSafe(status);
    if (samReloaded) status = inspectPolicy(true);
  }
  process.stdout.write(JSON.stringify(Object.assign({}, status, operation, {
    samReloaded: samReloaded
  })) + "\n");
  if (command !== "apply-enabled" && operation.errors && operation.errors.length) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(String(error && error.stack ? error.stack : error) + "\n");
  process.exit(1);
}
