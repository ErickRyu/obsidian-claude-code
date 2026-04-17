import { ItemView, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_CLAUDE_WEBVIEW } from "../constants";
import { buildLayout, type WebviewLayout } from "./ui/layout";
import { createBus, type Bus } from "./event-bus";
import { buildInputBar, type InputBar } from "./ui/input-bar";
import {
  SessionController,
  type SpawnImpl,
} from "./session/session-controller";
import type { SpawnArgsSettings } from "./session/spawn-args";
import type { SessionArchive } from "./session/session-archive";
import type { StreamEvent } from "./parser/types";
import {
  createAssistantTextState,
  renderAssistantText,
  type AssistantTextRenderState,
} from "./renderers/assistant-text";
import {
  createAssistantToolUseState,
  renderAssistantToolUse,
  type AssistantToolUseRenderState,
} from "./renderers/assistant-tool-use";
import {
  createUserToolResultState,
  renderUserToolResult,
  type UserToolResultRenderState,
} from "./renderers/user-tool-result";
import {
  createResultState,
  renderResult,
  type ResultRenderState,
} from "./renderers/result";
import {
  createSystemInitState,
  renderSystemInit,
  type SystemInitRenderState,
} from "./renderers/system-init";
import {
  createAssistantThinkingState,
  renderAssistantThinking,
  type AssistantThinkingRenderState,
} from "./renderers/assistant-thinking";
import {
  createEditDiffState,
  renderEditDiff,
  type EditDiffRenderState,
} from "./renderers/edit-diff";
import {
  createTodoPanelState,
  renderTodoPanel,
  type TodoPanelRenderState,
} from "./renderers/todo-panel";
import {
  createSystemStatusState,
  renderSystemStatus,
  createSystemHookState,
  renderSystemHook,
  type SystemStatusRenderState,
  type SystemHookRenderState,
} from "./renderers/system-status";
import {
  createCompactBoundaryState,
  renderCompactBoundary,
  type CompactBoundaryRenderState,
} from "./renderers/compact-boundary";
import {
  buildStatusBar,
  type StatusBarHandle,
} from "./ui/status-bar";
import {
  buildPermissionDropdown,
  type PermissionDropdownSettings,
} from "./ui/permission-dropdown";
import type { PermissionPreset } from "./settings-adapter";

/**
 * ClaudeWebviewView — Phase 2 layout + Phase 3 SessionController wiring.
 *
 * Responsibilities:
 *   1. `onOpen`: build the layout, create a bus, instantiate the
 *      SessionController via the injected runtime (test harness or
 *      production wireWebview), start it, and attach the input-bar.
 *   2. `onClose`: flip `disposed = true`, dispose the controller
 *      (which removes every child-process listener and SIGTERMs the
 *      child), dispose the input-bar, dispose the bus.
 *   3. Gate every dispatch through the MH-11 double-guard:
 *      `if (this.disposed || this.leaf.view !== this) return`.
 *
 * Namespace log prefix: `[claude-webview]`.
 */

export interface WebviewRenderOptionsSnapshot {
  readonly showThinking: boolean;
  /**
   * Phase 5a — hook_started / hook_response cards are hidden by default
   * (MH-07). When `true`, the system-hook renderer emits a collapsed
   * `<details>` card per hook event instead of dropping it.
   */
  readonly showDebugSystemEvents: boolean;
}

/**
 * Shared mutable settings view the permission dropdown (Phase 4b) and the
 * session controller both reference. The dropdown mutates
 * `permissionPreset` in place on user change; the next `start()` recomputes
 * `buildSpawnArgs(settings)` so the argv reflects the latest choice. A
 * single object backs both consumers — `SpawnArgsSettings` is a structural
 * superset that treats the fields as readonly at the type level only.
 */
export interface WebviewMutableSettings extends PermissionDropdownSettings {
  permissionPreset: PermissionPreset;
  readonly claudePath: string;
  readonly extraArgs: string;
  /**
   * Phase 5a — the SessionController's `onSessionId` callback writes the
   * most recent `result.session_id` here so a later "Resume last" command
   * can fetch it without going through plugin.settings. The field is
   * mutated in place and mirrored into plugin.settings via the
   * `persistSettings` hook.
   */
  lastSessionId: string;
}

export interface WebviewViewRuntime {
  readonly spawnImpl: SpawnImpl;
  /**
   * Shared settings object used by the session controller (via the
   * `SpawnArgsSettings` view) and the permission dropdown (via the
   * `PermissionDropdownSettings` view). A single reference so a dropdown
   * change is visible to the next spawn without re-mounting.
   */
  readonly settings: WebviewMutableSettings;
  /**
   * Phase 5a — when `true`, `onOpen()` calls
   * `controller.start(undefined, settings.lastSessionId)` so the argv
   * carries `--resume <id>`. The `COMMAND_RESUME_WEBVIEW` command flips
   * this flag on the next factory invocation; the regular open command
   * leaves it `false`/`undefined` (fresh session). Read once per
   * `onOpen()` — a spurious re-open of the same leaf does NOT re-resume.
   */
  readonly resumeOnStart?: boolean;
  /**
   * Provider for render-time settings. Called on every dispatch so a toggle
   * applied from the settings panel is observed without remounting the view.
   * `undefined` means "treat as DEFAULT_WEBVIEW_SETTINGS" (thinking
   * collapsed). Tests can pass a fixed record by returning the same object
   * from the closure; production wireWebview reads from `plugin.settings`
   * inside the closure so the most recent saved setting always wins.
   */
  readonly renderOptions?: () => WebviewRenderOptionsSnapshot;
  /**
   * Persistence hook the permission dropdown calls after a preset change.
   * In production this is `() => plugin.saveSettings()`. Optional — test
   * harnesses may pass `undefined` and rely on the dropdown's settings
   * mutation for integration assertions.
   */
  readonly persistSettings?: () => void | Promise<void>;
  /**
   * Phase 5b — when present, the SessionController mirrors every parsed
   * event into this archive, and a failed `--resume` attempt on a
   * `resumeOnStart` leaf falls back to `archive.load(lastSessionId)` +
   * in-place replay through the same `dispatchStreamEvent` pipeline as
   * live stdout. Left `undefined` in test harnesses that do not exercise
   * SH-07; a legitimate production wiring with archive disabled should
   * also pass `undefined` rather than a no-op stub so the controller
   * short-circuits its buffer logic cleanly.
   */
  readonly archive?: SessionArchive;
}

interface RendererStates {
  readonly assistantText: AssistantTextRenderState;
  readonly assistantToolUse: AssistantToolUseRenderState;
  readonly assistantThinking: AssistantThinkingRenderState;
  readonly editDiff: EditDiffRenderState;
  readonly todoPanel: TodoPanelRenderState;
  readonly userToolResult: UserToolResultRenderState;
  readonly result: ResultRenderState;
  readonly systemInit: SystemInitRenderState;
  readonly systemStatus: SystemStatusRenderState;
  readonly systemHook: SystemHookRenderState;
  readonly compactBoundary: CompactBoundaryRenderState;
}

export class ClaudeWebviewView extends ItemView {
  private disposed = true;
  private closed = false;
  private bus: Bus | null = null;
  private layout: WebviewLayout | null = null;
  private states: RendererStates | null = null;
  private controller: SessionController | null = null;
  private inputBar: InputBar | null = null;
  private statusBar: StatusBarHandle | null = null;
  /**
   * Injection point for the SessionController runtime. Both production
   * (`wireWebview` in `index.ts`) and tests assign this field before
   * `onOpen()` runs; the onOpen path is identical in both environments.
   * The deprecated `__testHooks` alias is kept in place for Phase 3 tests
   * that still reach the view via `as unknown as {__testHooks: ...}` and
   * forwards reads/writes to `runtime` so either name resolves the same
   * object. Prefer `runtime` in new code.
   */
  public runtime: WebviewViewRuntime | undefined;

  /** @deprecated Phase 3 test hook — use `runtime` instead. */
  public get __testHooks(): WebviewViewRuntime | undefined {
    return this.runtime;
  }
  public set __testHooks(value: WebviewViewRuntime | undefined) {
    this.runtime = value;
  }

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_CLAUDE_WEBVIEW;
  }

  getDisplayText(): string {
    return "Claude Webview";
  }

  getIcon(): string {
    return "claude-ai";
  }

  async onOpen(): Promise<void> {
    this.disposed = false;
    this.closed = false;
    // eslint-disable-next-line no-console
    console.log("[claude-webview] view mounted");
    const root = this.resolveRoot();
    if (!root) {
      this.bus = createBus();
      return;
    }

    const doc = root.ownerDocument;
    if (!doc) {
      throw new Error("[claude-webview] onOpen: root has no ownerDocument");
    }

    root.replaceChildren();

    this.layout = buildLayout(root);
    this.states = {
      assistantText: createAssistantTextState(),
      assistantToolUse: createAssistantToolUseState(),
      assistantThinking: createAssistantThinkingState(),
      editDiff: createEditDiffState(),
      todoPanel: createTodoPanelState(),
      userToolResult: createUserToolResultState(),
      result: createResultState(),
      systemInit: createSystemInitState(),
      systemStatus: createSystemStatusState(),
      systemHook: createSystemHookState(),
      compactBoundary: createCompactBoundaryState(),
    };
    this.statusBar = buildStatusBar(this.layout.headerEl, doc);

    const bus = createBus();
    this.bus = bus;

    bus.on("stream.event", (e) => {
      if (this.disposed) return;
      if (this.leaf.view !== this) return;
      const layout = this.layout;
      const states = this.states;
      if (!layout || !states) return;
      this.dispatchStreamEvent(e.event, layout, states, doc);
    });

    const runtime = this.runtime;
    if (runtime) {
      // Mount the permission dropdown in the header so a user preset change
      // mutates `runtime.settings.permissionPreset` in place. The next
      // `SessionController.start()` picks up the new value via
      // `buildSpawnArgs(settings)` at call time — MH-09 integration contract.
      //
      // `registerDomEvent` binds the change listener through Obsidian's
      // `Component` lifecycle, so `onClose` / plugin unload tears the
      // listener down with the view. Without this, the dropdown falls back
      // to `el.addEventListener` and the listener survives until GC.
      buildPermissionDropdown(this.layout.headerEl, {
        settings: runtime.settings,
        bus,
        persist: runtime.persistSettings ?? (() => {}),
        registerDomEvent: (el, type, handler) => {
          this.registerDomEvent(el, type, handler);
        },
      });

      const controller = new SessionController({
        settings: runtime.settings,
        bus,
        spawnImpl: runtime.spawnImpl,
        archive: runtime.archive,
        onSessionId: (id) => {
          runtime.settings.lastSessionId = id;
          const persist = runtime.persistSettings;
          if (persist) {
            try {
              const r = persist();
              if (r instanceof Promise) {
                r.catch((err: unknown) => {
                  // eslint-disable-next-line no-console
                  console.error(
                    "[claude-webview] persistSettings failed after onSessionId:",
                    err,
                  );
                });
              }
            } catch (err: unknown) {
              // eslint-disable-next-line no-console
              console.error(
                "[claude-webview] persistSettings threw after onSessionId:",
                err,
              );
            }
          }
        },
      });
      this.controller = controller;
      // Lazy start: don't spawn claude -p until the user sends the first
      // message. `claude -p` without a prompt argument + --input-format
      // stream-json may exit immediately if no stdin arrives fast enough.
      // By deferring spawn to the first ui.send, the prompt argument
      // carries the user's text and the session starts reliably.
      const resumeId =
        runtime.resumeOnStart === true &&
        runtime.settings.lastSessionId.length > 0
          ? runtime.settings.lastSessionId
          : undefined;

      // For resume, start immediately (the session has prior context).
      if (resumeId !== undefined) {
        controller.start(undefined, resumeId);
      }

      bus.on("ui.send", (e) => {
        if (this.disposed) return;
        if (!controller.isStarted()) {
          // First message: spawn with the user's text as initialText.
          // This passes `-p` with the text as the prompt argument,
          // ensuring claude starts processing immediately.
          controller.start(e.text);
        } else {
          controller.send(e.text);
        }
      });

      // Surface session errors as Notice + error card so the user sees
      // what went wrong (spawn failure, EPIPE, stdin destroyed, etc.).
      bus.on("session.error", (e) => {
        if (this.disposed) return;
        // eslint-disable-next-line no-console
        console.error("[claude-webview] session error:", e.message);
        // Render a visible error card in the cards area.
        const layout = this.layout;
        if (layout) {
          const errCard = doc.createElement("div");
          errCard.className = "claude-wv-card claude-wv-card--result";
          errCard.setAttribute("data-is-error", "true");
          errCard.textContent = `Error: ${e.message}`;
          layout.cardsEl.appendChild(errCard);
          errCard.scrollIntoView({ behavior: "smooth" });
        }
      });

      // Phase 5b — resume fallback (SH-07). When a `--resume <sid>` spawn
      // reports a clean failure (`result.is_error=true`) OR dies with a
      // non-zero exit code before any successful result event, hydrate
      // the leaf from the local `SessionArchive` so the user still sees
      // the prior turn context.
      const archive = runtime.archive;
      if (resumeId !== undefined && archive) {
        const archiveRef = archive;
        const resumeSid = resumeId;
        let fallbackTriggered = false;
        const runFallback = (): void => {
          if (this.disposed) return;
          if (this.leaf.view !== this) return;
          if (fallbackTriggered) return;
          fallbackTriggered = true;
          let events: StreamEvent[];
          try {
            events = archiveRef.load(resumeSid);
          } catch (err: unknown) {
            // eslint-disable-next-line no-console
            console.error(
              "[claude-webview] resume fallback: archive.load threw",
              err,
            );
            return;
          }
          if (events.length === 0) return;
          const l = this.layout;
          const s = this.states;
          if (!l || !s) return;
          for (const ev of events) {
            if (this.disposed) return;
            if (this.leaf.view !== this) return;
            this.dispatchStreamEvent(ev, l, s, doc);
          }
        };
        bus.on("stream.event", (e) => {
          if (e.event.type !== "result") return;
          if (e.event.is_error !== true) return;
          runFallback();
        });
        bus.on("session.error", (e) => {
          const m = e.message;
          if (!m.startsWith("exit:")) return;
          if (m === "exit: 0") return;
          runFallback();
        });
      }
    }

    this.inputBar = buildInputBar(this.layout.inputRowEl, bus);
  }

  async onClose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.disposed = true;
    if (this.controller) {
      try {
        this.controller.dispose();
      } catch {
        // Continue — dispose must not throw out of onClose.
      }
      this.controller = null;
    }
    if (this.inputBar) {
      try {
        this.inputBar.dispose();
      } catch {
        // Continue.
      }
      this.inputBar = null;
    }
    if (this.bus) {
      this.bus.dispose();
      this.bus = null;
    }
    this.layout = null;
    this.states = null;
    // HIGH-2 fix — statusBar holds a closure over its badge Map (4
    // HTMLElement refs). Other handles are nulled here; keep the pattern
    // consistent so GC can collect the whole graph once the leaf drops
    // its view reference.
    this.statusBar = null;
    // eslint-disable-next-line no-console
    console.log("[claude-webview] view unmounted");
  }

  private resolveRoot(): HTMLElement | null {
    const child: unknown = this.containerEl?.children?.[1];
    if (!child) return null;
    if (typeof (child as HTMLElement).replaceChildren !== "function") {
      return null;
    }
    return child as HTMLElement;
  }

  private dispatchStreamEvent(
    event: StreamEvent,
    layout: WebviewLayout,
    states: RendererStates,
    doc: Document,
  ): void {
    const cards = layout.cardsEl;
    const runtime = this.runtime;
    const renderOptions = runtime?.renderOptions?.();
    const showThinking = renderOptions?.showThinking ?? false;
    const showDebug = renderOptions?.showDebugSystemEvents ?? false;
    switch (event.type) {
      case "assistant":
        renderAssistantText(states.assistantText, cards, event, doc);
        renderAssistantToolUse(states.assistantToolUse, cards, event, doc);
        renderAssistantThinking(
          states.assistantThinking,
          cards,
          event,
          doc,
          { showThinking },
        );
        renderEditDiff(states.editDiff, cards, event, doc);
        renderTodoPanel(
          states.todoPanel,
          cards,
          layout.todoSideEl,
          event,
          doc,
        );
        return;
      case "user":
        renderUserToolResult(states.userToolResult, cards, event, doc);
        return;
      case "result":
        renderResult(states.result, cards, event, doc);
        if (this.statusBar) {
          this.statusBar.update(event);
        }
        return;
      case "system":
        switch (event.subtype) {
          case "init":
            renderSystemInit(states.systemInit, cards, event, doc);
            return;
          case "status":
            renderSystemStatus(states.systemStatus, layout.headerEl, event, doc);
            return;
          case "compact_boundary":
            renderCompactBoundary(states.compactBoundary, cards, event, doc);
            return;
          case "hook_started":
          case "hook_response":
            renderSystemHook(states.systemHook, cards, event, doc, { showDebug });
            return;
          default: {
            // Phase 5a review MED-Q1 — exhaustive inner switch so a future
            // SystemEvent subtype addition breaks this file at compile time
            // rather than silently no-op'ing at runtime.
            const _exhaustiveSubtype: never = event;
            void _exhaustiveSubtype;
            return;
          }
        }
      case "rate_limit_event":
        return;
      case "__unknown__":
        return;
      default: {
        const _exhaustive: never = event;
        void _exhaustive;
        return;
      }
    }
  }
}
