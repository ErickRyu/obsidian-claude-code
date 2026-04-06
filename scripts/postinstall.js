const { execSync } = require("child_process");
const path = require("path");

// Detect Obsidian's Electron version
// Default to a known compatible version if detection fails
const DEFAULT_ELECTRON_VERSION = "34.2.0";

let electronVersion = DEFAULT_ELECTRON_VERSION;

try {
  // Try to detect from running Obsidian process
  const result = execSync(
    "ps aux | grep -i obsidian | grep -v grep | head -1",
    { encoding: "utf-8" }
  );
  if (result.trim()) {
    console.log("Obsidian process detected, using default Electron version");
  }
} catch {
  // Ignore detection failures
}

console.log(`Rebuilding node-pty for Electron ${electronVersion}...`);

try {
  execSync(
    `npx @electron/rebuild -v ${electronVersion} -m ${path.resolve(__dirname, "..")} -o node-pty`,
    { stdio: "inherit" }
  );
  console.log("node-pty rebuilt successfully!");
} catch (error) {
  console.error("Failed to rebuild node-pty:", error.message);
  console.error(
    "You may need to install build tools: xcode-select --install (macOS)"
  );
  process.exit(1);
}
