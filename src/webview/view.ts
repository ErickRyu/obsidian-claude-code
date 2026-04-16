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

export interface WebviewViewRuntime {
  readonly spawnImpl: SpawnImpl;
  readonly settings: SpawnArgsSettings;
}

interface RendererStates {
  readonly assistantText: AssistantTextRenderState;
  readonly assistantToolUse: AssistantToolUseRenderState;
  readonly userToolResult: UserToolResultRenderState;
  readonly result: ResultRenderState;
  readonly systemInit: SystemInitRenderState;
}

export class ClaudeWebviewView extends ItemView {
  private disposed = true;
  private closed = false;
  private bus: Bus | null = null;
  private layout: WebviewLayout | null = null;
  private states: RendererStates | null = null;
  private controller: SessionController | null = null;
  private inputBar: InputBar | null = null;
  // Injection point for the SessionController runtime. Tests set this via
  // `(view as unknown as {...}).__testHooks = {...}` before onOpen.  The
  // production `wireWebview` factory sets the same field when creating the
  // view instance so the onOpen path is identical in both environments.
  public __testHooks: WebviewViewRuntime | undefined;

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

    const runtime = this.__testHooks;
    if (runtime) {
      const controller = new SessionController({
        settings: runtime.settings,
        bus,
        spawnImpl: runtime.spawnImpl,
      });
      this.controller = controller;
      bus.on("ui.send", (e) => {
        if (this.disposed) return;
        controller.send(e.text);
      });
      controller.start();
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
        return;
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
