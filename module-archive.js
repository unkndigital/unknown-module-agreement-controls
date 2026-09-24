"use strict";

const crypto = require("crypto");
const yauzl = require("yauzl");
const LIMITS = { archive: 8 * 1024 * 1024, total: 16 * 1024 * 1024, file: 6 * 1024 * 1024, entries: 256, manifest: 65536 };
const ID = /^[a-z][a-z0-9-]{1,47}$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const SHA = /^[a-f0-9]{64}$/;

function digest(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value, allowed, label) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) throw Error("Invalid " + label);
}
function label(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
function safePath(name) {
  if (typeof name !== "string" || name.length > 180 || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(name)) throw Error("Unsafe archive path");
  const parts = name.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || /\.$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw Error("Unsafe archive path");
  return name;
}
function compareVersion(a, b) {
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1; }
  return 0;
}
function validateManifest(value, coreVersion) {
  keys(value, ["schemaVersion", "id", "version", "title", "description", "disableDescription", "publisher", "license", "minCoreVersion", "requiresRoot", "entry", "permissions", "actions", "files", "dependsOn", "updateStrategy"], "module manifest");
  if(value.updateStrategy!==undefined&&(value.updateStrategy!=="enable"||compareVersion(value.minCoreVersion,"0.8.0")<0))throw Error("Live updates require the enable strategy and Core 0.8.0 or newer");
  if (value.schemaVersion !== 1 || typeof value.id !== "string" || !ID.test(value.id) || !VERSION.test(value.version) || !VERSION.test(value.minCoreVersion)) throw Error("Unsupported module identity or schema");
  if (compareVersion(coreVersion, value.minCoreVersion) < 0) throw Error("Module requires a newer core version");
  if (!label(value.title, 80) || !label(value.description, 500) || !label(value.publisher, 120) || !label(value.license, 80)) throw Error("Invalid module description");
  if (value.disableDescription !== undefined && !label(value.disableDescription, 800)) throw Error("Invalid disable description");
  if (value.requiresRoot !== true || value.entry !== "module.js") throw Error("Unsupported module execution contract");
  if(value.dependsOn!==undefined&&(!Array.isArray(value.dependsOn)||value.dependsOn.length>8||new Set(value.dependsOn).size!==value.dependsOn.length||value.dependsOn.some(id=>typeof id!=="string"||!ID.test(id)||id===value.id)))throw Error("Invalid module dependencies");
  if (!Array.isArray(value.permissions) || value.permissions.length < 1 || value.permissions.length > 16 || value.permissions.some(p => !label(p, 160))) throw Error("Module must disclose privileges");
  if (!plain(value.actions) || Object.keys(value.actions).length > 24 || !Object.prototype.hasOwnProperty.call(value.actions, "status")) throw Error("Invalid module actions");
  for (const name of Object.keys(value.actions)) {
    if (!/^[a-z][a-zA-Z0-9]{0,39}$/.test(name) || ["enable", "disable", "reconcile", "constructor", "prototype"].includes(name)) throw Error("Invalid action name");
    const action = value.actions[name];
    keys(action, ["title", "description", "confirmation", "readOnly", "parameters"], "action");
    if (action.description !== undefined && !label(action.description, 800)) throw Error("Invalid action description");
    if (!label(action.title, 100) || typeof action.readOnly !== "boolean" || !plain(action.parameters) || Object.keys(action.parameters).length > 8) throw Error("Invalid action definition");
    for (const parameter of Object.keys(action.parameters)) {
      if (!/^[a-z][a-zA-Z0-9]{0,39}$/.test(parameter) || ["constructor", "prototype"].includes(parameter)) throw Error("Invalid parameter name");
      const rule = action.parameters[parameter];
      keys(rule, ["type", "title", "description", "enum", "enumLabels", "enumDescriptions", "currentValue", "maxLength", "minimum", "maximum"], "parameter schema");
      if (rule.title !== undefined && !label(rule.title, 100)) throw Error("Invalid parameter title");
      if (rule.description !== undefined && !label(rule.description, 800)) throw Error("Invalid parameter description");
      if(rule.currentValue!==undefined){
        const binding=rule.currentValue;
        keys(binding,["path","selector","paths"],"current-value binding");
        const validPath=p=>Array.isArray(p)&&p.length>0&&p.length<=6&&p.every(k=>typeof k==="string"&&/^[a-zA-Z][a-zA-Z0-9]*$/.test(k)&&!["constructor","prototype"].includes(k));
        if(rule.type!=="boolean")throw Error("Current-value bindings require booleans");
        if(binding.path!==undefined){if(!validPath(binding.path)||binding.selector!==undefined||binding.paths!==undefined)throw Error("Invalid current-value path");}
        else{
          const selector=Object.prototype.hasOwnProperty.call(action.parameters,binding.selector)&&action.parameters[binding.selector];
          if(!selector||!Array.isArray(selector.enum)||!plain(binding.paths)||Object.keys(binding.paths).length!==selector.enum.length||selector.enum.some(k=>!Object.prototype.hasOwnProperty.call(binding.paths,k)||!validPath(binding.paths[k])))throw Error("Invalid current-value selector");
        }
      }
      if (!["boolean", "string", "number", "integer"].includes(rule.type)) throw Error("Unsupported parameter type");
      if (rule.type === "string") {
        if (rule.enum !== undefined) {
          if (!Array.isArray(rule.enum) || !rule.enum.length || rule.enum.length > 32 || rule.enum.some(item => !label(item, 100)) || rule.maxLength !== undefined) throw Error("Invalid string enum");
        } else if (!Number.isInteger(rule.maxLength) || rule.maxLength < 1 || rule.maxLength > 2048) throw Error("String parameters require a bounded enum or maximum length");
      } else if (rule.enum !== undefined || rule.maxLength !== undefined) throw Error("Unexpected string constraints");
      for (const field of ["enumLabels", "enumDescriptions"]) {
        if (rule[field] === undefined) continue;
        if (!rule.enum || !plain(rule[field]) || Object.keys(rule[field]).length !== rule.enum.length || rule.enum.some(option => !Object.prototype.hasOwnProperty.call(rule[field], option) || !label(rule[field][option], field === "enumLabels" ? 100 : 800))) throw Error("Invalid enum help");
      }
      if (rule.type === "number" || rule.type === "integer") {
        if (!Number.isFinite(rule.minimum) || !Number.isFinite(rule.maximum) || rule.minimum > rule.maximum || rule.minimum < -1e9 || rule.maximum > 1e9 || rule.type === "integer" && (!Number.isInteger(rule.minimum) || !Number.isInteger(rule.maximum))) throw Error("Numeric parameters require finite bounds");
      } else if (rule.minimum !== undefined || rule.maximum !== undefined) throw Error("Unexpected numeric constraints");
    }
  }
  for(const action of Object.values(value.actions))if(action.confirmation!==undefined){
    const confirmation=action.confirmation;keys(confirmation,["message","when"],"action confirmation");
    if(action.readOnly||!label(confirmation.message,300))throw Error("Invalid action confirmation");
    if(confirmation.when!==undefined){
      if(!plain(confirmation.when)||!Object.keys(confirmation.when).length)throw Error("Invalid confirmation condition");
      for(const key of Object.keys(confirmation.when)){
        if(!Object.prototype.hasOwnProperty.call(action.parameters,key))throw Error("Unknown confirmation parameter");
        validateArguments({actions:{check:{parameters:{[key]:action.parameters[key]}}}},"check",{[key]:confirmation.when[key]});
      }
    }
  }
  if (value.actions.status.readOnly !== true || Object.keys(value.actions.status.parameters).length) throw Error("Status must be read-only with no parameters");
  if(value.actions.health && (value.actions.health.readOnly!==true || Object.keys(value.actions.health.parameters).length))throw Error("Health must be read-only with no parameters");
  if(value.actions.maintenance&&(value.actions.maintenance.readOnly!==false||Object.keys(value.actions.maintenance.parameters).length))throw Error("Maintenance must declare writes and take no parameters");
  if (!plain(value.files) || !Object.keys(value.files).length || Object.keys(value.files).length > LIMITS.entries - 1) throw Error("Invalid file manifest");
  for (const file of Object.keys(value.files)) {
    safePath(file);
    if (file === "module.json" || !SHA.test(value.files[file])) throw Error("Invalid file digest");
  }
  for (const required of ["module.js", "README.md", "LICENSE"]) if (!Object.prototype.hasOwnProperty.call(value.files, required)) throw Error("Required module file missing: " + required);
  return value;
}

function validateArguments(manifest, action, payload) {
  if (!Object.prototype.hasOwnProperty.call(manifest.actions, action)) throw Error("Undeclared module action");
  const parameters = manifest.actions[action].parameters;
  if (!plain(payload) || Object.keys(payload).length !== Object.keys(parameters).length) throw Error("Invalid module arguments");
  for (const name of Object.keys(payload)) {
    if (!Object.prototype.hasOwnProperty.call(parameters, name)) throw Error("Unknown module argument");
    const rule = parameters[name], value = payload[name];
    const type = rule.type === "integer" ? "number" : rule.type;
    if (typeof value !== type || rule.type === "integer" && !Number.isInteger(value) ||
        type === "number" && (!Number.isFinite(value) || value < rule.minimum || value > rule.maximum) ||
        type === "string" && (rule.enum ? !rule.enum.includes(value) : value.length > rule.maxLength || /[\u0000-\u001f\u007f]/.test(value))) throw Error("Invalid module argument: " + name);
  }
  return payload;
}

function inspectArchive(buffer, coreVersion) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > LIMITS.archive) return Promise.reject(Error("Archive size limit exceeded"));
  return new Promise((resolve, reject) => {
    let finished = false, zip, active;
    function fail(error) {
      if (finished) return;
      finished = true;
      if (active) active.destroy();
      if (zip) zip.close();
      reject(error);
    }
    yauzl.fromBuffer(buffer, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, archive) => {
      if (error) { fail(error); return; }
      zip = archive;
      zip.on("error", fail);
      if (zip.entryCount > LIMITS.entries) { fail(Error("Too many archive entries")); return; }
      const files = new Map(), names = new Map(), spellings = new Map();
      let total = 0, count = 0;
      zip.on("entry", entry => {
        if (finished) return;
        try {
          count++;
          if (count > LIMITS.entries || entry.generalPurposeBitFlag & 1) throw Error("Unsupported archive entry");
          if (![0, 8].includes(entry.compressionMethod)) throw Error("Unsupported compression");
          const directory = entry.fileName.endsWith("/");
          const name = safePath(directory ? entry.fileName.slice(0, -1) : entry.fileName);
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (mode !== 0 && mode !== (directory ? 0x4000 : 0x8000)) throw Error("Links and special files are forbidden");
          const canonical = name.toLowerCase();
          const segments = name.split("/");
          for (let i = 1; i <= segments.length; i++) {
            const prefix = segments.slice(0, i).join("/"), folded = prefix.toLowerCase();
            if (spellings.has(folded) && spellings.get(folded) !== prefix) throw Error("Case-colliding archive path");
            spellings.set(folded, prefix);
          }
          if (names.has(canonical)) throw Error("Duplicate or case-colliding archive path");
          for (const [other, isDirectory] of names) {
            if (canonical.startsWith(other + "/") && !isDirectory || other.startsWith(canonical + "/") && !directory) throw Error("File/directory collision");
          }
          names.set(canonical, directory);
          if (directory) {
            if (entry.uncompressedSize !== 0) throw Error("Directory contains data");
            zip.readEntry(); return;
          }
          const cap = ["module.json", "README.md", "LICENSE"].includes(name) ? LIMITS.manifest : LIMITS.file;
          total += entry.uncompressedSize;
          if (entry.uncompressedSize > cap || total > LIMITS.total || entry.uncompressedSize > Math.max(entry.compressedSize, 1) * 200) throw Error("Archive expansion limit exceeded");
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError) { fail(streamError); return; }
            if (finished) { stream.destroy(); return; }
            active = stream;
            const chunks = [];
            let size = 0;
            stream.on("error", fail);
            stream.on("data", bytes => {
              size += bytes.length;
              if (size > cap || size > entry.uncompressedSize) { fail(Error("Expanded file exceeds declared size")); return; }
              chunks.push(bytes);
            });
            stream.on("end", () => {
              if (finished) return;
              if (size !== entry.uncompressedSize) { fail(Error("Expanded file size mismatch")); return; }
              files.set(name, Buffer.concat(chunks, size));
              active = null;
              zip.readEntry();
            });
          });
        } catch (problem) { fail(problem); }
      });
      zip.on("end", () => {
        if (finished) return;
        try {
          if (!files.has("module.json")) throw Error("module.json must be at the archive root");
          const manifest = validateManifest(JSON.parse(files.get("module.json").toString("utf8")), coreVersion);
          if (Object.keys(manifest.files).length !== files.size - 1) throw Error("Undeclared or missing payload files");
          for (const name of Object.keys(manifest.files)) if (!files.has(name) || digest(files.get(name)) !== manifest.files[name]) throw Error("Payload digest mismatch: " + name);
          finished = true;
          resolve({ manifest: manifest, files: files, sha256: digest(buffer), archiveBytes: buffer.length, expandedBytes: total });
        } catch (problem) { fail(problem); }
      });
      zip.readEntry();
    });
  });
}

module.exports = { inspectArchive, validateManifest, validateArguments, digest, safePath, compareVersion, LIMITS, ID, SHA };
