import { describe, it, expect } from "vitest";
import { Window } from "happy-dom";
import path from "node:path";
import { replayFixture } from "./helpers/fixture-replay";
import {
  createAssistantThinkingState,
  renderAssistantThinking,
} from "../../src/webview/renderers/assistant-thinking";
import type { AssistantEvent } from "../../src/webview/parser/types";

const PLAN_MODE_FIXTURE = path.resolve(
  __dirname,
  "..",
  "fixtures",
  "stream-json",
  "plan-mode.jsonl",
);

function thinkingEvent(
  msgId: string,
  thinking: string,
  signature?: string,
): AssistantEvent {
  return {
    type: "assistant",
    message: {
      id: msgId,
      type: "message",
      role: "assistant",
      content: [
        { type: "thinking", thinking, ...(signature !== undefined ? { signature } : {}) },
      ],
    },
    session_id: "test",
    uuid: "u-" + msgId,
  };
}

describe("render-thinking (SH-01)", () => {
  it("renders a <details> card collapsed by default (showThinking=false)", () => {
    const { document: doc } = new Window();
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);

    const state = createAssistantThinkingState();
    const ev = thinkingEvent("msg_think_1", "reasoning content", "sig-abc");
    const card = renderAssistantThinking(
      state,
      parent as unknown as HTMLElement,
      ev,
      doc as unknown as Document,
      { showThinking: false },
    );
    expect(card).not.toBeNull();
    expect(card?.classList.contains("claude-wv-card")).toBe(true);
    expect(card?.classList.contains("claude-wv-card--assistant-thinking")).toBe(true);
    expect(card?.getAttribute("data-msg-id")).toBe("msg_think_1");
    expect(card?.getAttribute("data-signature")).toBe("sig-abc");

    const details = card?.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.hasAttribute("open")).toBe(false);

    const body = card?.querySelector(".claude-wv-thinking-body");
    expect(body?.textContent).toContain("reasoning content");
  });

  it("renders a <details open> when showThinking=true", () => {
    const { document: doc } = new Window();
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);

    const state = createAssistantThinkingState();
    const ev = thinkingEvent("msg_think_2", "thinking stream");
    renderAssistantThinking(
      state,
      parent as unknown as HTMLElement,
      ev,
      doc as unknown as Document,
      { showThinking: true },
    );
    const details = state.cards.get("msg_think_2")?.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.hasAttribute("open")).toBe(true);
  });

  it("re-emitted thinking block with the same msg.id upserts (no duplicate cards)", () => {
    const { document: doc } = new Window();
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);

    const state = createAssistantThinkingState();
    renderAssistantThinking(
      state,
      parent as unknown as HTMLElement,
      thinkingEvent("msg_up", "first pass"),
      doc as unknown as Document,
      { showThinking: false },
    );
    renderAssistantThinking(
      state,
      parent as unknown as HTMLElement,
      thinkingEvent("msg_up", "second pass with more context"),
      doc as unknown as Document,
      { showThinking: false },
    );

    expect(state.cards.size).toBe(1);
    expect(parent.children.length).toBe(1);
    const body = state.cards.get("msg_up")?.querySelector(".claude-wv-thinking-body");
    expect(body?.textContent).toContain("second pass");
    expect(body?.textContent ?? "").not.toContain("first pass");
  });

  it("events with no thinking blocks return null and do not mutate parent", () => {
    const { document: doc } = new Window();
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);

    const state = createAssistantThinkingState();
    const textOnly: AssistantEvent = {
      type: "assistant",
      message: {
        id: "msg_text",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "plain text only" }],
      },
      session_id: "test",
      uuid: "u-text",
    };
    const card = renderAssistantThinking(
      state,
      parent as unknown as HTMLElement,
      textOnly,
      doc as unknown as Document,
      { showThinking: false },
    );
    expect(card).toBeNull();
    expect(state.cards.size).toBe(0);
    expect(parent.children.length).toBe(0);
  });

  it("renders plan-mode.jsonl thinking block from real fixture with showThinking=false (collapsed)", () => {
    const { events } = replayFixture(PLAN_MODE_FIXTURE);
    // Find the first assistant event with a thinking block.
    const target = events.find(
      (ev) =>
        ev.type === "assistant" &&
        ev.message.content.some((b) => b.type === "thinking"),
    );
    expect(target).not.toBeUndefined();

    const { document: doc } = new Window();
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);
    const state = createAssistantThinkingState();
    const card = renderAssistantThinking(
      state,
      parent as unknown as HTMLElement,
      target as AssistantEvent,
      doc as unknown as Document,
      { showThinking: false },
    );
    expect(card).not.toBeNull();
    const details = card?.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.hasAttribute("open")).toBe(false);
  });

  it("does not render raw HTML from thinking content (textContent only)", () => {
    const { document: doc } = new Window();
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);
    const state = createAssistantThinkingState();

    const ev = thinkingEvent(
      "msg_xss",
      "<script>alert(1)</script><img src=x onerror=alert(2)>",
    );
    renderAssistantThinking(
      state,
      parent as unknown as HTMLElement,
      ev,
      doc as unknown as Document,
      { showThinking: true },
    );
    const card = state.cards.get("msg_xss");
    expect(card?.querySelector("script")).toBeNull();
    expect(card?.querySelector("img")).toBeNull();
    const text = card?.textContent ?? "";
    expect(text).toContain("<script>");
    expect(text).toContain("onerror");
  });
});
