import { spawn as nodeSpawn } from "node:child_process";
import type { Plugin } from "obsidian";
import { VIEW_TYPE_CLAUDE_WEBVIEW, COMMAND_OPEN_WEBVIEW } from "../constants";
import { ClaudeWebviewView, type WebviewViewRuntime } from "./view";
import { disposeAllSessionControllers } from "./session/session-controller";
import type { PermissionPreset } from "./settings-adapter";

/**
 * Minimal plugin surface wireWebview needs. Using a structural type keeps
 * `webview/index.ts` import-free of the concrete plugin class so unit tests
 * can drive this entry point with a mock Plugin from `obsidian`.
 */
export interface WebviewPluginHost extends Plugin {
  settings: {
    uiMode: "terminal" | "webview";
    claudePath: string;
    permissionPreset: PermissionPreset;
    extraArgs: string;
    showThinking: boolean;
  };
}

/**
 * Phase 0 + 3 contract:
 *
 * - Invoked unconditionally from `main.ts` onload AFTER settings load.
 * - Registers the ItemView + opener command **only when** `uiMode === "webview"`.
 *   The `uiMode === "terminal"` branch is a no-op so existing users see zero change.
 * - Setting change to `uiMode` requires a restart (Obsidian lifecycle — we surface
 *   a Notice in `settings.ts` rather than re-register at runtime, because
 *   `registerView` cannot be undone without unloading the plugin).
 * - Every ItemView instance is seeded with a `WebviewViewRuntime` carrying
 *   `child_process.spawn` + a settings snapshot so `onOpen` creates a real
 *   SessionController against the CLI.  The snapshot is taken at
 *   `registerView` factory time (per-leaf creation), so a preset change is
 *   picked up by any NEW webview leaf — leaves reused across close/reopen
 *   cycles keep their original snapshot until the next full registration.
 *   Phase 4b will plumb live settings through the bus to close that gap.
 * - `plugin.register(disposeAllSessionControllers)` drains any live child
 *   processes at unload — orphan defense when Obsidian skips `onClose`
 *   (plugin disable / vault reload / crash).
 */
export function wireWebview(plugin: WebviewPluginHost): void {
  if (plugin.settings.uiMode !== "webview") {
    // eslint-disable-next-line no-console
    console.log("[claude-webview] uiMode=terminal, skipping webview registration");
    return;
  }

  // eslint-disable-next-line no-console
  console.log("[claude-webview] wiring ItemView + command");

  plugin.register(() => {
    disposeAllSessionControllers();
  });

  plugin.registerView(VIEW_TYPE_CLAUDE_WEBVIEW, (leaf) => {
    const view = new ClaudeWebviewView(leaf);
    // `renderOptions` is a closure over `plugin.settings` rather than a
    // snapshot — each dispatch reads the most recent saved value, so a user
    // toggling "Show Thinking" in the settings panel takes effect on the
    // next streamed event without recreating the leaf. The JSDoc on
    // `WebviewViewRuntime.renderOptions` is the contract this satisfies.
    const runtime: WebviewViewRuntime = {
      spawnImpl: nodeSpawn,
      settings: {
        claudePath: plugin.settings.claudePath,
        permissionPreset: plugin.settings.permissionPreset,
        extraArgs: plugin.settings.extraArgs,
      },
      renderOptions: () => ({
        showThinking: plugin.settings.showThinking,
      }),
    };
    view.__testHooks = runtime;
    return view;
  });

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
