import type { UserEvent, TextBlock } from "../parser/types";

/**
 * 2026-04-29 dogfood Issue #2 — render the user's own text turns as cards.
 *
 * Before this renderer the UI silently dropped the text the user typed:
 * `view.ts:case "user"` only invoked `renderUserToolResult`, which filters
 * for `type === "tool_result"` blocks. Plain user prompts (`{type:"text"}`)
 * left zero on-screen evidence of what the user said — which destroys
 * "scroll-back-to-recall" UX in any conversation longer than two turns.
 *
 * Contract:
 * - Card root classes: `claude-wv-card` + `claude-wv-card--user-text`.
 * - Root attribute: `data-msg-id="<event.message.id>"` for upsert + tests.
 * - Body: a single `<div class="claude-wv-text-block">` per text block,
 *   `textContent = block.text`. No markdown rendering — raw text only,
 *   matching what the user typed in the input bar.
 *
 * Upsert: keyed by `message.id`. Same id re-emitted (stream-mode chunking)
 * replaces children via `replaceChildren` only — direct DOM-mutation APIs
 * are banned in `src/webview/renderers/` by the Phase 2 grep gate 2-5.
 *
 * Skips:
 * - `content` is a string → wrapped as a single text block.
 * - Array content with no `text` blocks (pure tool_result turn) → no-op.
 */
export interface UserTextRenderState {
  cards: Map<string, HTMLElement>;
}

export function createUserTextState(): UserTextRenderState {
  return { cards: new Map() };
}

export function renderUserText(
  state: UserTextRenderState,
  parent: HTMLElement,
  event: UserEvent,
  doc: Document,
): HTMLElement | null {
  const content = event.message.content;
  const texts: string[] = [];
  if (typeof content === "string") {
    if (content.length > 0) {
      texts.push(content);
    }
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "text") {
        const t = (block as TextBlock).text;
        if (typeof t === "string" && t.length > 0) {
          texts.push(t);
        }
      }
    }
  }
  if (texts.length === 0) {
    return null;
  }

  // UserMessage has no `id` field (unlike AssistantMessage). Compose a
  // stable key from session_id + uuid so duplicate stream-mode emissions
  // upsert the same card.
  const key = `${event.session_id ?? ""}|${event.uuid ?? ""}`;
  let card = state.cards.get(key) ?? null;
  const isNewCard = card === null;
  if (card === null) {
    card = doc.createElement("div");
    card.classList.add("claude-wv-card", "claude-wv-card--user-text");
    card.setAttribute("data-msg-id", key);
    state.cards.set(key, card);
  }

  const blocks: HTMLElement[] = texts.map((t) => {
    const div = doc.createElement("div");
    div.classList.add("claude-wv-text-block");
    div.textContent = t;
    return div;
  });
  card.replaceChildren(...blocks);

  if (isNewCard) {
    const existingChildren = Array.from(parent.children);
    parent.replaceChildren(...existingChildren, card);
  }
  return card;
}

/**
 * Client-side echo of the user's own prompt as a card.
 *
 * Stream-json's `user` event only carries `tool_result` blocks (verified
 * via fixtures + 2026-04-15 spike report) — the CLI never echoes the
 * text the user typed. So `renderUserText` above sees nothing for plain
 * prompts. Call `appendUserPrompt` from the input-bar's `ui.send` handler
 * to mount the user's text directly. Each call appends a fresh card
 * (no upsert — every prompt is its own card).
 */
export function appendUserPrompt(
  parent: HTMLElement,
  text: string,
  doc: Document,
): HTMLElement {
  const card = doc.createElement("div");
  card.classList.add("claude-wv-card", "claude-wv-card--user-text");
  card.setAttribute("data-prompt-source", "client-echo");
  const block = doc.createElement("div");
  block.classList.add("claude-wv-text-block");
  block.textContent = text;
  card.replaceChildren(block);
  const existingChildren = Array.from(parent.children);
  parent.replaceChildren(...existingChildren, card);
  return card;
}
