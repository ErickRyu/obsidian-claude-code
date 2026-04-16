import type { SystemInitEvent } from "../parser/types";

/**
 * MH-06: render the `system:init` event as a header card — the first thing the
 * user sees when a new `claude -p` session starts. Shows model, permission
 * mode, mcp_servers count, cwd, session_id.
 *
 * Contract (tested by test/webview/render-system-init.test.ts):
 * - Card root classes: `claude-wv-card` + `claude-wv-card--system-init`.
 * - Root attribute: `data-session-id="<session_id>"` (stable upsert key).
 * - Body: labeled rows using the same `.claude-wv-kv-row` shape as
 *   `renderers/result.ts` so downstream CSS can share styles:
 *     1. model          (or "-" if missing)
 *     2. permission     (permissionMode, or "-")
 *     3. mcp_servers    ("N connected/M total" or just "0" when empty)
 *     4. cwd            (or "-" when missing)
 *     5. session        (session_id — truncated to 8 chars + "…" for density)
 *
 * Upsert discipline: one card per `session_id`. Real sessions emit exactly
 * one init event, but resumed sessions / fixture replays can re-emit; keyed
 * upsert + `replaceChildren` keeps the header stable.
 *
 * Direct DOM-mutation APIs are banned in `src/webview/renderers/` by the
 * Phase 2 grep gate 2-5 — we only use `doc.createElement` + `replaceChildren`.
 */
export interface SystemInitRenderState {
  cards: Map<string, HTMLElement>;
}

export function createSystemInitState(): SystemInitRenderState {
  return { cards: new Map() };
}

export function renderSystemInit(
  state: SystemInitRenderState,
  parent: HTMLElement,
  event: SystemInitEvent,
  doc: Document,
): HTMLElement {
  const sessionId = event.session_id;
  let card = state.cards.get(sessionId) ?? null;
  const isNewCard = card === null;
  if (card === null) {
    card = doc.createElement("div");
    card.classList.add("claude-wv-card", "claude-wv-card--system-init");
    card.setAttribute("data-session-id", sessionId);
    state.cards.set(sessionId, card);
  }

  const rows: HTMLElement[] = [
    buildRow(doc, "model", event.model ?? "-"),
    buildRow(doc, "permission", event.permissionMode ?? "-"),
    buildRow(doc, "mcp_servers", formatMcpServers(event.mcp_servers)),
    buildRow(doc, "cwd", event.cwd ?? "-"),
    buildRow(doc, "session", formatSessionId(sessionId)),
  ];
  card.replaceChildren(...rows);

  if (isNewCard) {
    const existingChildren = Array.from(parent.children);
    parent.replaceChildren(...existingChildren, card);
  }
  return card;
}

function buildRow(doc: Document, key: string, value: string): HTMLElement {
  const row = doc.createElement("div");
  row.classList.add("claude-wv-kv-row");
  const keyEl = doc.createElement("span");
  keyEl.classList.add("claude-wv-kv-key");
  keyEl.textContent = key;
  const valueEl = doc.createElement("span");
  valueEl.classList.add("claude-wv-kv-value");
  valueEl.textContent = value;
  row.replaceChildren(keyEl, valueEl);
  return row;
}

function formatMcpServers(
  servers: Array<{ name: string; status: string }> | undefined,
): string {
  if (!servers || servers.length === 0) return "0";
  const connected = servers.filter((s) => s.status === "connected").length;
  return `${connected} connected / ${servers.length} total`;
}

function formatSessionId(sessionId: string): string {
  if (sessionId.length <= 8) return sessionId;
  return sessionId.slice(0, 8) + "…";
}
