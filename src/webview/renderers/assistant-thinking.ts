import type { AssistantEvent, ThinkingBlock } from "../parser/types";

/**
 * SH-01: render assistant thinking blocks as a collapsible `<details>` card.
 *
 * Contract:
 * - Card root classes: `claude-wv-card` + `claude-wv-card--assistant-thinking`.
 * - Root attributes: `data-msg-id="<message.id>"` (upsert key),
 *   `data-signature="<thinking.signature>"` when present.
 * - Inside the card, a single `<details>` element wraps
 *   `<summary>Thinking</summary>` + `.claude-wv-thinking-body` whose
 *   `textContent` is the concatenated thinking text.
 * - `showThinking=true` → `<details open>`, otherwise collapsed. This is
 *   reflected on every re-render so that a settings toggle applied between
 *   emissions takes effect without requiring a view remount.
 * - Re-emission of the same `message.id` reuses the existing card and calls
 *   `replaceChildren` only — the Phase 2 grep gate (2-5, 4a-5) bans direct
 *   DOM-mutation APIs in this directory.
 * - Thinking text is rendered via `textContent` only. Never parse user or
 *   model strings as HTML (XSS hardening — tested by render-thinking.test.ts).
 * - Events with no thinking blocks return `null` and do NOT mutate `parent`
 *   or `state` (coexistence with assistant-text / assistant-tool-use, which
 *   handle their own block kinds on the same event).
 */
export interface AssistantThinkingRenderState {
  readonly cards: Map<string, HTMLElement>;
}

export interface AssistantThinkingRenderOptions {
  readonly showThinking: boolean;
}

export function createAssistantThinkingState(): AssistantThinkingRenderState {
  return { cards: new Map() };
}

export function renderAssistantThinking(
  state: AssistantThinkingRenderState,
  parent: HTMLElement,
  event: AssistantEvent,
  doc: Document,
  options: AssistantThinkingRenderOptions,
): HTMLElement | null {
  const thinkingBlocks = event.message.content.filter(
    (block): block is ThinkingBlock => block.type === "thinking",
  );
  if (thinkingBlocks.length === 0) {
    return null;
  }
  // 2026-04-29 dogfood: claude-opus-4-7 emits thinking blocks where
  // `thinking` is "" (likely redacted by the model). Rendering a blank
  // `▾ Thinking` card just confuses the user — skip until real content
  // arrives. The msg-id keyed state.cards entry stays absent so a later
  // re-emission with non-empty text still creates the card cleanly.
  const joinedText = thinkingBlocks
    .map((b) => (typeof b.thinking === "string" ? b.thinking : ""))
    .join("\n\n");
  if (joinedText.trim().length === 0) {
    return null;
  }

  const msgId = event.message.id;
  let card = state.cards.get(msgId) ?? null;
  const isNewCard = card === null;
  if (card === null) {
    card = doc.createElement("div");
    card.classList.add("claude-wv-card", "claude-wv-card--assistant-thinking");
    card.setAttribute("data-msg-id", msgId);
    state.cards.set(msgId, card);
  }

  const firstSignature = thinkingBlocks.find(
    (block) => typeof block.signature === "string" && block.signature.length > 0,
  )?.signature;
  if (typeof firstSignature === "string") {
    card.setAttribute("data-signature", firstSignature);
  }

  const details = doc.createElement("details");
  if (options.showThinking) {
    details.setAttribute("open", "");
  }

  const summary = doc.createElement("summary");
  summary.classList.add("claude-wv-thinking-summary");
  summary.textContent = "Thinking";

  const body = doc.createElement("div");
  body.classList.add("claude-wv-thinking-body");
  body.textContent = joinedText;

  details.replaceChildren(summary, body);
  card.replaceChildren(details);

  if (isNewCard) {
    const existingChildren = Array.from(parent.children);
    parent.replaceChildren(...existingChildren, card);
  }
  return card;
}
