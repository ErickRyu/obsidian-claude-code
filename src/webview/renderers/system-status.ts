import type {
  SystemStatusEvent,
  SystemHookStartedEvent,
  SystemHookResponseEvent,
} from "../parser/types";

/**
 * Phase 5a — system.status + system.hook_* renderers.
 *
 * Two related responsibilities live in the same module because both consume
 * the `system.*` subtype family and share a single settings gate
 * (`showDebugSystemEvents`) when decisions escalate. Keeping them adjacent
 * avoids importing "system-hook-events.ts" from two places.
 *
 *   - `renderSystemStatus` owns a single `<div class="claude-wv-status-spinner">`
 *     attached to `headerEl`. A non-null `event.status` upserts; a `null`
 *     status removes. No card goes into `cardsEl` — the spinner is a
 *     header-level transient UI element.
 *   - `renderSystemHook` is a conditional card renderer for `hook_started` /
 *     `hook_response`. When `showDebug === false` the function is a no-op:
 *     the DOM truly does not contain the element (no `display:none` hidden-
 *     DOM shortcut — RALPH_PLAN.md 5a "Ralph 함정" #2 forbids that). When
 *     `showDebug === true` a collapsed `<details>` card with the raw JSON
 *     is emitted, upserted by event `uuid`.
 *
 * Both functions follow the Phase 2 grep gate: `createElement` +
 * `replaceChildren` only (no `appendChild` / `innerHTML`).
 */

// ---------- status spinner ----------

export interface SystemStatusRenderState {
  /** One-spinner-per-header invariant — tracked by its HTMLElement. */
  el: HTMLElement | null;
}

export function createSystemStatusState(): SystemStatusRenderState {
  return { el: null };
}

export function renderSystemStatus(
  state: SystemStatusRenderState,
  headerEl: HTMLElement,
  event: SystemStatusEvent,
  doc: Document,
): void {
  const status = event.status;
  if (status === null || (typeof status === "string" && status.length === 0)) {
    if (state.el !== null) {
      state.el.remove();
      state.el = null;
    }
    return;
  }

  let el = state.el;
  if (el === null) {
    el = doc.createElement("div");
    el.classList.add("claude-wv-status-spinner");
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    // Attach once — subsequent updates rewrite textContent / data-status.
    const children = Array.from(headerEl.children);
    headerEl.replaceChildren(...children, el);
    state.el = el;
  }
  el.setAttribute("data-status", slugifyStatus(status));
  // Label row keeps the human-readable status plus an inline "progress" dot
  // that the CSS animates. textContent assigned via two element children so
  // screen readers announce the label first, not the decoration.
  const dot = doc.createElement("span");
  dot.classList.add("claude-wv-status-dot");
  dot.setAttribute("aria-hidden", "true");
  // Use a three-char progress glyph — purely decorative.
  dot.textContent = "...";
  const label = doc.createElement("span");
  label.classList.add("claude-wv-status-label");
  label.textContent = status;
  el.replaceChildren(label, dot);
}

function slugifyStatus(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// ---------- hook_started / hook_response ----------

export interface SystemHookRenderState {
  /** uuid → card element for upsert discipline. */
  readonly cards: Map<string, HTMLElement>;
}

export function createSystemHookState(): SystemHookRenderState {
  return { cards: new Map() };
}

export interface SystemHookRenderOptions {
  readonly showDebug: boolean;
}

export function renderSystemHook(
  state: SystemHookRenderState,
  cardsEl: HTMLElement,
  event: SystemHookStartedEvent | SystemHookResponseEvent,
  doc: Document,
  options: SystemHookRenderOptions,
): void {
  if (!options.showDebug) {
    // MH-07: default-hidden. Do NOT create a hidden DOM node. If a previous
    // render left a card (debug toggle was flipped off), drop it from the
    // tree and the registry so re-enabling starts fresh.
    const existing = state.cards.get(event.uuid);
    if (existing) {
      existing.remove();
      state.cards.delete(event.uuid);
    }
    return;
  }

  let card = state.cards.get(event.uuid) ?? null;
  const isNewCard = card === null;
  if (card === null) {
    card = doc.createElement("div");
    card.classList.add("claude-wv-card", "claude-wv-card--system-hook");
    state.cards.set(event.uuid, card);
  }
  card.setAttribute("data-subtype", event.subtype);
  card.setAttribute("data-hook-event", event.hook_event);
  card.setAttribute("data-hook-name", event.hook_name);
  card.setAttribute("data-uuid", event.uuid);

  const details = doc.createElement("details");
  const summary = doc.createElement("summary");
  summary.textContent = `${event.subtype}: ${event.hook_name} (${event.hook_event})`;
  const pre = doc.createElement("pre");
  pre.classList.add("claude-wv-hook-json");
  try {
    pre.textContent = JSON.stringify(event, null, 2);
  } catch {
    pre.textContent = "[unserializable]";
  }
  details.replaceChildren(summary, pre);
  card.replaceChildren(details);

  if (isNewCard) {
    const existingChildren = Array.from(cardsEl.children);
    cardsEl.replaceChildren(...existingChildren, card);
  }
}
