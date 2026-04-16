import type { AssistantEvent } from "../parser/types";

/**
 * SH-01 / MH-02: render (or upsert) an assistant message's text blocks into a
 * card element.
 *
 * Contract (tested by test/webview/render-hello.test.ts and
 * test/webview/render-duplicate-msg-id.test.ts):
 * - Card root classes: `claude-wv-card` + `claude-wv-card--assistant-text`.
 * - Root attribute: `data-msg-id="<message.id>"` (upsert key).
 * - Each text block becomes a `.claude-wv-text-block` child element whose
 *   content is set via `textContent` (never via HTML string assignment).
 * - Same `message.id` → reuse the existing card and replace its children via
 *   `replaceChildren` only — no direct DOM-mutation APIs are permitted
 *   (the Phase 2 grep gate 2-5 enforces this statically). This guarantees
 *   that partial → finalized re-emissions from
 *   `claude -p --output-format=stream-json` collapse into a single card
 *   showing only the latest text (no duplicated text blocks).
 * - Events with no text blocks (e.g. pure tool_use or thinking-only updates)
 *   return `null` and do NOT mutate `parent` or `state`.
 */
export interface AssistantTextRenderState {
  cards: Map<string, HTMLElement>;
}

export function createAssistantTextState(): AssistantTextRenderState {
  return { cards: new Map() };
}

export function renderAssistantText(
  state: AssistantTextRenderState,
  parent: HTMLElement,
  event: AssistantEvent,
  doc: Document,
): HTMLElement | null {
  const textBlocks = event.message.content.filter(
    (block): block is { type: "text"; text: string } => block.type === "text",
  );
  if (textBlocks.length === 0) {
    return null;
  }

  const msgId = event.message.id;
  let card = state.cards.get(msgId) ?? null;
  const isNewCard = card === null;
  if (card === null) {
    card = doc.createElement("div");
    card.classList.add("claude-wv-card", "claude-wv-card--assistant-text");
    card.setAttribute("data-msg-id", msgId);
    state.cards.set(msgId, card);
  }

  const children: HTMLElement[] = [];
  for (const block of textBlocks) {
    const blockEl = doc.createElement("div");
    blockEl.classList.add("claude-wv-text-block");
    blockEl.textContent = block.text;
    children.push(blockEl);
  }
  card.replaceChildren(...children);

  if (isNewCard) {
    // Attach to parent using replaceChildren only — direct DOM-mutation
    // APIs are banned in src/webview/renderers/ by the Phase 2 grep gate
    // (2-5). Preserve existing parent order and place the new card last.
    const existingChildren = Array.from(parent.children);
    parent.replaceChildren(...existingChildren, card);
  }
  return card;
}
