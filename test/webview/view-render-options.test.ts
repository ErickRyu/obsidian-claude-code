/**
 * Phase 4a integration: renderOptions live-toggle path.
 *
 * `WebviewViewRuntime.renderOptions` is declared as a function rather than a
 * value snapshot so a settings toggle applied mid-session is picked up on
 * the next stream event without remounting the view. The unit tests on
 * `renderAssistantThinking` already cover the renderer-level behavior; this
 * file closes the integration gap by driving the full view dispatch path
 * (SessionController.stdout → bus → dispatchStreamEvent → renderer) and
 * asserting that flipping the closure's return value between two events
 * flips the `<details open>` attribute accordingly.
 *
 * Pre-mortem motivation (PM-AP-1): a value-snapshot regression at the
 * `runtime?.renderOptions?.()` call site would silently freeze showThinking
 * at the registration-time value; jsdom/happy-dom mocks otherwise miss this
 * lifecycle-level race, so the integration test lives alongside
 * view-lifecycle.test.ts.
 */
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Window } from "happy-dom";
import type { ChildProcess } from "node:child_process";
import type { WorkspaceLeaf } from "obsidian";
import { ClaudeWebviewView } from "../../src/webview/view";
import type {
  SpawnImpl,
} from "../../src/webview/session/session-controller";
import type { SpawnArgsSettings } from "../../src/webview/session/spawn-args";
import type { WebviewViewRuntime } from "../../src/webview/view";

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill(signal?: string): boolean;
  killed: boolean;
  pid: number;
  exitCode: number | null;
}

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter();
  const fake = Object.assign(ee, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    pid: 88888,
    exitCode: null,
    kill(_signal?: string): boolean {
      fake.killed = true;
      return true;
    },
  }) as FakeChild;
  return fake;
}

function mountHarness(settingsBag: { showThinking: boolean }) {
  const children: FakeChild[] = [];
  const spawnImpl: SpawnImpl = () => {
    const c = makeFakeChild();
    children.push(c);
    return c as unknown as ChildProcess;
  };
  const spawnArgs: SpawnArgsSettings = {
    claudePath: "claude",
    permissionPreset: "standard",
    extraArgs: "",
  };

  const win = new Window();
  const doc = win.document;
  const containerEl = doc.createElement("div");
  const rootHost = doc.createElement("div");
  containerEl.appendChild(doc.createElement("div"));
  containerEl.appendChild(rootHost);
  doc.body.appendChild(containerEl);

  const leaf = { view: null as unknown as ClaudeWebviewView } as WorkspaceLeaf & {
    view: ClaudeWebviewView;
  };
  const view = new ClaudeWebviewView(leaf);
  (view as unknown as { containerEl: HTMLElement }).containerEl =
    containerEl as unknown as HTMLElement;
  leaf.view = view;

  const runtime: WebviewViewRuntime = {
    spawnImpl,
    settings: spawnArgs,
    renderOptions: () => ({ showThinking: settingsBag.showThinking }),
  };
  (view as unknown as { __testHooks: WebviewViewRuntime }).__testHooks = runtime;

  return { view, rootHost: rootHost as unknown as HTMLElement, children };
}

function emitAssistantThinking(child: FakeChild, msgId: string, text: string): void {
  child.stdout.emit(
    "data",
    JSON.stringify({
      type: "assistant",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        content: [{ type: "thinking", thinking: text, signature: "sig-" + msgId }],
      },
      session_id: "live-toggle",
      uuid: "u-" + msgId,
    }) + "\n",
  );
}

describe("ClaudeWebviewView renderOptions live-toggle (Phase 4a integration)", () => {
  it("dispatch re-reads renderOptions() on every event so showThinking toggles mid-session", async () => {
    const settingsBag = { showThinking: false };
    const { view, rootHost, children } = mountHarness(settingsBag);

    await view.onOpen();
    const child = children[0];
    expect(child).toBeTruthy();

    // Event 1: showThinking=false → <details> should NOT have `open`.
    emitAssistantThinking(child!, "msg_thinking_1", "first reasoning");
    await Promise.resolve();

    const cardsEl = rootHost.querySelector(".claude-wv-cards");
    expect(cardsEl).not.toBeNull();
    const firstCard = cardsEl!.querySelector(
      ".claude-wv-card--assistant-thinking",
    );
    expect(firstCard).not.toBeNull();
    const firstDetails = firstCard!.querySelector("details");
    expect(firstDetails).not.toBeNull();
    expect(firstDetails!.hasAttribute("open")).toBe(false);

    // Flip the live setting — no view remount — and dispatch a NEW message.
    settingsBag.showThinking = true;
    emitAssistantThinking(child!, "msg_thinking_2", "second reasoning");
    await Promise.resolve();

    const secondCard = cardsEl!.querySelector(
      ".claude-wv-card--assistant-thinking[data-msg-id='msg_thinking_2']",
    );
    expect(secondCard).not.toBeNull();
    const secondDetails = secondCard!.querySelector("details");
    expect(secondDetails).not.toBeNull();
    expect(secondDetails!.hasAttribute("open")).toBe(true);

    await view.onClose();
  });

  it("absent renderOptions falls back to showThinking=false", async () => {
    const children: FakeChild[] = [];
    const spawnImpl: SpawnImpl = () => {
      const c = makeFakeChild();
      children.push(c);
      return c as unknown as ChildProcess;
    };
    const spawnArgs: SpawnArgsSettings = {
      claudePath: "claude",
      permissionPreset: "standard",
      extraArgs: "",
    };

    const win = new Window();
    const doc = win.document;
    const containerEl = doc.createElement("div");
    const rootHost = doc.createElement("div");
    containerEl.appendChild(doc.createElement("div"));
    containerEl.appendChild(rootHost);
    doc.body.appendChild(containerEl);

    const leaf = { view: null as unknown as ClaudeWebviewView } as WorkspaceLeaf & {
      view: ClaudeWebviewView;
    };
    const view = new ClaudeWebviewView(leaf);
    (view as unknown as { containerEl: HTMLElement }).containerEl =
      containerEl as unknown as HTMLElement;
    leaf.view = view;

    // Deliberately omit renderOptions — tests the baseline.
    (view as unknown as { __testHooks: WebviewViewRuntime }).__testHooks = {
      spawnImpl,
      settings: spawnArgs,
    };

    await view.onOpen();
    emitAssistantThinking(children[0]!, "msg_thinking_default", "reasoning");
    await Promise.resolve();

    const details = (rootHost as unknown as HTMLElement)
      .querySelector(".claude-wv-card--assistant-thinking details");
    expect(details).not.toBeNull();
    expect(details!.hasAttribute("open")).toBe(false);

    await view.onClose();
  });
});
