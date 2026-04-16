import type { UserEvent, ToolResultBlock, TextBlock } from "../parser/types";

/**
 * MH-04: render a user event's `tool_result` blocks as cards, correlated back
 * to the originating `assistant.tool_use` via `tool_use_id`.
 *
 * Contract (tested by test/webview/render-user-tool-result.test.ts):
 * - Card root classes: `claude-wv-card` + `claude-wv-card--user-tool-result`.
 * - Root attributes:
 *     - `data-tool-use-id="<tool_use_id>"` — stable correlation key. Downstream
 *       code uses this to pair the result card with the upstream
 *       `.claude-wv-card--assistant-tool-use[data-tool-use-id="…"]` card.
 *     - `data-is-error="true"` iff the tool_result block has `is_error === true`.
 * - Body:
 *     - `content: string` → single `<pre class="claude-wv-tool-result-body">`
 *       with `textContent = content`.
 *     - `content: Array<TextBlock | ToolResultBlockImage>` → iterate; each
 *       `text` block becomes a `<pre class="claude-wv-tool-result-body">` with
 *       that block's text; each `image` block becomes a placeholder
 *       `<div class="claude-wv-tool-result-image">` marker (images are not
 *       rendered inline in the beta — see constraint "no external telemetry").
 *
 * Upsert discipline: one card per `tool_use_id`. Re-emission reuses the card
 * and replaces its children via `replaceChildren` only — direct DOM-mutation
 * APIs are banned in `src/webview/renderers/` by the Phase 2 grep gate 2-5.
 *
 * Events with no tool_result blocks (e.g. plain user text turns) return an
 * empty array and do not mutate `parent` or `state`.
 */
export interface UserToolResultRenderState {
  cards: Map<string, HTMLElement>;
}

export function createUserToolResultState(): UserToolResultRenderState {
  return { cards: new Map() };
}

export function renderUserToolResult(
  state: UserToolResultRenderState,
  parent: HTMLElement,
  event: UserEvent,
  doc: Document,
): HTMLElement[] {
  const content = event.message.content;
  if (typeof content === "string" || !Array.isArray(content)) {
    // Plain-string user message turns (no tool_result blocks) are not our
    // concern — returning [] keeps parent/state untouched.
    return [];
  }

  const toolResultBlocks = content.filter(
    (block): block is ToolResultBlock => block.type === "tool_result",
  );
  if (toolResultBlocks.length === 0) {
    return [];
  }

  const newCards: HTMLElement[] = [];
  const rendered: HTMLElement[] = [];
  for (const block of toolResultBlocks) {
    let card = state.cards.get(block.tool_use_id) ?? null;
    const isNewCard = card === null;
    if (card === null) {
      card = doc.createElement("div");
      card.classList.add("claude-wv-card", "claude-wv-card--user-tool-result");
      card.setAttribute("data-tool-use-id", block.tool_use_id);
      state.cards.set(block.tool_use_id, card);
    }
    if (block.is_error === true) {
      card.setAttribute("data-is-error", "true");
    } else {
      card.removeAttribute("data-is-error");
    }

    const bodyChildren = renderResultBody(block, doc);
    card.replaceChildren(...bodyChildren);

    rendered.push(card);
    if (isNewCard) {
      newCards.push(card);
    }
  }

  if (newCards.length > 0) {
    const existingChildren = Array.from(parent.children);
    parent.replaceChildren(...existingChildren, ...newCards);
  }

  return rendered;
}

function renderResultBody(block: ToolResultBlock, doc: Document): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (typeof block.content === "string") {
    const pre = doc.createElement("pre");
    pre.classList.add("claude-wv-tool-result-body");
    pre.textContent = block.content;
    out.push(pre);
    return out;
  }
  // Array content — iterate blocks.
  for (const sub of block.content) {
    if (sub.type === "text") {
      const pre = doc.createElement("pre");
      pre.classList.add("claude-wv-tool-result-body");
      pre.textContent = (sub as TextBlock).text;
      out.push(pre);
    } else if (sub.type === "image") {
      // Image placeholder — we do not decode/render image sources inline in
      // the beta to keep the renderer injection-safe and dependency-free.
      const marker = doc.createElement("div");
      marker.classList.add("claude-wv-tool-result-image");
      marker.textContent = "[image omitted]";
      out.push(marker);
    }
  }
  return out;
}
