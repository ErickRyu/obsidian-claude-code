import type { Plugin } from "obsidian";
import { VIEW_TYPE_CLAUDE_WEBVIEW, COMMAND_OPEN_WEBVIEW } from "../constants";
import { ClaudeWebviewView } from "./view";

/**
 * Minimal plugin surface wireWebview needs. Using a structural type keeps
 * `webview/index.ts` import-free of the concrete plugin class so unit tests
 * can drive this entry point with a mock Plugin from `obsidian`.
 */
export interface WebviewPluginHost extends Plugin {
  settings: {
    uiMode: "terminal" | "webview";
  };
}

/**
 * Phase 0 contract:
 *
 * - Invoked unconditionally from `main.ts` onload AFTER settings load.
 * - Registers the ItemView + opener command **only when** `uiMode === "webview"`.
 *   The `uiMode === "terminal"` branch is a no-op so existing users see zero change.
 * - Setting change to `uiMode` requires a restart (Obsidian lifecycle — we surface
 *   a Notice in `settings.ts` rather than re-register at runtime, because
 *   `registerView` cannot be undone without unloading the plugin).
 */
export function wireWebview(plugin: WebviewPluginHost): void {
  if (plugin.settings.uiMode !== "webview") {
    // eslint-disable-next-line no-console
    console.log("[claude-webview] uiMode=terminal, skipping webview registration");
    return;
  }

  // eslint-disable-next-line no-console
  console.log("[claude-webview] wiring ItemView + command");

  plugin.registerView(VIEW_TYPE_CLAUDE_WEBVIEW, (leaf) => new ClaudeWebviewView(leaf));

  plugin.addCommand({
    id: COMMAND_OPEN_WEBVIEW,
    name: "Open Claude Webview",
    callback: async () => {
      const workspace = plugin.app.workspace;
      const existing = workspace.getLeavesOfType(VIEW_TYPE_CLAUDE_WEBVIEW);
      if (existing.length > 0) {
        workspace.revealLeaf(existing[0]);
        return;
      }
      const leaf = workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({
        type: VIEW_TYPE_CLAUDE_WEBVIEW,
        active: true,
      });
      workspace.revealLeaf(leaf);
    },
  });
}
