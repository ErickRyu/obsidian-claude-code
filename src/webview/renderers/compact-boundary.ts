import type { SystemCompactBoundaryEvent } from "../parser/types";

/**
 * Phase 5a Task 2 (SH-04) — compact-boundary divider card.
 *
 * The `system.compact_boundary` event marks a `/compact` reset in the
 * middle of a session. The card functions as a visual divider with a
 * human label ("Conversation compacted · pre→post tokens · Nms") so the
 * user sees where the context was truncated.
 *
 * Contract:
 *   - Card root: `.claude-wv-card` + `.claude-wv-card--compact-boundary`.
 *   - `role="separator"` so assistive tech announces it as a divider.
 *   - `data-session-id` + `data-uuid` for differentiation.
 *   - textContent MUST include the literal "compacted" token and, when
 *     `compact_metadata` is present, the "pre→post" token pair and the
 *     duration_ms suffix.
 *   - Upsert by `session_id|uuid`: the CLI emits at most one boundary
 *     event per /compact, but we still key by uuid so fixture replays
 *     or future retries cannot duplicate.
 *   - No `appendChild` / `innerHTML` — Phase 2 gate 2-5 / 4a-5 still apply.
 */
export interface CompactBoundaryRenderState {
  readonly cards: Map<string, HTMLElement>;
}

export function createCompactBoundaryState(): CompactBoundaryRenderState {
  return { cards: new Map() };
}

export function renderCompactBoundary(
  state: CompactBoundaryRenderState,
  parent: HTMLElement,
  event: SystemCompactBoundaryEvent,
  doc: Document,
): HTMLElement {
  const key = `${event.session_id}|${event.uuid}`;
  let card = state.cards.get(key) ?? null;
  const isNewCard = card === null;
  if (card === null) {
    card = doc.createElement("div");
    card.classList.add(
      "claude-wv-card",
      "claude-wv-card--compact-boundary",
    );
    card.setAttribute("role", "separator");
    state.cards.set(key, card);
  }
  card.setAttribute("data-session-id", event.session_id);
  card.setAttribute("data-uuid", event.uuid);

  const rule = doc.createElement("hr");
  rule.classList.add("claude-wv-compact-rule");
  rule.setAttribute("aria-hidden", "true");

  const label = doc.createElement("div");
  label.classList.add("claude-wv-compact-label");
  label.textContent = buildLabel(event);

  card.replaceChildren(rule, label);

  if (isNewCard) {
    const existingChildren = Array.from(parent.children);
    parent.replaceChildren(...existingChildren, card);
  }
  return card;
}

function buildLabel(event: SystemCompactBoundaryEvent): string {
  const meta = event.compact_metadata;
  const base = "Conversation compacted";
  if (!meta) return base;
  const parts: string[] = [base];
  if (
    typeof meta.pre_tokens === "number" &&
    Number.isFinite(meta.pre_tokens) &&
    typeof meta.post_tokens === "number" &&
    Number.isFinite(meta.post_tokens)
  ) {
    parts.push(`${meta.pre_tokens}→${meta.post_tokens} tokens`);
  }
  if (typeof meta.duration_ms === "number" && Number.isFinite(meta.duration_ms)) {
    parts.push(`${meta.duration_ms}ms`);
  }
  return parts.join(" · ");
}
