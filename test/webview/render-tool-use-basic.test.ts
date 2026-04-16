import { describe, it, expect } from "vitest";
import { Window } from "happy-dom";
import {
  createAssistantToolUseState,
  renderAssistantToolUse,
} from "../../src/webview/renderers/assistant-tool-use";
import type { AssistantEvent } from "../../src/webview/parser/types";

function toolUseEvent(
  msgId: string,
  toolId: string,
  name: string,
  input: Record<string, unknown>,
): AssistantEvent {
  return {
    type: "assistant",
    message: {
      id: msgId,
      type: "message",
      role: "assistant",
      content: [{ type: "tool_use", id: toolId, name, input }],
    },
    session_id: "test",
    uuid: "u-" + toolId,
  };
}

describe("render-tool-use-basic (SH-02)", () => {
  it("renders a card with data-tool-name=\"Bash\" for a Bash tool_use block", () => {
    const window = new Window();
    const doc = window.document;
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);
    const state = createAssistantToolUseState();

    const ev = toolUseEvent("msg_1", "toolu_bash_1", "Bash", {
      command: "ls -la",
      description: "list files",
    });
    const cards = renderAssistantToolUse(
      state,
      parent as unknown as HTMLElement,
      ev,
      doc as unknown as Document,
    );

    expect(cards.length).toBe(1);
    const card = cards[0];
    expect(card.getAttribute("data-tool-name")).toBe("Bash");
    expect(card.getAttribute("data-tool-use-id")).toBe("toolu_bash_1");
    expect(card.classList.contains("claude-wv-card--assistant-tool-use")).toBe(true);
    expect(card.classList.contains("claude-wv-card")).toBe(true);

    const header = card.querySelector(".claude-wv-tool-use-header");
    expect(header).not.toBeNull();
    expect((header?.textContent ?? "").trim()).toBe("Bash");

    const preview = card.querySelector(".claude-wv-tool-use-input");
    expect(preview).not.toBeNull();
    const previewText = preview?.textContent ?? "";
    expect(previewText).toContain("ls -la");
    expect(previewText).toContain("list files");
  });

  it("renders distinct cards for multiple tool_use blocks in one assistant event", () => {
    const window = new Window();
    const doc = window.document;
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);
    const state = createAssistantToolUseState();

    const ev: AssistantEvent = {
      type: "assistant",
      message: {
        id: "msg_multi",
        type: "message",
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_a", name: "Read", input: { file_path: "/a.md" } },
          { type: "tool_use", id: "toolu_b", name: "Grep", input: { pattern: "foo" } },
        ],
      },
      session_id: "test",
      uuid: "u-multi",
    };

    const cards = renderAssistantToolUse(
      state,
      parent as unknown as HTMLElement,
      ev,
      doc as unknown as Document,
    );
    expect(cards.length).toBe(2);
    expect(cards[0].getAttribute("data-tool-name")).toBe("Read");
    expect(cards[1].getAttribute("data-tool-name")).toBe("Grep");
    expect(state.cards.size).toBe(2);
    expect(parent.children.length).toBe(2);
  });

  it("re-emitted tool_use with the same id upserts (no duplicate cards)", () => {
    const window = new Window();
    const doc = window.document;
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);
    const state = createAssistantToolUseState();

    renderAssistantToolUse(
      state,
      parent as unknown as HTMLElement,
      toolUseEvent("m1", "toolu_x", "Bash", { command: "echo 1" }),
      doc as unknown as Document,
    );
    renderAssistantToolUse(
      state,
      parent as unknown as HTMLElement,
      toolUseEvent("m2", "toolu_x", "Bash", { command: "echo 2" }),
      doc as unknown as Document,
    );

    expect(state.cards.size).toBe(1);
    expect(parent.children.length).toBe(1);
    const card = state.cards.get("toolu_x");
    const previewText = card?.querySelector(".claude-wv-tool-use-input")?.textContent ?? "";
    expect(previewText).toContain("echo 2");
    expect(previewText).not.toContain("echo 1");
  });

  it("events with no tool_use blocks return an empty array", () => {
    const window = new Window();
    const doc = window.document;
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);
    const state = createAssistantToolUseState();

    const textOnly: AssistantEvent = {
      type: "assistant",
      message: {
        id: "msg_text",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "just text" }],
      },
      session_id: "test",
      uuid: "u-text",
    };
    const cards = renderAssistantToolUse(
      state,
      parent as unknown as HTMLElement,
      textOnly,
      doc as unknown as Document,
    );
    expect(cards.length).toBe(0);
    expect(state.cards.size).toBe(0);
    expect(parent.children.length).toBe(0);
  });

  it("formats deeply-nested input JSON as a readable preview", () => {
    const window = new Window();
    const doc = window.document;
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);
    const state = createAssistantToolUseState();

    const ev = toolUseEvent("msg_nested", "toolu_nested", "Edit", {
      file_path: "/tmp/x.md",
      old_string: "hello",
      new_string: "world",
    });
    renderAssistantToolUse(
      state,
      parent as unknown as HTMLElement,
      ev,
      doc as unknown as Document,
    );

    const preview = state.cards
      .get("toolu_nested")
      ?.querySelector(".claude-wv-tool-use-input");
    const text = preview?.textContent ?? "";
    expect(text).toContain("file_path");
    expect(text).toContain("old_string");
    expect(text).toContain("new_string");
    expect(text).not.toContain("[object Object]");
  });
});
