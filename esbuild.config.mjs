import esbuild from "esbuild";
import process from "process";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const prod = process.argv[2] === "production";

// Build-time identity: pulled from manifest.json (canonical version) +
// `git rev-parse --short HEAD` (commit at build time) + ISO timestamp.
// Surfaced in the webview header so dogfood users can see at a glance
// whether the loaded plugin matches the latest build (Cmd+R confirmation).
const manifest = JSON.parse(readFileSync("./manifest.json", "utf8"));
let gitShort = "nogit";
try {
  gitShort = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
} catch {
  // Standalone build (no git) — keep "nogit" sentinel.
}
const buildIso = new Date().toISOString();
console.log(
  `[esbuild] building obsidian-claude-code v${manifest.version} ` +
    `(${gitShort}, ${buildIso}) prod=${prod}`,
);

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    "node-pty",
  ],
  format: "cjs",
  target: "es2021",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
  platform: "node",
  define: {
    __PLUGIN_VERSION__: JSON.stringify(manifest.version),
    __PLUGIN_GIT_SHORT__: JSON.stringify(gitShort),
    __PLUGIN_BUILD_ISO__: JSON.stringify(buildIso),
  },
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
