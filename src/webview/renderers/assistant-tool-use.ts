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
  cards: Map<string, HTMLElement>;
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
  const toolUseBlocks = event.message.content.filter(
    (block): block is ToolUseBlock => block.type === "tool_use",
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
      state.cards.set(block.id, card);
    } else {
      // `data-tool-use-id` is the stable key; tool name could drift between
      // partial and final emissions. Refresh so selectors and tests see truth.
      card.setAttribute("data-tool-name", block.name);
    }

    const header = doc.createElement("div");
    header.classList.add("claude-wv-tool-use-header");
    header.textContent = block.name;

    const preview = doc.createElement("pre");
    preview.classList.add("claude-wv-tool-use-input");
    preview.textContent = formatInputPreview(block.input);

    card.replaceChildren(header, preview);
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
