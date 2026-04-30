import type { ResultEvent } from "../parser/types";

/**
 * MH-05: render a `result` event as a card summarizing the turn's outcome —
 * subtype, duration, token usage, and total cost.
 *
 * Contract (tested by test/webview/render-result.test.ts):
 * - Card root classes: `claude-wv-card` + `claude-wv-card--result`.
 * - Root attributes:
 *     - `data-session-id="<result.session_id>"`
 *     - `data-subtype="<result.subtype>"`
 *     - `data-is-error="true"` iff `result.is_error === true`.
 * - Body: five labeled rows rendered as `<div class="claude-wv-result-row">`
 *   children, each containing a `.claude-wv-result-key` + `.claude-wv-result-value`:
 *     1. subtype  (e.g. "success", "error")
 *     2. duration (duration_ms as "<N>ms", or "-" if missing)
 *     3. cost     (total_cost_usd formatted as "$<fixed(4)>", or "-")
 *     4. tokens   ("<input>/<output>" from usage.input_tokens / output_tokens,
 *                  or "-" when either field is absent or non-numeric)
 *     5. turns    (num_turns or "-")
 *
 * Upsert discipline: one card per `session_id` + `uuid` compound key. Real
 * `claude -p` emits at most one `result` per session but partial-messages mode
 * may re-emit; keyed upsert + `replaceChildren` keeps the card stable.
 *
 * Direct DOM-mutation APIs are banned in `src/webview/renderers/` by the
 * Phase 2 grep gate 2-5 — we only use `doc.createElement` + `replaceChildren`.
 */
export interface ResultRenderState {
  cards: Map<string, HTMLElement>;
}

export function createResultState(): ResultRenderState {
  return { cards: new Map() };
}

export function renderResult(
  state: ResultRenderState,
  parent: HTMLElement,
  event: ResultEvent,
  doc: Document,
): HTMLElement {
  const key = cardKey(event);
  let card = state.cards.get(key) ?? null;
  const isNewCard = card === null;
  if (card === null) {
    card = doc.createElement("div");
    card.classList.add("claude-wv-card", "claude-wv-card--result");
    state.cards.set(key, card);
  }
  card.setAttribute("data-session-id", event.session_id);
  card.setAttribute("data-subtype", event.subtype);
  if (event.is_error === true) {
    card.setAttribute("data-is-error", "true");
  } else {
    card.removeAttribute("data-is-error");
  }

  const rows: HTMLElement[] = [
    buildRow(doc, "subtype", event.subtype),
    buildRow(doc, "duration", formatDuration(event.duration_ms)),
    buildRow(doc, "cost", formatCost(event.total_cost_usd)),
    buildRow(doc, "tokens", formatTokens(event.usage)),
    buildRow(doc, "turns", formatNumber(event.num_turns)),
  ];
  // Phase 5a — surface `result.result` as a friendly "message" row when the
  // CLI attached a human-readable string (e.g. slash-mcp's "Unknown command:
  // /mcp"). Absent / empty → row omitted so legacy fixture assertions that
  // expect five rows continue to pass.
  if (typeof event.result === "string" && event.result.length > 0) {
    rows.push(buildRow(doc, "message", event.result));
  }
  // 2026-04-29 dogfood (Issue #3): wrap the metadata rows in a collapsed
  // `<details>` so a one-line summary ("✓ 2.1s · $0.39 · 39 tokens") is
  // the default presentation; users can click to expand for the full
  // subtype/duration/cost/tokens/turns/message rows. The previous flat
  // 5-row card created visual noise for every turn — debug-grade content
  // bleeding into the conversation flow.
  const details = doc.createElement("details");
  details.classList.add("claude-wv-result-details");
  const summary = doc.createElement("summary");
  summary.classList.add("claude-wv-result-summary");
  summary.textContent = formatSummary(event);
  const body = doc.createElement("div");
  body.classList.add("claude-wv-result-body");
  body.replaceChildren(...rows);
  details.replaceChildren(summary, body);
  card.replaceChildren(details);

  if (isNewCard) {
    const existingChildren = Array.from(parent.children);
    parent.replaceChildren(...existingChildren, card);
  }
  return card;
}

function cardKey(event: ResultEvent): string {
  // `uuid` is per-event; `session_id` groups turns. Compound key keeps cards
  // stable when partial-messages mode re-emits the result for the same turn.
  return `${event.session_id}|${event.uuid}`;
}

function buildRow(doc: Document, key: string, value: string): HTMLElement {
  const row = doc.createElement("div");
  row.classList.add("claude-wv-result-row");
  const keyEl = doc.createElement("span");
  keyEl.classList.add("claude-wv-result-key");
  keyEl.textContent = key;
  const valueEl = doc.createElement("span");
  valueEl.classList.add("claude-wv-result-value");
  valueEl.textContent = value;
  row.replaceChildren(keyEl, valueEl);
  return row;
}

function formatDuration(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "-";
  return `${ms}ms`;
}

function formatCost(usd: number | undefined): string {
  if (typeof usd !== "number" || !Number.isFinite(usd)) return "-";
  return `$${usd.toFixed(4)}`;
}

function formatNumber(n: number | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "-";
  return String(n);
}

function formatTokens(usage: Record<string, unknown> | undefined): string {
  if (!usage) return "-";
  const inp = usage.input_tokens;
  const out = usage.output_tokens;
  if (typeof inp !== "number" || !Number.isFinite(inp)) return "-";
  if (typeof out !== "number" || !Number.isFinite(out)) return "-";
  return `${inp}/${out}`;
}

/**
 * 2026-04-29 dogfood Issue #3 — single-line summary for the collapsed
 * result `<details>`. Format examples:
 *   ✓ 2.1s · $0.394 · 6/39 tokens
 *   ✗ failed · 1.2s · $0.012
 * Falls back to "—" placeholders for fields the CLI omitted.
 */
function formatSummary(event: ResultEvent): string {
  const icon = event.is_error === true ? "✗" : "✓";
  const subtype = event.is_error === true ? "failed" : event.subtype;
  const parts: string[] = [`${icon} ${subtype}`];
  if (typeof event.duration_ms === "number" && Number.isFinite(event.duration_ms)) {
    const seconds = event.duration_ms / 1000;
    parts.push(seconds < 1 ? `${event.duration_ms}ms` : `${seconds.toFixed(1)}s`);
  }
  if (typeof event.total_cost_usd === "number" && Number.isFinite(event.total_cost_usd)) {
    parts.push(`$${event.total_cost_usd.toFixed(4)}`);
  }
  const tokensRow = formatTokens(event.usage);
  if (tokensRow !== "-") {
    parts.push(`${tokensRow} tokens`);
  }
  return parts.join(" · ");
}
