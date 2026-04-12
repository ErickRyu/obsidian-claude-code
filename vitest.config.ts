import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
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
