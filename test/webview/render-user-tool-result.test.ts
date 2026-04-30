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

  it("wraps the body in a closed <details> for success and opens it for errors (2026-05-01 dogfood)", () => {
    const window = new Window();
    const doc = window.document;
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);
    const state = createUserToolResultState();

    const okEv = toolResultEvent("toolu_ok", "Hello world\nsecond line");
    renderUserToolResult(
      state,
      parent as unknown as HTMLElement,
      okEv,
      doc as unknown as Document,
    );
    const okCard = state.cards.get("toolu_ok");
    const okDetails = okCard?.querySelector("details.claude-wv-tool-result-details") as HTMLDetailsElement | null;
    expect(okDetails).not.toBeNull();
    expect(okDetails?.open).toBe(false);
    expect(okDetails?.querySelector("summary")?.textContent).toContain("Hello world");
    // Body remains accessible inside the details for downstream selectors.
    expect(okDetails?.querySelector(".claude-wv-tool-result-body")).not.toBeNull();

    const errState = createUserToolResultState();
    const errParent = doc.createElement("div");
    doc.body.appendChild(errParent);
    const errEv = toolResultEvent("toolu_err2", "boom", true);
    renderUserToolResult(
      errState,
      errParent as unknown as HTMLElement,
      errEv,
      doc as unknown as Document,
    );
    const errCard = errState.cards.get("toolu_err2");
    const errDetails = errCard?.querySelector("details.claude-wv-tool-result-details") as HTMLDetailsElement | null;
    expect(errDetails).not.toBeNull();
    expect(errDetails?.open).toBe(true);
  });

  it("suppresses TodoWrite tool_result when matching summary card is present (2026-05-01 dogfood)", () => {
    const window = new Window();
    const doc = window.document;
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);
    const state = createUserToolResultState();

    // Stage a fake TodoWrite summary card with matching tool_use_id, the same
    // way renderTodoPanel would.
    const summaryCard = doc.createElement("div");
    summaryCard.classList.add("claude-wv-card", "claude-wv-card--todo-summary");
    summaryCard.setAttribute("data-tool-use-id", "toolu_todo_1");
    summaryCard.setAttribute("data-tool-name", "TodoWrite");
    parent.appendChild(summaryCard);

    const ev = toolResultEvent("toolu_todo_1", "Todos have been modified successfully");
    const cards = renderUserToolResult(
      state,
      parent as unknown as HTMLElement,
      ev,
      doc as unknown as Document,
    );

    expect(cards).toEqual([]);
    expect(state.cards.has("toolu_todo_1")).toBe(false);
    // The original summary card is untouched; no new tool-result card was added.
    expect(parent.querySelectorAll(".claude-wv-card--user-tool-result").length).toBe(0);
    expect(parent.children.length).toBe(1);
  });

  it("renders TodoWrite tool_result when it is an error (do not hide failures)", () => {
    const window = new Window();
    const doc = window.document;
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);
    const state = createUserToolResultState();

    const summaryCard = doc.createElement("div");
    summaryCard.classList.add("claude-wv-card", "claude-wv-card--todo-summary");
    summaryCard.setAttribute("data-tool-use-id", "toolu_todo_err");
    parent.appendChild(summaryCard);

    const ev = toolResultEvent("toolu_todo_err", "todo write failed", true);
    const cards = renderUserToolResult(
      state,
      parent as unknown as HTMLElement,
      ev,
      doc as unknown as Document,
    );
    expect(cards.length).toBe(1);
    expect(cards[0].getAttribute("data-is-error")).toBe("true");
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
