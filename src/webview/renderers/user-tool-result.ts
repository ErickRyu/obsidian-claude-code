import type { UserEvent, ToolResultBlock, TextBlock } from "../parser/types";
import {
  findToolLine,
  setLineError,
  setLinePending,
  type ActivityGroupRenderState,
} from "./activity-group";

/**
 * MH-04 (2026-05-01 dogfood — activity-group line mode): render a user
 * event's `tool_result` blocks by attaching their bodies into the matching
 * `claude-wv-tool-line` (created by `assistant-tool-use.ts`) inside the
 * Activity group. No standalone result card is created in the green path —
 * one tool round-trip = one visual unit.
 *
 * Behaviour:
 * - For each `tool_result` block:
 *   - If its `tool_use_id` matches a line registered in the active group,
 *     update that line's `data-pending` to "false", swap the status chip
 *     to `✓` (success) or `✗` (error), and append the result body
 *     (`<pre class="claude-wv-tool-result-body">` for text content, plus
 *     a `<div class="claude-wv-tool-result-image">` placeholder for image
 *     blocks) into the line's collapsed `<details>`. Errors auto-open
 *     the line's `<details>` only — the group container stays collapsed
 *     so the compaction goal isn't defeated by a single failure. The
 *     header surfaces the failure via the `N error(s)` chip.
 *   - If no matching line exists (orphan result, e.g. result arrives
 *     after the activity group has been closed by an interleaved assistant
 *     text), fall back to creating a standalone `claude-wv-card--user-tool-result`
 *     card so the data is never lost.
 * - TodoWrite suppress: when a matching `claude-wv-card--todo-summary`
 *   exists in `parent` for this `tool_use_id`, suppress the success
 *   message ("Todos have been modified successfully") since the side
 *   panel already conveys the live state. Errors still render.
 *
 * Returns the list of line elements (or fallback cards) updated/created
 * by this event, in block order.
 */
export interface UserToolResultRenderState {
  cards: Map<string, HTMLElement>;
}

export function createUserToolResultState(): UserToolResultRenderState {
  return { cards: new Map() };
}

export function renderUserToolResult(
  state: UserToolResultRenderState,
  groupState: ActivityGroupRenderState,
  parent: HTMLElement,
  event: UserEvent,
  doc: Document,
): HTMLElement[] {
  const content = event.message.content;
  if (typeof content === "string" || !Array.isArray(content)) {
    return [];
  }

  const toolResultBlocks = content.filter(
    (block): block is ToolResultBlock => block.type === "tool_result",
  );
  if (toolResultBlocks.length === 0) {
    return [];
  }

  const updated: HTMLElement[] = [];
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

    const line = findToolLine(groupState, block.tool_use_id);
    const isError = block.is_error === true;

    if (line !== null) {
      attachResultToLine(line, block, isError, doc);
      setLinePending(groupState, block.tool_use_id, false);
      setLineError(groupState, block.tool_use_id, isError);
      updated.push(line);
      continue;
    }

    // Fallback: orphan result with no matching line in the active group.
    // This happens if the group was closed (e.g. by an interleaved
    // assistant text) before the result arrived. Render a standalone
    // card so the data is never lost.
    const card = renderFallbackCard(state, parent, block, isError, doc);
    updated.push(card);
  }

  return updated;
}

function attachResultToLine(
  line: HTMLElement,
  block: ToolResultBlock,
  isError: boolean,
  doc: Document,
): void {
  // Update status chip in the line's summary
  const statusEl = line.querySelector(".claude-wv-tool-line-status");
  if (statusEl) {
    statusEl.textContent = isError ? "✗" : "✓";
    statusEl.classList.toggle("claude-wv-tool-line-status--error", isError);
    statusEl.classList.toggle("claude-wv-tool-line-status--ok", !isError);
  }

  // Append result body inside the line's <details>, after the existing
  // input preview. We rebuild the details children to avoid stacking up
  // multiple result bodies on re-emission.
  const details = line.querySelector("details.claude-wv-tool-line-details") as
    | HTMLDetailsElement
    | null;
  if (details === null) return;

  const summary = details.querySelector("summary.claude-wv-tool-line-summary");
  const inputPreview = details.querySelector(".claude-wv-tool-use-input");
  const bodyChildren = renderResultBody(block, doc);

  // Optional separator between input and result so the visual chunks read clearly.
  const sep = doc.createElement("div");
  sep.classList.add("claude-wv-tool-line-sep-line");

  const newChildren: Node[] = [];
  if (summary) newChildren.push(summary);
  if (inputPreview) newChildren.push(inputPreview);
  if (bodyChildren.length > 0) {
    newChildren.push(sep, ...bodyChildren);
  }
  details.replaceChildren(...newChildren);

  if (isError) {
    details.open = true;
  }
}

function renderFallbackCard(
  state: UserToolResultRenderState,
  parent: HTMLElement,
  block: ToolResultBlock,
  isError: boolean,
  doc: Document,
): HTMLElement {
  let card = state.cards.get(block.tool_use_id) ?? null;
  const isNew = card === null;
  if (card === null) {
    card = doc.createElement("div");
    card.classList.add("claude-wv-card", "claude-wv-card--user-tool-result");
    card.setAttribute("data-tool-use-id", block.tool_use_id);
    state.cards.set(block.tool_use_id, card);
  }
  if (isError) {
    card.setAttribute("data-is-error", "true");
  } else {
    card.removeAttribute("data-is-error");
  }

  const bodyChildren = renderResultBody(block, doc);

  const details = doc.createElement("details");
  details.classList.add("claude-wv-tool-result-details");
  if (isError) details.open = true;
  const summary = doc.createElement("summary");
  summary.classList.add("claude-wv-tool-result-summary");
  summary.textContent = oneLineResultSummary(block, isError);
  details.replaceChildren(summary, ...bodyChildren);
  card.replaceChildren(details);

  if (isNew) {
    const existing = Array.from(parent.children);
    parent.replaceChildren(...existing, card);
  }
  return card;
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
  for (const sub of block.content) {
    if (sub.type === "text") {
      out.push(
        ...renderTextBody((sub as TextBlock).text, block.is_error === true, doc),
      );
    } else if (sub.type === "image") {
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
