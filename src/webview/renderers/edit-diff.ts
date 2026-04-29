import type { AssistantEvent, ToolUseBlock } from "../parser/types";

/**
 * SH-02: render Edit / Write tool_use blocks as a replace-style diff card.
 *
 * The card is rendered in addition to — not a replacement for — the basic
 * `assistant-tool-use` card. The basic card keeps the raw input JSON visible
 * for power users; the diff card on top of it reframes the mutation as a
 * line-oriented add/remove pair that matches how most diff viewers surface
 * an `Edit` tool_use (old block removed, new block added).
 *
 * Why block-replace and not LCS:
 *   The `Edit` tool's contract is "replace `old_string` with `new_string`",
 *   so the semantically correct presentation shows *every* line of
 *   `old_string` as removed and *every* line of `new_string` as added —
 *   even when one is a prefix of the other. A line-LCS would suppress the
 *   "remove" entries in such cases, leaving the user staring at an add-only
 *   diff that looks like the old content was untouched. The `4a-1` gate in
 *   RALPH_PLAN.md requires `diffRemovedCount >= 1 && diffAddedCount >= 1`
 *   for `edit.jsonl`, which block-replacement satisfies naturally.
 *
 * Contract (tested by test/webview/render-edit-diff.test.ts):
 * - Card root classes: `claude-wv-card` + `claude-wv-card--edit-diff`.
 * - Root attributes: `data-tool-name="<Edit|Write>"` and
 *   `data-tool-use-id="<block.id>"`.
 * - Header `.claude-wv-edit-diff-path` with `textContent = <file_path>`.
 * - A `<pre class="claude-wv-diff-body">` wraps per-line wrappers
 *   `<span class="claude-wv-diff-line">` whose single inner span carries one
 *   of `claude-wv-diff-add` (for `new_string` / `Write` content), or
 *   `claude-wv-diff-remove` (for `old_string`). Each inner span's
 *   `textContent` is prefixed with `+` or `-` respectively and every line
 *   ends with a newline via a text node so the `<pre>` renders cleanly.
 * - Non-Edit/Write tool names return `[]` — the basic tool_use renderer
 *   continues to handle them.
 * - Re-emission of the same `tool_use.id` upserts the card in place via
 *   `replaceChildren` (the grep gate 2-5 / 4a-5 bans direct DOM-mutation
 *   APIs in this directory).
 * - All textual payload enters the DOM via `textContent` only. The card is
 *   XSS-safe even if `new_string` contains HTML fragments (tested).
 */
export interface EditDiffRenderState {
  readonly cards: Map<string, HTMLElement>;
}

export function createEditDiffState(): EditDiffRenderState {
  return { cards: new Map() };
}

export function renderEditDiff(
  state: EditDiffRenderState,
  parent: HTMLElement,
  event: AssistantEvent,
  doc: Document,
): HTMLElement[] {
  const targetBlocks = event.message.content.filter(
    (block): block is ToolUseBlock =>
      block.type === "tool_use" && (block.name === "Edit" || block.name === "Write"),
  );
  if (targetBlocks.length === 0) {
    return [];
  }

  const newCards: HTMLElement[] = [];
  const rendered: HTMLElement[] = [];
  for (const block of targetBlocks) {
    const input = block.input;
    const filePath = readString(input, "file_path");
    const removeLines =
      block.name === "Write" ? [] : splitLines(readString(input, "old_string"));
    const addLines =
      block.name === "Write"
        ? splitLines(readString(input, "content"))
        : splitLines(readString(input, "new_string"));

    let card = state.cards.get(block.id) ?? null;
    const isNewCard = card === null;
    if (card === null) {
      card = doc.createElement("div");
      card.classList.add("claude-wv-card", "claude-wv-card--edit-diff");
      card.setAttribute("data-tool-use-id", block.id);
      // Tool-pending spinner — same contract as assistant-tool-use cards.
      // view.ts strips this when the matching user.tool_result lands.
      card.setAttribute("data-pending", "true");
      state.cards.set(block.id, card);
    }
    card.setAttribute("data-tool-name", block.name);

    const pathEl = doc.createElement("div");
    pathEl.classList.add("claude-wv-edit-diff-path");
    pathEl.textContent = filePath;

    const body = doc.createElement("pre");
    body.classList.add("claude-wv-diff-body");

    const lineNodes: HTMLElement[] = [];
    for (const line of removeLines) {
      lineNodes.push(buildDiffLine(doc, "remove", line));
    }
    for (const line of addLines) {
      lineNodes.push(buildDiffLine(doc, "add", line));
    }
    body.replaceChildren(...lineNodes);
    card.replaceChildren(pathEl, body);

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

function buildDiffLine(
  doc: Document,
  kind: "add" | "remove",
  text: string,
): HTMLElement {
  const wrapper = doc.createElement("span");
  wrapper.classList.add("claude-wv-diff-line");
  const inner = doc.createElement("span");
  if (kind === "add") {
    inner.classList.add("claude-wv-diff-add");
    inner.textContent = "+" + text;
  } else {
    inner.classList.add("claude-wv-diff-remove");
    inner.textContent = "-" + text;
  }
  const newline = doc.createTextNode("\n");
  wrapper.replaceChildren(inner, newline);
  return wrapper;
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const normalized = text.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n");
  // A trailing newline produces an empty final element — return a new
  // array without it so the diff doesn't show a phantom trailing blank.
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    return parts.slice(0, -1);
  }
  return parts;
}

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value : "";
}
