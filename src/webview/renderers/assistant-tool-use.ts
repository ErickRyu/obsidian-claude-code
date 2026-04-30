import type { AssistantEvent, ToolUseBlock } from "../parser/types";

/**
 * SH-02 / MH-03: basic assistant.tool_use card renderer.
 *
 * Each `tool_use` block inside an assistant message becomes a distinct card:
 * - Card root classes: `claude-wv-card` + `claude-wv-card--assistant-tool-use`.
 * - Root attributes: `data-tool-name="<Name>"` + `data-tool-use-id="<id>"` so
 *   downstream code (Edit/Write diff delegate, TodoWrite panel hoist,
 *   correlation with `user.tool_result` cards) can locate the card by stable id.
 * - Header `.claude-wv-tool-use-header` with `textContent = tool.name`.
 * - Input preview `.claude-wv-tool-use-input` (a `<pre>`) carrying
 *   `JSON.stringify(input, null, 2)` truncated at 4KB. `textContent` only —
 *   inputs may contain user-controlled strings, so this keeps the renderer
 *   injection-safe.
 *
 * Upsert discipline (tested by test/webview/render-tool-use-basic.test.ts):
 * - One card per `tool_use.id`. Re-emission with the same id reuses the card
 *   and replaces its children via `replaceChildren` only — direct DOM-mutation
 *   APIs are banned by the Phase 2 grep gate 2-5 on src/webview/renderers/.
 *
 * Returns the list of card elements rendered (or reused) from this single
 * assistant event — order follows the order of `tool_use` blocks in the
 * message content.
 */
export interface AssistantToolUseRenderState {
  readonly cards: Map<string, HTMLElement>;
}

export function createAssistantToolUseState(): AssistantToolUseRenderState {
  return { cards: new Map() };
}

export function renderAssistantToolUse(
  state: AssistantToolUseRenderState,
  parent: HTMLElement,
  event: AssistantEvent,
  doc: Document,
): HTMLElement[] {
  // TodoWrite is hoisted by `renderers/todo-panel.ts` into the layout's
  // side panel + a compact summary card. Edit/Write are rendered by
  // `renderers/edit-diff.ts` as a proper add/remove diff card. Emitting
  // the generic JSON preview here would double-render those tools and
  // bury the diff in raw input noise (2026-04-29 dogfood feedback —
  // "diff doesn't seem to work" was actually "diff is buried under
  // identical raw-JSON card with the same border color").
  const toolUseBlocks = event.message.content.filter(
    (block): block is ToolUseBlock =>
      block.type === "tool_use" &&
      block.name !== "TodoWrite" &&
      block.name !== "Edit" &&
      block.name !== "Write",
  );
  if (toolUseBlocks.length === 0) {
    return [];
  }

  const newCards: HTMLElement[] = [];
  const rendered: HTMLElement[] = [];
  for (const block of toolUseBlocks) {
    let card = state.cards.get(block.id) ?? null;
    const isNewCard = card === null;
    if (card === null) {
      card = doc.createElement("div");
      card.classList.add("claude-wv-card", "claude-wv-card--assistant-tool-use");
      card.setAttribute("data-tool-name", block.name);
      card.setAttribute("data-tool-use-id", block.id);
      // 2026-04-29 dogfood Issue #2 (tool-pending): default state is
      // "running" until a matching `user.tool_result` arrives. The CSS
      // attaches a pulsing dot to `[data-pending="true"]` so users see
      // long-running Bash / Read calls are in flight rather than stuck.
      // view.ts strips this attribute when the matching tool_result lands.
      card.setAttribute("data-pending", "true");
      state.cards.set(block.id, card);
    } else {
      // `data-tool-use-id` is the stable key; tool name could drift between
      // partial and final emissions. Refresh so selectors and tests see truth.
      card.setAttribute("data-tool-name", block.name);
    }

    // 2026-05-01 dogfood: collapse the JSON preview by default. The verbose
    // `<pre>` body buried the conversation; users only need the tool name +
    // a one-line summary at a glance and can expand on demand. The closed
    // <details> still carries the same `.claude-wv-tool-use-input` payload
    // so existing tests that probe the pre body via querySelector continue
    // to work.
    const details = doc.createElement("details");
    details.classList.add("claude-wv-tool-use-details");

    const summary = doc.createElement("summary");
    summary.classList.add("claude-wv-tool-use-summary");
    const nameEl = doc.createElement("span");
    nameEl.classList.add("claude-wv-tool-use-header");
    nameEl.textContent = block.name;
    const inputSummary = oneLineInputSummary(block.input);
    if (inputSummary.length > 0) {
      const sepEl = doc.createElement("span");
      sepEl.classList.add("claude-wv-tool-use-summary-sep");
      sepEl.textContent = " · ";
      const hintEl = doc.createElement("span");
      hintEl.classList.add("claude-wv-tool-use-summary-hint");
      hintEl.textContent = inputSummary;
      summary.replaceChildren(nameEl, sepEl, hintEl);
    } else {
      summary.replaceChildren(nameEl);
    }

    const preview = doc.createElement("pre");
    preview.classList.add("claude-wv-tool-use-input");
    preview.textContent = formatInputPreview(block.input);

    details.replaceChildren(summary, preview);
    card.replaceChildren(details);
    rendered.push(card);
    if (isNewCard) {
      newCards.push(card);
    }
  }

  if (newCards.length > 0) {
    // Attach new cards to parent using replaceChildren only — direct DOM-
    // mutation APIs are banned in src/webview/renderers/ by the Phase 2 grep
    // gate (2-5). Preserve existing parent order and place new cards last.
    const existingChildren = Array.from(parent.children);
    parent.replaceChildren(...existingChildren, ...newCards);
  }

  return rendered;
}

/**
 * One-line hint shown next to the tool name in the collapsed `<summary>`.
 * Picks the most identifying scalar field (file_path, command, pattern, url,
 * path, query, …) so the user can recognize the call without expanding.
 * Falls back to the empty string if no scalar field is present — the caller
 * then renders just the tool name.
 */
function oneLineInputSummary(input: Record<string, unknown>): string {
  const KEYS = [
    "file_path",
    "filePath",
    "path",
    "command",
    "pattern",
    "query",
    "url",
    "cwd",
    "subagent_type",
    "description",
  ];
  for (const key of KEYS) {
    const v = input[key];
    if (typeof v === "string" && v.length > 0) {
      return truncate(v, 80);
    }
  }
  return "";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/**
 * Render input JSON as a readable 2-space indented preview. Caps size so a
 * pathological Write payload (full-file content inlined) doesn't bloat the
 * card area. Never throws — circular refs or other serialization failures
 * fall back to a marker string rather than surfacing the exception.
 */
function formatInputPreview(input: Record<string, unknown>): string {
  try {
    const serialized = JSON.stringify(input, null, 2);
    if (typeof serialized !== "string") {
      return "[unserializable input]";
    }
    const MAX = 4096;
    if (serialized.length > MAX) {
      return serialized.slice(0, MAX) + "\n… (truncated)";
    }
    return serialized;
  } catch {
    return "[unserializable input]";
  }
}
