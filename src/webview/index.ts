import { spawn as nodeSpawn } from "node:child_process";
import { Notice, type Plugin } from "obsidian";
import {
  VIEW_TYPE_CLAUDE_WEBVIEW,
  COMMAND_OPEN_WEBVIEW,
  COMMAND_RESUME_WEBVIEW,
} from "../constants";
import {
  ClaudeWebviewView,
  type WebviewViewRuntime,
  type WebviewMutableSettings,
} from "./view";
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
    showDebugSystemEvents: boolean;
    lastSessionId: string;
  };
  saveSettings(): Promise<void>;
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
 *   `child_process.spawn` + a live-backed settings object. `permissionPreset`
 *   is mutated in place by the Phase 4b permission dropdown and persisted
 *   back to `plugin.settings` via the `persistSettings` closure, so the
 *   next `SessionController.start()` on the same leaf picks it up.
 *   `claudePath` and `extraArgs` are refreshed from `plugin.settings` every
 *   time the leaf calls `persistSettings`, so a user changing either field
 *   in the settings panel and then exercising the dropdown sees the new
 *   value on the next spawn. A leaf that never exercises the dropdown
 *   after a settings edit keeps the snapshot it was created with until the
 *   leaf is closed and reopened — accepted gap for the Beta (Phase 5a's
 *   status bar refresh will tighten this by broadcasting the changes).
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

  // Phase 5a — one-shot resume flag. The resume command flips this to
  // `true` right before `setViewState` triggers the factory; the factory
  // consumes and resets it so a later regular-open on the same leaf does
  // NOT accidentally resume. The flag is per-`wireWebview` closure, so
  // each plugin instance has its own scope (no global leak).
  let pendingResumeOnce = false;

  plugin.registerView(VIEW_TYPE_CLAUDE_WEBVIEW, (leaf) => {
    const view = new ClaudeWebviewView(leaf);
    const resumeOnStart = pendingResumeOnce;
    pendingResumeOnce = false;
    // Shared mutable settings reference. The permission dropdown (Phase 4b)
    // mutates `permissionPreset` on user change and calls `persistSettings`;
    // the next `SessionController.start()` reads the same object via
    // `buildSpawnArgs(settings)`. `plugin.settings` is the source of truth —
    // the object below is seeded once at `registerView` factory time and
    // the `persistSettings` closure (a) refreshes `claudePath` / `extraArgs`
    // from the plugin-level settings so a user edit is picked up on the next
    // dropdown-driven spawn, and (b) copies `permissionPreset` back to the
    // plugin so `data.json` reflects the user's choice.
    const runtimeSettings: WebviewMutableSettings = {
      claudePath: plugin.settings.claudePath,
      permissionPreset: plugin.settings.permissionPreset,
      extraArgs: plugin.settings.extraArgs,
      lastSessionId: plugin.settings.lastSessionId,
    };
    const runtime: WebviewViewRuntime = {
      spawnImpl: nodeSpawn,
      settings: runtimeSettings,
      resumeOnStart,
      // `renderOptions` is a closure over `plugin.settings` rather than a
      // snapshot — each dispatch reads the most recent saved value, so a
      // user toggling "Show Thinking" or "Show debug system events" in the
      // settings panel takes effect on the next streamed event without
      // recreating the leaf.
      renderOptions: () => ({
        showThinking: plugin.settings.showThinking,
        showDebugSystemEvents: plugin.settings.showDebugSystemEvents,
      }),
      persistSettings: async () => {
        plugin.settings.permissionPreset = runtimeSettings.permissionPreset;
        // Phase 5a — mirror lastSessionId back to plugin.settings so the
        // resume command (which reads `plugin.settings.lastSessionId`) and
        // data.json both reflect whatever the SessionController captured
        // from the most recent `result` event.
        plugin.settings.lastSessionId = runtimeSettings.lastSessionId;
        // Refresh the read-only fields from plugin.settings so a user who
        // edited claudePath / extraArgs and then toggled the preset sees
        // the binary-path / extra-args update on the next spawn as well.
        // TypeScript sees the fields as readonly; the underlying object is
        // the same reference the session controller will re-read on its
        // next start, so we bypass the compile-time annotation with a
        // locally scoped mutable alias instead of a cast.
        const mutable = runtimeSettings as {
          claudePath: string;
          extraArgs: string;
          permissionPreset: PermissionPreset;
          lastSessionId: string;
        };
        mutable.claudePath = plugin.settings.claudePath;
        mutable.extraArgs = plugin.settings.extraArgs;
        await plugin.saveSettings();
      },
    };
    view.runtime = runtime;
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

  // Phase 5a — "Open Claude Webview (resume last)". Uses
  // `plugin.settings.lastSessionId`, which the session controller writes via
  // `onSessionId` on every successful turn. When empty, short-circuit with
  // a Notice so the user understands why nothing happened (no silent no-op).
  plugin.addCommand({
    id: COMMAND_RESUME_WEBVIEW,
    name: "Open Claude Webview (resume last)",
    callback: async () => {
      const sid = plugin.settings.lastSessionId;
      if (!sid || sid.length === 0) {
        new Notice(
          "No previous Claude Webview session to resume. Run a session first.",
        );
        return;
      }
      const workspace = plugin.app.workspace;
      // Unlike the open command, always spin up a fresh leaf — resuming into
      // an existing leaf would skip `registerView` factory (and its runtime
      // seeding with `lastSessionId`). The user's expectation matches a
      // "new tab pointed at the old session" UX.
      const leaf = workspace.getRightLeaf(false);
      if (!leaf) return;
      // One-shot: the next factory call (triggered by setViewState)
      // reads+clears this flag, so the view's onOpen knows to call
      // `controller.start(undefined, settings.lastSessionId)`. A later
      // open of a different leaf on the same plugin instance does NOT
      // resume unless this command is invoked again.
      pendingResumeOnce = true;
      try {
        await leaf.setViewState({
          type: VIEW_TYPE_CLAUDE_WEBVIEW,
          active: true,
        });
      } finally {
        // Defensive reset — a thrown setViewState must not leave the
        // flag set for the next spurious factory invocation. The factory
        // itself also resets on read, so this is belt-and-suspenders.
        pendingResumeOnce = false;
      }
      workspace.revealLeaf(leaf);
    },
  });
}
