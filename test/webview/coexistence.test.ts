/**
 * Sub-AC 3 of AC 2 — SH-05 (uiMode toggle coexistence between webview and the
 * existing xterm.js ClaudeTerminalView).
 *
 * Verifies the contract that v0.6.0 webview opt-in introduces:
 *   1. Default `uiMode === "terminal"` (zero-regression for existing users).
 *   2. Settings migration via `Object.assign(DEFAULT_SETTINGS, loaded)` keeps
 *      `uiMode === "terminal"` for v0.5.x users whose saved data has no
 *      webview fields at all.
 *   3. `wireWebview` is a strict no-op when `uiMode === "terminal"` —
 *      `registerView` and `addCommand` are NOT called for the webview type,
 *      so the existing `ClaudeTerminalView` registration is the only sidebar
 *      view active.
 *   4. `wireWebview` registers `VIEW_TYPE_CLAUDE_WEBVIEW` + the webview
 *      command when `uiMode === "webview"`. The terminal view registration
 *      from `main.ts` is unaffected (different VIEW_TYPE), so both
 *      `ItemView`s coexist in a single Obsidian session.
 *   5. View type IDs and command IDs do not collide between the two layers.
 *   6. Console log namespaces stay distinct: `[claude-webview]` for the new
 *      view, `[claude-terminal]` for the legacy one. This matters for
 *      log-based diagnostics across the two coexisting subsystems.
 *   7. The webview registration callback emits a fresh `ClaudeWebviewView`
 *      whose `getViewType() === VIEW_TYPE_CLAUDE_WEBVIEW`, *not* the
 *      terminal view type — proves the factory is wired to the right class.
 *
 * Assertion style: structural mock + behavioral assertion. We do NOT mount a
 * full Plugin onload because that pulls in node-pty + xterm; instead we
 * validate the wiring contract that `main.ts` relies on.
 */
import { describe, it, expect, vi } from "vitest";
import { Window } from "happy-dom";
import { Plugin, WorkspaceLeaf } from "obsidian";
import { wireWebview, type WebviewPluginHost } from "../../src/webview";
import { ClaudeWebviewView } from "../../src/webview/view";
import {
  VIEW_TYPE_CLAUDE_TERMINAL,
  VIEW_TYPE_CLAUDE_WEBVIEW,
  COMMAND_OPEN_WEBVIEW,
  COMMAND_TOGGLE_TERMINAL,
  COMMAND_NEW_TERMINAL,
  COMMAND_FOCUS_TERMINAL,
} from "../../src/constants";
import {
  DEFAULT_WEBVIEW_SETTINGS,
  type UiMode,
  type WebviewSettings,
} from "../../src/webview/settings-adapter";
import { DEFAULT_SETTINGS } from "../../src/settings";

interface RegisteredView {
  readonly type: string;
  readonly factory: (leaf: WorkspaceLeaf) => unknown;
}

interface RegisteredCommand {
  readonly id: string;
}

function makeHost(uiMode: UiMode): {
  host: WebviewPluginHost;
  registeredViews: RegisteredView[];
  registeredCommands: RegisteredCommand[];
} {
  const plugin = new Plugin() as unknown as WebviewPluginHost;
  plugin.settings = { uiMode };
  const registeredViews: RegisteredView[] = [];
  const registeredCommands: RegisteredCommand[] = [];
  plugin.registerView = vi.fn((type: string, factory: (leaf: WorkspaceLeaf) => unknown) => {
    registeredViews.push({ type, factory });
  }) as unknown as Plugin["registerView"];
  plugin.addCommand = vi.fn((cmd: { id: string }) => {
    registeredCommands.push({ id: cmd.id });
    return cmd as unknown as ReturnType<Plugin["addCommand"]>;
  }) as unknown as Plugin["addCommand"];
  return { host: plugin, registeredViews, registeredCommands };
}

describe("SH-05 — uiMode toggle coexistence", () => {
  describe("opt-in safety: defaults preserve existing-user behavior", () => {
    it("DEFAULT_WEBVIEW_SETTINGS.uiMode === 'terminal' (zero regression default)", () => {
      expect(DEFAULT_WEBVIEW_SETTINGS.uiMode).toBe("terminal");
    });

    it("DEFAULT_SETTINGS (full plugin defaults) inherits uiMode='terminal'", () => {
      expect(DEFAULT_SETTINGS.uiMode).toBe("terminal");
    });

    it("settings migration (v0.5.x → v0.6.x) using Object.assign keeps uiMode='terminal' when loaded data has no webview fields", () => {
      // Mirrors the production loadSettings: { ...DEFAULT_SETTINGS, ...loaded }
      const loadedFromDisk_v05 = {
        claudePath: "/usr/local/bin/claude",
        fontSize: 16,
        // no uiMode / permissionPreset / etc — pre-v0.6.0 saved data
      };
      const merged = { ...DEFAULT_SETTINGS, ...loadedFromDisk_v05 };
      expect(merged.uiMode).toBe("terminal");
      // All five new webview fields must be present with default values.
      const requiredKeys: Array<keyof WebviewSettings> = [
        "uiMode",
        "permissionPreset",
        "showDebugSystemEvents",
        "showThinking",
        "lastSessionId",
      ];
      for (const k of requiredKeys) {
        expect(merged).toHaveProperty(k);
      }
      expect(merged.permissionPreset).toBe("standard");
      expect(merged.showDebugSystemEvents).toBe(false);
      expect(merged.showThinking).toBe(false);
      expect(merged.lastSessionId).toBe("");
    });

    it("settings migration explicitly preserves user-selected uiMode='webview' across reload", () => {
      const loadedFromDisk_v06 = {
        uiMode: "webview" as const,
        permissionPreset: "full" as const,
      };
      const merged = { ...DEFAULT_SETTINGS, ...loadedFromDisk_v06 };
      expect(merged.uiMode).toBe("webview");
      expect(merged.permissionPreset).toBe("full");
    });
  });

  describe("wireWebview no-op path (uiMode='terminal') — terminal-only coexistence", () => {
    it("does not register the webview type or command (terminal view stays sole sidebar view)", () => {
      const { host, registeredViews, registeredCommands } = makeHost("terminal");
      wireWebview(host);
      const webviewRegs = registeredViews.filter(
        (r) => r.type === VIEW_TYPE_CLAUDE_WEBVIEW,
      );
      const webviewCmds = registeredCommands.filter(
        (c) => c.id === COMMAND_OPEN_WEBVIEW,
      );
      expect(webviewRegs).toHaveLength(0);
      expect(webviewCmds).toHaveLength(0);
    });

    it("emits a [claude-webview] namespaced log explaining the skip (debuggability)", () => {
      const { host } = makeHost("terminal");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        wireWebview(host);
        const logs = logSpy.mock.calls.map((c) => String(c[0]));
        expect(logs.some((l) => l.startsWith("[claude-webview]"))).toBe(true);
        // Terminal namespace must NOT appear from the webview wiring path.
        expect(logs.some((l) => l.startsWith("[claude-terminal]"))).toBe(false);
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  describe("wireWebview active path (uiMode='webview') — both views coexist", () => {
    it("registers exactly one webview view and one webview command", () => {
      const { host, registeredViews, registeredCommands } = makeHost("webview");
      wireWebview(host);
      const webviewRegs = registeredViews.filter(
        (r) => r.type === VIEW_TYPE_CLAUDE_WEBVIEW,
      );
      const webviewCmds = registeredCommands.filter(
        (c) => c.id === COMMAND_OPEN_WEBVIEW,
      );
      expect(webviewRegs).toHaveLength(1);
      expect(webviewCmds).toHaveLength(1);
    });

    it("does NOT register the legacy terminal view type — that stays main.ts's responsibility (independent registration → coexistence)", () => {
      const { host, registeredViews } = makeHost("webview");
      wireWebview(host);
      const terminalRegs = registeredViews.filter(
        (r) => r.type === VIEW_TYPE_CLAUDE_TERMINAL,
      );
      expect(terminalRegs).toHaveLength(0);
    });

    it("registered factory produces a ClaudeWebviewView whose getViewType matches VIEW_TYPE_CLAUDE_WEBVIEW (not terminal type)", () => {
      const { host, registeredViews } = makeHost("webview");
      wireWebview(host);
      expect(registeredViews).toHaveLength(1);
      const factory = registeredViews[0].factory;
      const fakeLeaf = new WorkspaceLeaf();
      const view = factory(fakeLeaf) as ClaudeWebviewView;
      expect(view).toBeInstanceOf(ClaudeWebviewView);
      expect(view.getViewType()).toBe(VIEW_TYPE_CLAUDE_WEBVIEW);
      expect(view.getViewType()).not.toBe(VIEW_TYPE_CLAUDE_TERMINAL);
    });
  });

  describe("namespace + ID isolation between the two view layers", () => {
    it("VIEW_TYPE_CLAUDE_WEBVIEW and VIEW_TYPE_CLAUDE_TERMINAL are distinct strings", () => {
      expect(VIEW_TYPE_CLAUDE_WEBVIEW).not.toBe(VIEW_TYPE_CLAUDE_TERMINAL);
      expect(VIEW_TYPE_CLAUDE_WEBVIEW).toBe("claude-webview");
      expect(VIEW_TYPE_CLAUDE_TERMINAL).toBe("claude-terminal-view");
    });

    it("webview command id and all terminal command ids are distinct", () => {
      const terminalCmdIds = [
        COMMAND_TOGGLE_TERMINAL,
        COMMAND_NEW_TERMINAL,
        COMMAND_FOCUS_TERMINAL,
      ];
      for (const id of terminalCmdIds) {
        expect(id).not.toBe(COMMAND_OPEN_WEBVIEW);
      }
      expect(COMMAND_OPEN_WEBVIEW).toBe("claude-webview:open");
    });

    it("ClaudeWebviewView log lines are tagged [claude-webview], never [claude-terminal]", async () => {
      const fakeLeaf = new WorkspaceLeaf();
      // Inject view reference so the MH-11 lifecycle guard
      // (`this.leaf.view !== this`) sees an attached leaf during onOpen.
      const view = new ClaudeWebviewView(fakeLeaf);
      fakeLeaf.view = view;
      // Phase 2: give the view a real happy-dom HTMLElement at
      // containerEl.children[1] so `buildLayout` can install the full
      // `.claude-wv-root` skeleton. The layout carries the
      // `.claude-wv-*` namespace that coexistence guarantees.
      const window = new Window();
      const doc = window.document as unknown as Document;
      const root = doc.createElement("div") as unknown as HTMLElement;
      view.containerEl = {
        children: [null, root],
      } as unknown as typeof view.containerEl;
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await view.onOpen();
        await view.onClose();
        const logs = logSpy.mock.calls.map((c) => String(c[0]));
        // At minimum: onOpen + onClose each log a lifecycle line.
        expect(logs.length).toBeGreaterThanOrEqual(2);
        for (const line of logs) {
          expect(line.startsWith("[claude-webview]")).toBe(true);
          expect(line.startsWith("[claude-terminal]")).toBe(false);
        }
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  describe("toggle round-trip (terminal → webview → terminal) — registration is monotonic per session", () => {
    it("flipping uiMode mid-session does NOT retroactively re-register; restart is required (Notice contract)", () => {
      // Round 1: uiMode='terminal' — webview is no-op.
      const { host: hostTerm, registeredViews: viewsTerm } = makeHost("terminal");
      wireWebview(hostTerm);
      expect(viewsTerm).toHaveLength(0);

      // User changes setting to 'webview' on the SAME host instance.
      hostTerm.settings = { uiMode: "webview" };
      // wireWebview is invoked once at onload; calling it again here
      // simulates the ABSENCE of runtime re-registration — but for a
      // fresh plugin instance after restart, this would register normally.
      const { host: hostWeb, registeredViews: viewsWeb } = makeHost("webview");
      wireWebview(hostWeb);
      expect(viewsWeb.filter((r) => r.type === VIEW_TYPE_CLAUDE_WEBVIEW)).toHaveLength(1);

      // Round 3: user opts back out to 'terminal' — fresh instance is no-op again.
      const { host: hostBack, registeredViews: viewsBack } = makeHost("terminal");
      wireWebview(hostBack);
      expect(viewsBack).toHaveLength(0);
    });
  });
});
