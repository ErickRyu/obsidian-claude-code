import type { AssistantEvent, ToolUseBlock } from "../parser/types";
import {
  ensureActivityGroup,
  registerToolUseLine,
  type ActivityGroupRenderState,
} from "./activity-group";

/**
 * SH-02 / MH-03: assistant.tool_use line renderer (2026-05-01 dogfood —
 * activity-group mode).
 *
 * Each generic `tool_use` block (i.e. not Edit/Write/TodoWrite which have
 * dedicated diff and panel renderers) becomes a single one-line entry
 * inside an Activity group container card. The line is a thin
 * `<div class="claude-wv-tool-line">` carrying:
 *
 * - `data-tool-use-id="<id>"` — stable correlation key used by
 *   `user-tool-result.ts` to find the line that should host the result
 *   body, and by `view.ts` to flip `data-pending` to "false" when a
 *   matching tool_result arrives.
 * - `data-tool-name="<Name>"` — refreshed on each re-emission since the
 *   final `name` may differ from a partial stream emission.
 * - `data-pending="true"` until a tool_result lands.
 *
 * Body is a collapsed `<details>` with a one-line summary
 * (`Tool · file or command`) and the raw input JSON as a `<pre>` for
 * the user who wants to inspect arguments. The collapsed-by-default
 * pattern keeps the conversation column visually quiet — it was the
 * pre-grouping fix from v0.6.1 — and is preserved here even though the
 * outer card chrome has been removed in favour of the activity group.
 *
 * Upsert discipline: one line per `tool_use.id`. Re-emission with the
 * same id reuses the line element and replaces its children via
 * `replaceChildren` only — direct DOM-mutation APIs are banned by the
 * Phase 2 grep gate 2-5 on src/webview/renderers/.
 */
export interface AssistantToolUseRenderState {
  readonly cards: Map<string, HTMLElement>;
}

export function createAssistantToolUseState(): AssistantToolUseRenderState {
  return { cards: new Map() };
}

export function renderAssistantToolUse(
  state: AssistantToolUseRenderState,
  groupState: ActivityGroupRenderState,
  parent: HTMLElement,
  event: AssistantEvent,
  doc: Document,
): HTMLElement[] {
  // TodoWrite is hoisted by `renderers/todo-panel.ts` into the layout's
  // side panel + a compact summary card. Edit/Write are rendered by
  // `renderers/edit-diff.ts` as a proper add/remove diff card. Emitting
  // generic lines here would double-render those tools.
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

  const rendered: HTMLElement[] = [];
  for (const block of toolUseBlocks) {
    let line = state.cards.get(block.id) ?? null;
    const isNew = line === null;

    if (line === null) {
      line = doc.createElement("div");
      line.classList.add("claude-wv-tool-line");
      line.setAttribute("data-tool-name", block.name);
      line.setAttribute("data-tool-use-id", block.id);
      // 2026-04-29 dogfood Issue #2 (tool-pending): default state is
      // "running" until a matching `user.tool_result` arrives. The CSS
      // attaches a pulsing dot to `[data-pending="true"]` so users see
      // long-running Bash / Read calls are in flight rather than stuck.
      line.setAttribute("data-pending", "true");
      state.cards.set(block.id, line);
    } else {
      // `data-tool-use-id` is the stable key; tool name could drift between
      // partial and final emissions. Refresh so selectors and tests see truth.
      line.setAttribute("data-tool-name", block.name);
    }

    // Build the line body as a collapsed-by-default <details>, summary
    // first then the input preview <pre>. Status chip slot is part of
    // the summary so user-tool-result.ts can stamp it without rebuilding
    // the entire summary tree later.
    const details = doc.createElement("details");
    details.classList.add("claude-wv-tool-line-details");

    const summary = doc.createElement("summary");
    summary.classList.add("claude-wv-tool-line-summary");
    const nameEl = doc.createElement("span");
    nameEl.classList.add("claude-wv-tool-line-name");
    nameEl.textContent = block.name;
    const inputSummary = oneLineInputSummary(block.input);
    const summaryChildren: Node[] = [nameEl];
    if (inputSummary.length > 0) {
      const sepEl = doc.createElement("span");
      sepEl.classList.add("claude-wv-tool-line-sep");
      sepEl.textContent = " · ";
      const hintEl = doc.createElement("span");
      hintEl.classList.add("claude-wv-tool-line-hint");
      hintEl.textContent = inputSummary;
      summaryChildren.push(sepEl, hintEl);
    }
    // Status chip stays empty until a tool_result arrives. The slot
    // exists from the start so user-tool-result.ts only needs to swap
    // its textContent + class — no re-creation, no layout shift.
    const statusEl = doc.createElement("span");
    statusEl.classList.add("claude-wv-tool-line-status");
    summaryChildren.push(statusEl);
    summary.replaceChildren(...summaryChildren);

    const preview = doc.createElement("pre");
    preview.classList.add("claude-wv-tool-use-input");
    preview.textContent = formatInputPreview(block.input);

    details.replaceChildren(summary, preview);
    line.replaceChildren(details);

    if (isNew) {
      // Activity group is created lazily on the first generic line of a
      // turn, then reused for subsequent lines until the dispatcher
      // closes it (assistant text / Edit/Write / Todo / new user turn).
      ensureActivityGroup(groupState, parent, doc);
      registerToolUseLine(groupState, block.id, line);
    }

    rendered.push(line);
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
 * line area. Never throws — circular refs or other serialization failures
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
