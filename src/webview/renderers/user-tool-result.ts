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
    // 2026-05-01 dogfood: TodoWrite emits a `tool_result` like
    // "Todos have been modified successfully" for every successful update.
    // The TodoWrite summary card already conveys "todos updated (N)" + the
    // strip shows the live state, so the success message is pure noise.
    // Suppress it; errors still render so the user sees what failed.
    if (block.is_error !== true && isTodoWriteToolUseId(parent, block.tool_use_id)) {
      const stale = state.cards.get(block.tool_use_id);
      if (stale) {
        stale.remove();
        state.cards.delete(block.tool_use_id);
      }
      continue;
    }

    let card = state.cards.get(block.tool_use_id) ?? null;
    const isNewCard = card === null;
    if (card === null) {
      card = doc.createElement("div");
      card.classList.add("claude-wv-card", "claude-wv-card--user-tool-result");
      card.setAttribute("data-tool-use-id", block.tool_use_id);
      state.cards.set(block.tool_use_id, card);
    }
    const isError = block.is_error === true;
    if (isError) {
      card.setAttribute("data-is-error", "true");
    } else {
      card.removeAttribute("data-is-error");
    }

    const bodyChildren = renderResultBody(block, doc);

    // 2026-05-01 dogfood: collapse result bodies by default. Long Read /
    // Bash outputs dominated the conversation column. Errors stay open so
    // the user can react immediately; success bodies are one click away.
    const details = doc.createElement("details");
    details.classList.add("claude-wv-tool-result-details");
    if (isError) details.open = true;
    const summary = doc.createElement("summary");
    summary.classList.add("claude-wv-tool-result-summary");
    summary.textContent = oneLineResultSummary(block, isError);
    details.replaceChildren(summary, ...bodyChildren);
    card.replaceChildren(details);

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

function isTodoWriteToolUseId(parent: HTMLElement, toolUseId: string): boolean {
  // CSS.escape isn't available in every test env (jsdom older builds); use a
  // conservative whitelist check instead. tool_use_id is set by the CLI and
  // matches /^[A-Za-z0-9_-]+$/ in practice (Anthropic message IDs).
  if (!/^[A-Za-z0-9_-]+$/.test(toolUseId)) return false;
  const selector = `.claude-wv-card--todo-summary[data-tool-use-id="${toolUseId}"]`;
  return parent.querySelector(selector) !== null;
}

function oneLineResultSummary(block: ToolResultBlock, isError: boolean): string {
  const flat = flattenResultText(block);
  if (flat.length === 0) {
    return isError ? "(error)" : "(empty)";
  }
  const firstLine = flat.split(/\r?\n/, 1)[0] ?? "";
  const trimmed = firstLine.trim();
  if (trimmed.length === 0) {
    return isError ? "(error)" : "(empty)";
  }
  const max = 80;
  const head = trimmed.length <= max ? trimmed : trimmed.slice(0, max - 1) + "…";
  return isError ? `error: ${head}` : head;
}

function flattenResultText(block: ToolResultBlock): string {
  if (typeof block.content === "string") return block.content;
  const parts: string[] = [];
  for (const sub of block.content) {
    if (sub.type === "text") {
      parts.push((sub as TextBlock).text);
    } else if (sub.type === "image") {
      parts.push("[image]");
    }
  }
  return parts.join("\n");
}

function renderResultBody(block: ToolResultBlock, doc: Document): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (typeof block.content === "string") {
    out.push(...renderTextBody(block.content, block.is_error === true, doc));
    return out;
  }
  // Array content — iterate blocks.
  for (const sub of block.content) {
    if (sub.type === "text") {
      out.push(
        ...renderTextBody((sub as TextBlock).text, block.is_error === true, doc),
      );
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

/**
 * 2026-04-29 dogfood: Anthropic's tool error blocks arrive wrapped in
 * `<tool_use_error>...</tool_use_error>` literal tags inside the text
 * content. Strip the wrapper and surface a friendly "Tool denied" header
 * instead of the raw XML-ish form so users get a meaningful error
 * presentation rather than reading prompt-engineering plumbing.
 */
function renderTextBody(
  raw: string,
  isError: boolean,
  doc: Document,
): HTMLElement[] {
  const out: HTMLElement[] = [];
  const trimmed = raw.trim();
  const tag = "tool_use_error";
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const isWrapped =
    trimmed.startsWith(open) && trimmed.endsWith(close);
  if (isError && isWrapped) {
    const inner = trimmed.slice(open.length, trimmed.length - close.length).trim();
    const header = doc.createElement("div");
    header.classList.add("claude-wv-tool-result-error-header");
    header.textContent = "Tool denied";
    const body = doc.createElement("pre");
    body.classList.add("claude-wv-tool-result-body");
    body.textContent = inner;
    out.push(header, body);
    return out;
  }
  const pre = doc.createElement("pre");
  pre.classList.add("claude-wv-tool-result-body");
  pre.textContent = raw;
  out.push(pre);
  return out;
}
