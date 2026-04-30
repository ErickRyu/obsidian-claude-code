/**
 * SH-03 / 4b-4 / 4b-5: TodoWrite side-panel hoist + summary card contract.
 *
 * `renderTodoPanel` owns two distinct DOM regions for TodoWrite `tool_use`
 * blocks:
 *
 *   (a) `todoSideEl` (from `ui/layout.ts`) holds a live list of todo items
 *       — one child per todo with a status class and `textContent` carrying
 *       the todo's `content`. Re-emission of the same `tool_use.id` upserts
 *       the list in place (no duplication).
 *   (b) `cardsEl` receives a compact summary card instead of the verbose
 *       `assistant-tool-use` JSON preview. The summary card's `textContent`
 *       includes the literal "todos updated" plus the count, so the 4b-5 gate
 *       and the user see the same string.
 *
 * The renderer short-circuits on non-TodoWrite tool_use blocks so
 * `assistant-tool-use.ts` can keep handling Bash / Glob / generic tools
 * without double-rendering.
 */
import { describe, it, expect } from "vitest";
import { Window } from "happy-dom";
import path from "node:path";
import { replayFixture } from "./helpers/fixture-replay";
import {
  createTodoPanelState,
  renderTodoPanel,
} from "../../src/webview/renderers/todo-panel";
import type { AssistantEvent } from "../../src/webview/parser/types";

const TODO_FIXTURE = path.resolve(
  __dirname,
  "..",
  "fixtures",
  "stream-json",
  "todo.jsonl",
);

function todoEvent(
  msgId: string,
  toolId: string,
  todos: Array<{ content: string; status: string; activeForm: string }>,
): AssistantEvent {
  return {
    type: "assistant",
    message: {
      id: msgId,
      type: "message",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: toolId,
          name: "TodoWrite",
          input: { todos },
        },
      ],
    },
    session_id: "test",
    uuid: "u-" + toolId,
  };
}

function setupDom(): {
  doc: Document;
  cardsEl: HTMLElement;
  sideEl: HTMLElement;
} {
  const { document: doc } = new Window();
  const cardsEl = doc.createElement("div");
  cardsEl.classList.add("claude-wv-cards");
  const sideEl = doc.createElement("div");
  sideEl.classList.add("claude-wv-todo-side");
  doc.body.replaceChildren(
    cardsEl as unknown as Node,
    sideEl as unknown as Node,
  );
  return {
    doc: doc as unknown as Document,
    cardsEl: cardsEl as unknown as HTMLElement,
    sideEl: sideEl as unknown as HTMLElement,
  };
}

describe("render-todo-panel (SH-03, 4b-4 / 4b-5)", () => {
  it("hoists TodoWrite todos into todoSideEl (N items, statuses preserved)", () => {
    const { doc, cardsEl, sideEl } = setupDom();
    const state = createTodoPanelState();
    const ev = todoEvent("msg_1", "toolu_todo_1", [
      { content: "Set up scaffold", status: "pending", activeForm: "Setting up scaffold" },
      { content: "Add persistence", status: "in_progress", activeForm: "Adding persistence" },
      { content: "Write tests", status: "completed", activeForm: "Writing tests" },
    ]);

    renderTodoPanel(state, cardsEl, sideEl, ev, doc);

    const items = sideEl.querySelectorAll(".claude-wv-todo-item");
    expect(items.length).toBe(3);
    expect(items[0].textContent).toContain("Set up scaffold");
    expect(items[1].textContent).toContain("Add persistence");
    expect(items[2].textContent).toContain("Write tests");

    expect(items[0].classList.contains("claude-wv-todo-item--pending")).toBe(true);
    expect(items[1].classList.contains("claude-wv-todo-item--in_progress")).toBe(true);
    expect(items[2].classList.contains("claude-wv-todo-item--completed")).toBe(true);
  });

  it("emits a compact summary card in cardsEl with 'todos updated (N)' textContent (4b-5)", () => {
    const { doc, cardsEl, sideEl } = setupDom();
    const state = createTodoPanelState();
    const ev = todoEvent("msg_1", "toolu_todo_sum", [
      { content: "A", status: "pending", activeForm: "A-ing" },
      { content: "B", status: "pending", activeForm: "B-ing" },
    ]);

    renderTodoPanel(state, cardsEl, sideEl, ev, doc);

    const summaryCards = cardsEl.querySelectorAll(
      ".claude-wv-card--todo-summary",
    );
    expect(summaryCards.length).toBe(1);
    const text = (summaryCards[0].textContent ?? "").trim();
    expect(text).toContain("todos updated");
    expect(text).toContain("2");
    // The card must NOT dump the full todos JSON — it is a summary.
    expect(text).not.toContain("activeForm");
    expect(text).not.toContain('"status"');
  });

  it("upserts the side panel list by tool_use.id (re-emit does not duplicate items)", () => {
    const { doc, cardsEl, sideEl } = setupDom();
    const state = createTodoPanelState();

    const first = todoEvent("msg_1", "toolu_todo_upsert", [
      { content: "A", status: "pending", activeForm: "A-ing" },
      { content: "B", status: "pending", activeForm: "B-ing" },
    ]);
    renderTodoPanel(state, cardsEl, sideEl, first, doc);

    const second = todoEvent("msg_1", "toolu_todo_upsert", [
      { content: "A", status: "completed", activeForm: "A-ing" },
      { content: "B", status: "in_progress", activeForm: "B-ing" },
      { content: "C", status: "pending", activeForm: "C-ing" },
    ]);
    renderTodoPanel(state, cardsEl, sideEl, second, doc);

    const items = sideEl.querySelectorAll(".claude-wv-todo-item");
    expect(items.length).toBe(3);
    expect(items[0].classList.contains("claude-wv-todo-item--completed")).toBe(true);
    expect(items[1].classList.contains("claude-wv-todo-item--in_progress")).toBe(true);
    expect(items[2].classList.contains("claude-wv-todo-item--pending")).toBe(true);

    // Summary card stays a single card, count reflects the latest payload.
    const summary = cardsEl.querySelectorAll(".claude-wv-card--todo-summary");
    expect(summary.length).toBe(1);
    expect((summary[0].textContent ?? "").trim()).toContain("3");
  });

  it("is a no-op for events that do not include any TodoWrite tool_use block", () => {
    const { doc, cardsEl, sideEl } = setupDom();
    const state = createTodoPanelState();
    const ev: AssistantEvent = {
      type: "assistant",
      message: {
        id: "msg_generic",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_bash_1",
            name: "Bash",
            input: { command: "ls" },
          },
        ],
      },
      session_id: "test",
      uuid: "u-bash",
    };

    renderTodoPanel(state, cardsEl, sideEl, ev, doc);

    expect(sideEl.children.length).toBe(0);
    expect(cardsEl.querySelectorAll(".claude-wv-card--todo-summary").length).toBe(0);
  });

  it("hoists todos from the real todo.jsonl fixture (replay, 4b-4 contract)", () => {
    const { doc, cardsEl, sideEl } = setupDom();
    const state = createTodoPanelState();
    const { events } = replayFixture(TODO_FIXTURE);

    for (const event of events) {
      if (event.type === "assistant") {
        renderTodoPanel(state, cardsEl, sideEl, event, doc);
      }
    }

    const items = sideEl.querySelectorAll(".claude-wv-todo-item");
    // The fixture captures one TodoWrite tool_use with exactly 3 todos.
    expect(items.length).toBeGreaterThanOrEqual(3);

    const summary = cardsEl.querySelectorAll(".claude-wv-card--todo-summary");
    expect(summary.length).toBe(1);
    const text = (summary[0].textContent ?? "").trim();
    expect(text).toContain("todos updated");
  });

  it("tolerates malformed input (missing todos array) without throwing", () => {
    const { doc, cardsEl, sideEl } = setupDom();
    const state = createTodoPanelState();
    const ev: AssistantEvent = {
      type: "assistant",
      message: {
        id: "msg_bad",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_todo_bad",
            name: "TodoWrite",
            input: { todos: "not-an-array" as unknown as never[] },
          },
        ],
      },
      session_id: "test",
      uuid: "u-bad",
    };

    expect(() => renderTodoPanel(state, cardsEl, sideEl, ev, doc)).not.toThrow();
    expect(sideEl.querySelectorAll(".claude-wv-todo-item").length).toBe(0);
    const summary = cardsEl.querySelectorAll(".claude-wv-card--todo-summary");
    expect(summary.length).toBe(1);
    expect((summary[0].textContent ?? "").trim()).toContain("0");
  });

  it("cross-renderer exclusivity: TodoWrite does not leak into the generic assistant-tool-use renderer", async () => {
    const { doc, cardsEl, sideEl } = setupDom();
    const { createAssistantToolUseState, renderAssistantToolUse } = await import(
      "../../src/webview/renderers/assistant-tool-use"
    );
    const todoState = createTodoPanelState();
    const toolUseState = createAssistantToolUseState();
    const ev = todoEvent("msg_excl", "toolu_exclusive", [
      { content: "Task A", status: "pending", activeForm: "A-ing" },
    ]);

    renderAssistantToolUse(toolUseState, cardsEl, ev, doc);
    renderTodoPanel(todoState, cardsEl, sideEl, ev, doc);

    // The generic tool_use card must NOT appear for TodoWrite — that's the
    // whole point of the filter in assistant-tool-use.ts. If a regression
    // removes the filter, this assertion fails before the Phase 2 card-
    // kinds suite would notice.
    expect(
      cardsEl.querySelectorAll(".claude-wv-card--assistant-tool-use").length,
    ).toBe(0);
    expect(
      cardsEl.querySelectorAll(".claude-wv-card--todo-summary").length,
    ).toBe(1);
    const sameIdInBoth = cardsEl.querySelectorAll(
      '[data-tool-use-id="toolu_exclusive"]',
    );
    expect(sameIdInBoth.length).toBe(1);
    expect(
      sameIdInBoth[0].classList.contains("claude-wv-card--todo-summary"),
    ).toBe(true);
  });

  it("textContent only — no HTML injection from todo content (XSS defense)", () => {
    const { doc, cardsEl, sideEl } = setupDom();
    const state = createTodoPanelState();
    const ev = todoEvent("msg_xss", "toolu_xss", [
      {
        content: '<script>alert("xss")</script>evil',
        status: "pending",
        activeForm: "Being bad",
      },
    ]);

    renderTodoPanel(state, cardsEl, sideEl, ev, doc);

    const items = sideEl.querySelectorAll(".claude-wv-todo-item");
    expect(items.length).toBe(1);
    const scripts = sideEl.querySelectorAll("script");
    expect(scripts.length).toBe(0);
    expect(items[0].textContent).toContain('<script>alert("xss")</script>evil');
  });
});
