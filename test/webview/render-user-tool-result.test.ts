import { describe, it, expect } from "vitest";
import { Window } from "happy-dom";
import {
  createUserToolResultState,
  renderUserToolResult,
} from "../../src/webview/renderers/user-tool-result";
import type { UserEvent, ToolResultBlock } from "../../src/webview/parser/types";

function toolResultEvent(
  toolUseId: string,
  content: string | ToolResultBlock["content"],
  isError = false,
): UserEvent {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content,
          ...(isError ? { is_error: true } : {}),
        },
      ],
    },
    parent_tool_use_id: null,
    session_id: "test-session",
    uuid: "u-" + toolUseId,
  };
}

describe("render-user-tool-result (MH-04)", () => {
  it("renders a card with data-tool-use-id and a <pre> body for string content", () => {
    const window = new Window();
    const doc = window.document;
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);
    const state = createUserToolResultState();

    const ev = toolResultEvent("toolu_01", "Hello from Read");
    const cards = renderUserToolResult(
      state,
      parent as unknown as HTMLElement,
      ev,
      doc as unknown as Document,
    );

    expect(cards.length).toBe(1);
    const card = cards[0];
    expect(card.classList.contains("claude-wv-card")).toBe(true);
    expect(card.classList.contains("claude-wv-card--user-tool-result")).toBe(true);
    expect(card.getAttribute("data-tool-use-id")).toBe("toolu_01");
    expect(card.hasAttribute("data-is-error")).toBe(false);

    const body = card.querySelector(".claude-wv-tool-result-body");
    expect(body).not.toBeNull();
    expect(body?.tagName.toLowerCase()).toBe("pre");
    expect(body?.textContent).toBe("Hello from Read");
  });

  it("marks error results with data-is-error=\"true\"", () => {
    const window = new Window();
    const doc = window.document;
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);
    const state = createUserToolResultState();

    const ev = toolResultEvent("toolu_err", "permission denied", true);
    const cards = renderUserToolResult(
      state,
      parent as unknown as HTMLElement,
      ev,
      doc as unknown as Document,
    );

    expect(cards.length).toBe(1);
    expect(cards[0].getAttribute("data-is-error")).toBe("true");
  });

  it("renders array-form content with one <pre> per text block and placeholder for images", () => {
    const window = new Window();
    const doc = window.document;
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);
    const state = createUserToolResultState();

    const ev: UserEvent = {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_arr",
            content: [
              { type: "text", text: "part A" },
              { type: "image", source: { placeholder: true } },
              { type: "text", text: "part B" },
            ],
          },
        ],
      },
      parent_tool_use_id: null,
      session_id: "s",
      uuid: "u",
    };

    const cards = renderUserToolResult(
      state,
      parent as unknown as HTMLElement,
      ev,
      doc as unknown as Document,
    );
    const card = cards[0];
    const bodies = card.querySelectorAll(".claude-wv-tool-result-body");
    expect(bodies.length).toBe(2);
    expect(bodies[0].textContent).toBe("part A");
    expect(bodies[1].textContent).toBe("part B");
    const images = card.querySelectorAll(".claude-wv-tool-result-image");
    expect(images.length).toBe(1);
  });

  it("re-emission with the same tool_use_id upserts — no duplicate cards", () => {
    const window = new Window();
    const doc = window.document;
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);
    const state = createUserToolResultState();

    renderUserToolResult(
      state,
      parent as unknown as HTMLElement,
      toolResultEvent("toolu_dup", "first"),
      doc as unknown as Document,
    );
    renderUserToolResult(
      state,
      parent as unknown as HTMLElement,
      toolResultEvent("toolu_dup", "second"),
      doc as unknown as Document,
    );

    expect(state.cards.size).toBe(1);
    expect(parent.children.length).toBe(1);
    const body = state.cards
      .get("toolu_dup")
      ?.querySelector(".claude-wv-tool-result-body");
    expect(body?.textContent).toBe("second");
  });

  it("plain-string user turn (no tool_result blocks) returns [] and leaves parent untouched", () => {
    const window = new Window();
    const doc = window.document;
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);
    const state = createUserToolResultState();

    const ev: UserEvent = {
      type: "user",
      message: { role: "user", content: "plain user input" },
      parent_tool_use_id: null,
      session_id: "s",
      uuid: "u",
    };
    const cards = renderUserToolResult(
      state,
      parent as unknown as HTMLElement,
      ev,
      doc as unknown as Document,
    );
    expect(cards).toEqual([]);
    expect(parent.children.length).toBe(0);
    expect(state.cards.size).toBe(0);
  });

  it("multiple tool_result blocks in one event render multiple cards", () => {
    const window = new Window();
    const doc = window.document;
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);
    const state = createUserToolResultState();

    const ev: UserEvent = {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_x", content: "x" },
          { type: "tool_result", tool_use_id: "toolu_y", content: "y" },
        ],
      },
      parent_tool_use_id: null,
      session_id: "s",
      uuid: "u",
    };
    const cards = renderUserToolResult(
      state,
      parent as unknown as HTMLElement,
      ev,
      doc as unknown as Document,
    );
    expect(cards.length).toBe(2);
    expect(cards[0].getAttribute("data-tool-use-id")).toBe("toolu_x");
    expect(cards[1].getAttribute("data-tool-use-id")).toBe("toolu_y");
    expect(parent.children.length).toBe(2);
  });
});
