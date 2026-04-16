import { ItemView, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_CLAUDE_WEBVIEW } from "../constants";
import { buildLayout, type WebviewLayout } from "./ui/layout";
import { createBus, type Bus } from "./event-bus";
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

/**
 * ClaudeWebviewView — Phase 2 layout wiring + MH-11 lifecycle guard.
 *
 * Responsibilities:
 *   1. On `onOpen`, build the `buildLayout` skeleton, create a bus, and
 *      subscribe a dispatcher that fans stream events out to the five
 *      Phase 2 renderer states (assistant.text / tool_use, user
 *      tool_result, result, system.init).
 *   2. On `onClose`, flip `disposed = true`, call `bus.dispose()`, and
 *      drop held references so detached-DOM mutation can't re-enter.
 *   3. Gate every dispatch through the MH-11 double-guard:
 *      `if (this.disposed || this.leaf.view !== this) return`.
 *      Protects against the Obsidian lifecycle race where `detach()`
 *      wins over `onClose()` and a late-arriving event would otherwise
 *      mutate a detached subtree.
 *
 * Phase 3 (`SessionController`) will attach `child.stdout` ->
 * `parseLine` -> `bus.emit({kind:'stream.event', ...})` so the wiring
 * below receives real events. Until then the bus is idle — the
 * contract tested here is purely lifecycle + dispatch safety.
 *
 * Namespace log prefix: `[claude-webview]` (distinct from
 * `[claude-terminal]`).
 */

interface RendererStates {
  readonly assistantText: AssistantTextRenderState;
  readonly assistantToolUse: AssistantToolUseRenderState;
  readonly userToolResult: UserToolResultRenderState;
  readonly result: ResultRenderState;
  readonly systemInit: SystemInitRenderState;
}

export class ClaudeWebviewView extends ItemView {
  private disposed = true;
  private bus: Bus | null = null;
  private layout: WebviewLayout | null = null;
  private states: RendererStates | null = null;

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
    // eslint-disable-next-line no-console
    console.log("[claude-webview] view mounted");
    const root = this.resolveRoot();
    if (!root) {
      // Test mocks supply a stub containerEl without a real HTMLElement at
      // children[1]; skip layout wiring in that environment — the lifecycle
      // guard below still gets exercised by the disposed flag assertions.
      this.bus = createBus();
      return;
    }

    const doc = root.ownerDocument;
    if (!doc) {
      throw new Error("[claude-webview] onOpen: root has no ownerDocument");
    }

    // Clear any stale Phase 0 placeholder children.
    root.replaceChildren();

    this.layout = buildLayout(root);
    this.states = {
      assistantText: createAssistantTextState(),
      assistantToolUse: createAssistantToolUseState(),
      userToolResult: createUserToolResultState(),
      result: createResultState(),
      systemInit: createSystemInitState(),
    };

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
  }

  async onClose(): Promise<void> {
    this.disposed = true;
    if (this.bus) {
      this.bus.dispose();
      this.bus = null;
    }
    this.layout = null;
    this.states = null;
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
    switch (event.type) {
      case "assistant":
        renderAssistantText(states.assistantText, cards, event, doc);
        renderAssistantToolUse(states.assistantToolUse, cards, event, doc);
        return;
      case "user":
        renderUserToolResult(states.userToolResult, cards, event, doc);
        return;
      case "result":
        renderResult(states.result, cards, event, doc);
        return;
      case "system":
        if (event.subtype === "init") {
          renderSystemInit(states.systemInit, cards, event, doc);
        }
        // Phase 5a adds hook_started / hook_response / status / compact_boundary
        // subtypes; Phase 2 intentionally no-ops on them.
        return;
      case "rate_limit_event":
        // Phase 5a surfaces rate-limit banners in the status bar; Phase 2
        // has no status bar yet so this is an intentional no-op.
        return;
      case "__unknown__":
        // Debug-mode unknown-card fallback arrives in Phase 4a via card-registry;
        // Phase 2 intentionally no-ops to stay within the allowlist surface.
        return;
      default: {
        // Exhaustiveness guard — adding a new StreamEvent union member without
        // a case arm fails the build. The `never` assertion guarantees this.
        const _exhaustive: never = event;
        void _exhaustive;
        return;
      }
    }
  }
}
