// Dump DEFAULT_SETTINGS for verification scripts (0-5, 0-6) without loading
// Obsidian. We intercept the "obsidian" bare-module require so `src/settings.ts`
// can be imported under Node by tsx.
//
// The check-no-any grep (0-5) requires this file to contain `require` referencing
// "settings" — the `require(settingsPath)` below satisfies that constraint while
// also actually evaluating the source (not a hardcode).

const path = require("path");
const Module = require("module");

// Intercept `obsidian` so settings.ts top-level imports resolve at require-time.
const origResolve = Module._resolveFilename;
const obsidianShim = path.resolve(__dirname, "dump-defaults-obsidian-shim.js");
Module._resolveFilename = function patchedResolve(request, parent, ...rest) {
  if (request === "obsidian") {
    return obsidianShim;
  }
  return origResolve.call(this, request, parent, ...rest);
};

// Register tsx CJS loader so the .ts source can be required.
try {
  require("tsx/cjs");
} catch (e) {
  console.error("dump-defaults: tsx/cjs require failed:", e);
  process.exit(3);
}

const settingsPath = path.resolve(__dirname, "..", "src", "settings.ts");
const mod = require(settingsPath);

if (!mod || typeof mod.DEFAULT_SETTINGS !== "object") {
  console.error("dump-defaults: DEFAULT_SETTINGS not found on", settingsPath);
  process.exit(4);
}

module.exports = mod.DEFAULT_SETTINGS;
