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
  createUserTextState,
  renderUserText,
  appendUserPrompt,
  type UserTextRenderState,
} from "./renderers/user-text";
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
import { buildVersionBadge } from "./ui/version-badge";
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
  /**
   * Test-only escape hatch for the lazy-start regression introduced in
   * 71c4f23 (CSS styling + lazy-start spawn). When `true`, `onOpen()`
   * eagerly calls `controller.start()` so the test harness has a
   * spawned child immediately — matching the pre-71c4f23 contract that
   * existing lifecycle/render tests assume. Production wiring leaves
   * this `undefined`/`false` so the lazy-start UX (no claude spawn
   * until the user types the first message) holds.
   */
  readonly eagerStartForTests?: boolean;
  /**
   * B1-NEW (2026-04-29) Workspace Awareness — absolute working directory
   * for the spawned claude -p child. Falls back to the inherited process
   * cwd when undefined (which surfaced as `cwd: /` in dogfood, hence the
   * fix). Resolved by `wireWebview` from `cwdOverride || vaultBasePath`.
   */
  readonly cwd?: string;
  /**
   * B1-NEW — absolute `.mcp.json` path forwarded to `--mcp-config <path>`
   * on every spawn, so claude -p loads the plugin's obsidian-context
   * server (open notes / active note / vault search). Empty/undefined
   * means "no plugin MCP" (user disabled `enableMcp` or setup failed).
   */
  readonly mcpConfigPath?: string;
  /**
   * B1-NEW — absolute `obsidian-prompt.txt` path forwarded to
   * `--append-system-prompt-file <path>` on every spawn. Mirrors the
   * v0.5.x terminal-mode wiring so Claude knows it is running inside
   * Obsidian and what notes are open.
   */
  readonly systemPromptPath?: string;
  /**
   * 2026-04-29 dogfood — production wiring passes a closure that calls
   * Obsidian's `MarkdownRenderer.render(app, text, el, "", view)` so
   * Claude's text blocks render with formatted headings, lists, code,
   * and clickable wikilinks. Tests omit this and the renderer falls
   * back to plain `textContent`.
   */
  readonly renderMarkdown?: (text: string, el: HTMLElement) => void;
}

interface RendererStates {
  readonly assistantText: AssistantTextRenderState;
  readonly assistantToolUse: AssistantToolUseRenderState;
  readonly assistantThinking: AssistantThinkingRenderState;
  readonly editDiff: EditDiffRenderState;
  readonly todoPanel: TodoPanelRenderState;
  readonly userToolResult: UserToolResultRenderState;
  readonly userText: UserTextRenderState;
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
   * 2026-04-29 dogfood Issue #2 — stay pinned to the bottom of the cards
   * region while streaming, but yield to the user the moment they
   * scroll up to read history. Resets to `true` after the user scrolls
   * back near the bottom, or after they send a new message.
   */
  private stickToBottom = true;
  /**
   * Suppresses the scroll listener while we programmatically force
   * scrollTop in `scrollToBottom`. Without it, the synthetic scroll
   * event fires and reads back stale geometry (because async markdown
   * is still hydrating) which can flip `stickToBottom` to false during
   * a normal stream tick.
   */
  private programmaticScroll = false;
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
      userText: createUserTextState(),
      result: createResultState(),
      systemInit: createSystemInitState(),
      systemStatus: createSystemStatusState(),
      systemHook: createSystemHookState(),
      compactBoundary: createCompactBoundaryState(),
    };
    this.statusBar = buildStatusBar(this.layout.headerEl, doc);
    buildVersionBadge(this.layout.headerEl, {
      version: __PLUGIN_VERSION__,
      gitShort: __PLUGIN_GIT_SHORT__,
      buildIso: __PLUGIN_BUILD_ISO__,
    });

    const bus = createBus();
    this.bus = bus;

    // 2026-04-29 dogfood: MarkdownRenderer.render emits
    // `<a class="internal-link" data-href="...">` for `[[wikilink]]` but
    // the click handler that resolves and opens the note only auto-
    // attaches inside Obsidian's reading/editing views. Custom ItemView
    // DOM has no listener — clicks are dead. Delegate from cardsEl so
    // every wikilink (including ones rendered after this listener
    // attaches) routes through `workspace.openLinkText`. External `http`
    // / `obsidian://` anchors fall through to default browser handling.
    this.registerDomEvent(
      this.layout.cardsEl,
      "click",
      (evt) => {
        // Duck-type the target: production runs in Obsidian's webview
        // where `Element` is global, but the unit test environment is
        // `node` (no DOM globals) so `instanceof Element` would throw a
        // silent ReferenceError inside the event listener and skip the
        // whole handler. Anything that exposes `.closest("a")` is good
        // enough — this is what we'd cast to anyway.
        const target = evt.target as
          | { closest?: (sel: string) => HTMLAnchorElement | null }
          | null;
        if (!target || typeof target.closest !== "function") return;
        const anchor = target.closest("a");
        if (!anchor) return;
        const isInternal =
          anchor.classList.contains("internal-link") ||
          anchor.hasAttribute("data-href");
        if (!isInternal) return;
        const linktext =
          anchor.getAttribute("data-href") ??
          anchor.getAttribute("href") ??
          "";
        if (linktext.length === 0) return;
        // Protocol URLs accidentally tagged internal — fall through
        // to default browser / Obsidian protocol handling.
        if (
          linktext.startsWith("http://") ||
          linktext.startsWith("https://") ||
          linktext.startsWith("obsidian://")
        ) {
          return;
        }
        evt.preventDefault();
        // The rendered anchor carries `target="_blank"`; without
        // stopPropagation a downstream listener could still re-open the
        // link as an external browser tab after our preventDefault.
        evt.stopPropagation();
        const newLeaf = evt.ctrlKey || evt.metaKey;
        // sourcePath = active note path so wikilinks resolve relative
        // to wherever the user was just looking. `""` worked for unique
        // basenames but missed nested same-name collisions during
        // dogfood (2026-05-01).
        const sourcePath =
          this.app.workspace.getActiveFile()?.path ?? "";
        Promise.resolve(
          this.app.workspace.openLinkText(linktext, sourcePath, newLeaf),
        ).catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.error("[claude-webview] openLinkText failed:", err);
        });
      },
      // Capture phase — fires before any listener MarkdownRenderer
      // may have attached to the anchor itself.
      true,
    );

    // Register the stick-to-bottom scroll listener BEFORE wiring stream
    // events so the very first dispatch already has the listener in
    // place. registerDomEvent ties the listener to this Component's
    // lifecycle so onClose / plugin unload tears it down with the view.
    this.registerDomEvent(this.layout.cardsEl, "scroll", () => {
      if (this.programmaticScroll) return;
      const el = this.layout?.cardsEl;
      if (!el) return;
      // 32px tolerance — accounts for sub-pixel rounding plus the small
      // "almost at bottom" zone where the user clearly intends to keep
      // following the stream. Tighter than this flickers off when the
      // browser's smooth-scroll undershoots the exact bottom.
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      this.stickToBottom = distanceFromBottom < 32;
    });

    bus.on("stream.event", (e) => {
      if (this.disposed) return;
      if (this.leaf.view !== this) return;
      const layout = this.layout;
      const states = this.states;
      if (!layout || !states) return;
      this.dispatchStreamEvent(e.event, layout, states, doc);
      this.scrollToBottomIfPinned();
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
        // B1-NEW Workspace Awareness — forward the runtime-resolved paths
        // through to every spawn so claude -p sees vault cwd + mcp config
        // + system prompt. wireWebview resolves these closures per leaf
        // factory, so a settings change to enableMcp / cwdOverride takes
        // effect on the next leaf open (existing leaves keep argv snapshot).
        cwd: runtime.cwd,
        mcpConfigPath: runtime.mcpConfigPath,
        systemPromptPath: runtime.systemPromptPath,
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
      } else if (runtime.eagerStartForTests === true) {
        // Test-only path: pre-71c4f23 lifecycle/render tests assume a
        // spawned child after onOpen. See WebviewViewRuntime.eagerStartForTests.
        controller.start();
      }

      bus.on("ui.send", (e) => {
        if (this.disposed) return;
        // Client-side echo: stream-json never echoes the user's own prompt
        // (only tool_result responses), so we mount the prompt as a card
        // here. Without this the conversation reads as a one-sided
        // assistant monologue (2026-04-29 dogfood Issue #2 final fix).
        const layout = this.layout;
        if (layout) {
          appendUserPrompt(layout.cardsEl, e.text, doc);
        }
        // The user just sent a message — they want to see Claude's reply
        // land at the bottom regardless of where they had scrolled.
        this.stickToBottom = true;
        this.scrollToBottomIfPinned();
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
          // After replaying the archive, jump the user to the latest
          // turn so they see where the prior session ended rather than
          // staring at the first event of the resumed conversation.
          this.stickToBottom = true;
          this.scrollToBottomIfPinned();
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

  /**
   * Pin the scroll position to the bottom when the user hasn't scrolled
   * up. Markdown rendering is async (Obsidian's `MarkdownRenderer.render`
   * resolves on a microtask), so we scroll twice: once synchronously
   * (covers plain-text content like tool_result, todo cards) and once
   * after the next animation frame to absorb the height delta from
   * markdown that hydrated after the first scroll.
   */
  private scrollToBottomIfPinned(): void {
    if (!this.stickToBottom) return;
    const el = this.layout?.cardsEl;
    if (!el) return;
    const pinNow = () => {
      if (this.disposed) return;
      const target = this.layout?.cardsEl;
      if (!target) return;
      this.programmaticScroll = true;
      target.scrollTop = target.scrollHeight;
      // Reset on next tick — by the time another scroll event could
      // legitimately fire, the synthetic one we just triggered has
      // already drained.
      const win = target.ownerDocument?.defaultView;
      if (win && typeof win.requestAnimationFrame === "function") {
        win.requestAnimationFrame(() => {
          this.programmaticScroll = false;
        });
      } else {
        this.programmaticScroll = false;
      }
    };
    pinNow();
    const win = el.ownerDocument?.defaultView;
    if (win && typeof win.requestAnimationFrame === "function") {
      win.requestAnimationFrame(pinNow);
    }
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
    const renderMarkdown = runtime?.renderMarkdown;
    switch (event.type) {
      case "assistant":
        renderAssistantText(states.assistantText, cards, event, doc, {
          renderMarkdown,
        });
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
        renderUserText(states.userText, cards, event, doc);
        renderUserToolResult(states.userToolResult, cards, event, doc);
        // 2026-04-29 dogfood Issue #2 (tool-pending resolved): every
        // `tool_result` block in this user event resolves the matching
        // `assistant.tool_use` card's pending spinner. Iterate sibling
        // tool_use cards by `data-tool-use-id` (no querySelector — the
        // tool id format is `toolu_<hex>` but skipping CSS.escape keeps
        // happy-dom compatibility tight).
        if (Array.isArray(event.message.content)) {
          const ids = new Set<string>();
          for (const block of event.message.content) {
            if (block.type !== "tool_result") continue;
            const id = block.tool_use_id;
            if (typeof id === "string" && id.length > 0) ids.add(id);
          }
          if (ids.size > 0) {
            // Both assistant-tool-use cards (Bash/Read/Glob/etc.) and
            // edit-diff cards (Edit/Write) share the data-tool-use-id
            // attribute, so resolve pending state on either type.
            const tuCards = cards.getElementsByClassName(
              "claude-wv-card--assistant-tool-use",
            );
            const edCards = cards.getElementsByClassName(
              "claude-wv-card--edit-diff",
            );
            for (const list of [tuCards, edCards]) {
              for (let i = 0; i < list.length; i++) {
                const c = list[i];
                const id = c?.getAttribute("data-tool-use-id");
                if (id !== null && id !== undefined && ids.has(id)) {
                  c.setAttribute("data-pending", "false");
                }
              }
            }
          }
        }
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
