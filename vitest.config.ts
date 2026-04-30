import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  // Mirror esbuild.config.mjs `define` so the build-info constants
  // (__PLUGIN_VERSION__ / __PLUGIN_GIT_SHORT__ / __PLUGIN_BUILD_ISO__)
  // resolve to literals in vitest just as they do in production builds.
  define: {
    __PLUGIN_VERSION__: JSON.stringify("test"),
    __PLUGIN_GIT_SHORT__: JSON.stringify("testbuild"),
    __PLUGIN_BUILD_ISO__: JSON.stringify("1970-01-01T00:00:00.000Z"),
  },
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["node-pty/**", "node_modules/**"],
  },
  resolve: {
    alias: {
      obsidian: path.resolve(__dirname, "test/__mocks__/obsidian.ts"),
      "@xterm/xterm": path.resolve(__dirname, "test/__mocks__/xterm.ts"),
      "@xterm/addon-fit": path.resolve(__dirname, "test/__mocks__/xterm-fit.ts"),
      "@xterm/addon-web-links": path.resolve(__dirname, "test/__mocks__/xterm-web-links.ts"),
    },
  },
});
