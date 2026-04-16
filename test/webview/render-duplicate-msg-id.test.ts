import { describe, it, expect } from "vitest";
import { Window } from "happy-dom";
import {
  createAssistantTextState,
  renderAssistantText,
} from "../../src/webview/renderers/assistant-text";
import type { AssistantEvent } from "../../src/webview/parser/types";

function makeAssistantEvent(id: string, text: string): AssistantEvent {
  return {
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
    },
    session_id: "test-session",
    uuid: "test-uuid-" + text,
  };
}

describe("render-duplicate-msg-id (SH-01)", () => {
  it("three events with same msg.id collapse into a single card showing only the final text", () => {
    const window = new Window();
    const doc = window.document;
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);
    const state = createAssistantTextState();

    const msgId = "msg_dedupe_test";
    renderAssistantText(
      state,
      parent as unknown as HTMLElement,
      makeAssistantEvent(msgId, "A"),
      doc as unknown as Document,
    );
    renderAssistantText(
      state,
      parent as unknown as HTMLElement,
      makeAssistantEvent(msgId, "A"),
      doc as unknown as Document,
    );
    renderAssistantText(
      state,
      parent as unknown as HTMLElement,
      makeAssistantEvent(msgId, "B"),
      doc as unknown as Document,
    );

    expect(state.cards.size).toBe(1);
    const card = state.cards.get(msgId);
    expect(card).toBeDefined();
    if (!card) return;
    expect((card.textContent ?? "").trim()).toBe("B");
    const blocks = card.querySelectorAll(".claude-wv-text-block");
    expect(blocks.length).toBe(1);
    expect(parent.children.length).toBe(1);
  });

  it("two distinct msg.ids produce two separate cards", () => {
    const window = new Window();
    const doc = window.document;
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);
    const state = createAssistantTextState();

    renderAssistantText(
      state,
      parent as unknown as HTMLElement,
      makeAssistantEvent("msg_a", "alpha"),
      doc as unknown as Document,
    );
    renderAssistantText(
      state,
      parent as unknown as HTMLElement,
      makeAssistantEvent("msg_b", "beta"),
      doc as unknown as Document,
    );

    expect(state.cards.size).toBe(2);
    expect(parent.children.length).toBe(2);
    expect(state.cards.get("msg_a")?.textContent).toContain("alpha");
    expect(state.cards.get("msg_b")?.textContent).toContain("beta");
  });

  it("events with no text blocks do not create a card", () => {
    const window = new Window();
    const doc = window.document;
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);
    const state = createAssistantTextState();

    const emptyEvent: AssistantEvent = {
      type: "assistant",
      message: {
        id: "msg_empty",
        type: "message",
        role: "assistant",
        content: [],
      },
      session_id: "test",
      uuid: "u-empty",
    };
    const result = renderAssistantText(
      state,
      parent as unknown as HTMLElement,
      emptyEvent,
      doc as unknown as Document,
    );

    expect(result).toBeNull();
    expect(state.cards.size).toBe(0);
    expect(parent.children.length).toBe(0);
  });
});
