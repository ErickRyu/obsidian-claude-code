import { spawn as nodeSpawn } from "node:child_process";
import { MarkdownRenderer, Notice, type Plugin } from "obsidian";
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
import { SessionArchive } from "./session/session-archive";
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
    /**
     * B1-NEW (2026-04-29) — cwdOverride is the optional absolute path the
     * user pinned in settings as the working directory for `claude -p`.
     * Empty string means "use vault root" (the natural default for an
     * Obsidian-embedded plugin). Mirrors the v0.5.x terminal-mode field.
     */
    cwdOverride: string;
    /**
     * B1-NEW (2026-04-29) — when true (v0.5.x default), every webview
     * spawn carries `--mcp-config <path>` so claude -p loads the
     * `obsidian-context` MCP server (active note / open notes / vault
     * search). Toggling at runtime requires a fresh leaf — the existing
     * child's argv was snapshotted at spawn.
     */
    enableMcp: boolean;
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
/**
 * Options wireWebview accepts beyond the plugin host itself. Kept narrow
 * so a test harness can opt out of the archive (the orthogonal Phase 3
 * lifecycle gates don't care about SH-07).
 */
export interface WireWebviewOptions {
  /**
   * Absolute directory under which the SessionArchive writes
   * `<session_id>.jsonl` files. Production wiring (main.ts) passes
   * `<pluginDir>/archives`. When `undefined`, no archive is wired and
   * resume fallback (SH-07) is a no-op — the CLI's own `--resume`
   * semantics remain the only recovery path.
   */
  readonly archiveBaseDir?: string;
  /**
   * B1-NEW (2026-04-29) Workspace Awareness — closure that returns the
   * vault root absolute path (matches v0.5.x terminal-view wiring at
   * `src/main.ts:64`). Re-evaluated per-leaf factory so a vault rename
   * or remount picks up the latest path on the next "Open Claude
   * Webview". Return null when the adapter is non-desktop or unknown.
   */
  readonly getVaultBasePath?: () => string | null;
  /**
   * B1-NEW — closure returning the absolute `.mcp.json` path that the
   * plugin's McpContextBridge wrote (or null when `enableMcp=false` or
   * setup failed). The path is resolved as `path.join(cwd, ".mcp.json")`
   * inside the bridge; main.ts can compute it from the same cwd it used
   * for `mcpBridge.writeMcpConfig(cwd)`.
   */
  readonly getMcpConfigPath?: () => string | null;
  /**
   * B1-NEW — closure returning the absolute `obsidian-prompt.txt` path
   * the SystemPromptWriter owns. Same accessor pattern as terminal-view
   * (`src/main.ts:66 () => this.promptWriter?.getPromptFilePath()`).
   */
  readonly getSystemPromptFilePath?: () => string | null;
}

export function wireWebview(
  plugin: WebviewPluginHost,
  options: WireWebviewOptions = {},
): void {
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

  // Phase 5b — one SessionArchive instance per plugin load. Shared across
  // every leaf so archived turns for the same session_id accumulate into
  // the same `<baseDir>/<session_id>.jsonl` file. A leaf that opens with
  // `resumeOnStart=true` and hits a CLI-side resume failure can then
  // `archive.load(lastSessionId)` the JSONL back and replay.
  const archive =
    options.archiveBaseDir !== undefined && options.archiveBaseDir.length > 0
      ? new SessionArchive({ baseDir: options.archiveBaseDir })
      : undefined;

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
    // B1-NEW (2026-04-29) Workspace Awareness — resolve cwd, mcp config,
    // and system prompt path from the wireWebview options so each fresh
    // leaf picks up the latest settings + plugin state. Mirrors v0.5.x
    // terminal-view wiring (src/main.ts:64-66) so webview matches
    // terminal's "knows it's running inside Obsidian" UX.
    const vaultBase = options.getVaultBasePath?.() ?? null;
    const cwd =
      plugin.settings.cwdOverride.length > 0
        ? plugin.settings.cwdOverride
        : vaultBase ?? undefined;
    const mcpConfigPath = plugin.settings.enableMcp
      ? options.getMcpConfigPath?.() ?? undefined
      : undefined;
    const systemPromptPath = options.getSystemPromptFilePath?.() ?? undefined;

    // 2026-04-29 dogfood — Claude responses are markdown. Forward an
    // Obsidian-aware renderer so headings/lists/`**bold**`/`[[wikilink]]`
    // resolve correctly inside the host vault. The view itself doubles
    // as the parent `Component` so child renderers (callouts, embeds)
    // unmount when the leaf closes. `void` because we don't await — a
    // failed render leaves an empty block, and the next message will
    // try again.
    const renderMarkdown = (text: string, el: HTMLElement): void => {
      void MarkdownRenderer.render(plugin.app, text, el, "", view);
    };
    const runtime: WebviewViewRuntime = {
      spawnImpl: nodeSpawn,
      settings: runtimeSettings,
      resumeOnStart,
      archive,
      cwd,
      mcpConfigPath,
      systemPromptPath,
      renderMarkdown,
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
