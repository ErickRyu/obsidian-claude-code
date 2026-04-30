import type { AssistantEvent, ToolUseBlock } from "../parser/types";

/**
 * SH-03 / MH-09 pairing: renderer for TodoWrite `tool_use` blocks.
 *
 * TodoWrite blocks are split across two DOM regions:
 *
 *  - `todoSideEl` (the layout's `.claude-wv-todo-side`) — a persistent list
 *    of todos mirroring the latest payload for each `tool_use.id`. One
 *    `.claude-wv-todo-item--<status>` child per todo, plus a status chip
 *    and a textContent-only body so user-supplied content cannot inject
 *    HTML. The panel is grouped per tool_use.id so multi-step agent runs
 *    with several TodoWrite calls still render each as its own list.
 *  - `cardsEl` — a compact `.claude-wv-card--todo-summary` card that
 *    replaces the verbose JSON preview the basic `assistant-tool-use`
 *    renderer would otherwise emit. The summary reads
 *    `→ todos updated (N)` so a glance at the card stream tells the user
 *    *that* the todo list was updated without re-reading N todo bodies.
 *
 * Why this is a separate renderer path:
 *   The basic `assistant-tool-use` renderer must NOT render TodoWrite
 *   blocks (see its `name !== "TodoWrite"` filter). If both rendered,
 *   the card area would grow a JSON preview AND a summary per call,
 *   doubling scroll for every TodoWrite. The hoist is exclusive: the
 *   tool_use appears in the side panel + summary card, nowhere else.
 *
 * Upsert discipline:
 *   `state.cards` keys summary cards by `tool_use.id`; `state.panelWrappers`
 *   keys the side-panel wrappers by the same id. Re-emission of the same
 *   id (streaming partials, or re-tick during an agent loop) upserts via
 *   `replaceChildren` only — the Phase 2/4a grep gates (2-5 / 4a-5) ban
 *   direct DOM-mutation APIs in `src/webview/renderers/`.
 *
 * Input robustness:
 *   `block.input.todos` is typed `Record<string, unknown>` at parse time.
 *   The renderer defends against a malformed payload (non-array, missing
 *   required fields) without throwing — an unparseable payload renders
 *   a "todos updated (0)" summary + empty panel wrapper. Settings-file
 *   tampering or a partial-message fragment must never crash the view.
 */
export type TodoStatus = "pending" | "in_progress" | "completed";

interface TodoItem {
  readonly content: string;
  readonly status: TodoStatus;
}

export interface TodoPanelRenderState {
  /** Summary card keyed by tool_use.id — one card per TodoWrite call. */
  readonly cards: Map<string, HTMLElement>;
  /** Side-panel list wrapper keyed by tool_use.id. */
  readonly panelWrappers: Map<string, HTMLElement>;
}

export function createTodoPanelState(): TodoPanelRenderState {
  return { cards: new Map(), panelWrappers: new Map() };
}

export interface TodoPanelRenderResult {
  readonly summaryCards: HTMLElement[];
  readonly sidePanelItemCount: number;
}

export function renderTodoPanel(
  state: TodoPanelRenderState,
  cardsEl: HTMLElement,
  todoSideEl: HTMLElement,
  event: AssistantEvent,
  doc: Document,
): TodoPanelRenderResult {
  const todoBlocks = event.message.content.filter(
    (block): block is ToolUseBlock =>
      block.type === "tool_use" && block.name === "TodoWrite",
  );
  if (todoBlocks.length === 0) {
    return { summaryCards: [], sidePanelItemCount: countPanelItems(todoSideEl) };
  }

  const newCards: HTMLElement[] = [];
  const newWrappers: HTMLElement[] = [];
  const summaryCards: HTMLElement[] = [];

  for (const block of todoBlocks) {
    const todos = parseTodos(block.input);

    // ---- Summary card in cardsEl --------------------------------------
    let card = state.cards.get(block.id) ?? null;
    const isNewCard = card === null;
    if (card === null) {
      card = doc.createElement("div");
      card.classList.add("claude-wv-card", "claude-wv-card--todo-summary");
      card.setAttribute("data-tool-use-id", block.id);
      card.setAttribute("data-tool-name", "TodoWrite");
      state.cards.set(block.id, card);
    }
    const summaryText = `→ todos updated (${todos.length})`;
    const summaryBody = doc.createElement("div");
    summaryBody.classList.add("claude-wv-todo-summary-body");
    summaryBody.textContent = summaryText;
    card.replaceChildren(summaryBody);
    summaryCards.push(card);
    if (isNewCard) newCards.push(card);

    // ---- Side-panel wrapper in todoSideEl ------------------------------
    let wrapper = state.panelWrappers.get(block.id) ?? null;
    const isNewWrapper = wrapper === null;
    if (wrapper === null) {
      wrapper = doc.createElement("div");
      wrapper.classList.add("claude-wv-todo-panel");
      wrapper.setAttribute("data-tool-use-id", block.id);
      wrapper.setAttribute("role", "list");
      wrapper.setAttribute("aria-label", "Claude todos");
      state.panelWrappers.set(block.id, wrapper);
    }

    const itemNodes: HTMLElement[] = [];
    for (const todo of todos) {
      itemNodes.push(buildTodoItemNode(doc, todo));
    }
    wrapper.replaceChildren(...itemNodes);
    if (isNewWrapper) newWrappers.push(wrapper);
  }

  if (newCards.length > 0) {
    const existingCards = Array.from(cardsEl.children);
    cardsEl.replaceChildren(...existingCards, ...newCards);
  }
  if (newWrappers.length > 0) {
    const existingWrappers = Array.from(todoSideEl.children);
    todoSideEl.replaceChildren(...existingWrappers, ...newWrappers);
  }

  return {
    summaryCards,
    sidePanelItemCount: countPanelItems(todoSideEl),
  };
}

function buildTodoItemNode(doc: Document, todo: TodoItem): HTMLElement {
  const item = doc.createElement("div");
  item.classList.add("claude-wv-todo-item", `claude-wv-todo-item--${todo.status}`);
  item.setAttribute("role", "listitem");
  item.setAttribute("data-status", todo.status);

  const chip = doc.createElement("span");
  chip.classList.add("claude-wv-todo-status");
  chip.textContent = humanStatus(todo.status);

  const body = doc.createElement("span");
  body.classList.add("claude-wv-todo-content");
  body.textContent = todo.content;

  item.replaceChildren(chip, body);
  return item;
}

// `activeForm` is intentionally ignored here — parseTodos / TodoItem only
// keep the fields the side panel renders. If a future UX wants the
// "-ing" form shown on in_progress items, add it back to TodoItem here
// rather than re-parsing at the renderer.

function humanStatus(status: TodoStatus): string {
  switch (status) {
    case "pending":
      return "○";
    case "in_progress":
      return "◐";
    case "completed":
      return "●";
  }
}

function countPanelItems(todoSideEl: HTMLElement): number {
  return todoSideEl.querySelectorAll(".claude-wv-todo-item").length;
}

function parseTodos(input: Record<string, unknown>): TodoItem[] {
  const raw = input["todos"];
  if (!Array.isArray(raw)) return [];
  const result: TodoItem[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const content = readString(entry, "content");
    const status = readStatus(entry["status"]);
    if (content.length === 0) continue;
    result.push({ content, status });
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value : "";
}

function readStatus(value: unknown): TodoStatus {
  if (value === "in_progress" || value === "completed" || value === "pending") {
    return value;
  }
  return "pending";
}
