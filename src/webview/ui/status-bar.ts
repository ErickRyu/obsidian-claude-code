import type { ResultEvent } from "../parser/types";

/**
 * Phase 5a Task 4 (SH-06) — status bar.
 *
 * A persistent row of badges showing the model, token totals, context
 * window usage percentage, and turn cost. The source of truth is
 * `ResultEvent.modelUsage[<model>]` — NOT `assistant.usage` and NOT
 * `result.usage`. `result.modelUsage` is the CLI's reconciled per-turn
 * tally; the assistant-style `usage` field is the SDK's running counter
 * and can disagree (e.g. partial-messages streaming). The status bar
 * must always mirror `modelUsage` so the numbers the user sees match
 * what `claude -p` reports at the end of the turn.
 *
 * Contract:
 *   - `buildStatusBar(root, doc)` returns `{ el, update }`. `el` is the
 *     container element appended under `root`.
 *   - `update(event)` reads `event.modelUsage[model]` where `model` is
 *     the first key of `modelUsage`. Updates the four badges in place —
 *     textContent-only, no appendChild.
 *   - Empty `modelUsage` → all badges render `"-"` except cost, which
 *     falls back to `total_cost_usd` when per-model `costUSD` is absent.
 *   - Each badge carries `data-kind="tokens|ctx|cost|model"` so tests
 *     can target without relying on visual order.
 */
export interface StatusBarHandle {
  readonly el: HTMLElement;
  update(event: ResultEvent): void;
}

const BADGE_KINDS = ["model", "tokens", "ctx", "cost"] as const;
type BadgeKind = (typeof BADGE_KINDS)[number];

interface ModelUsageEntry {
  readonly inputTokens?: unknown;
  readonly outputTokens?: unknown;
  readonly contextWindow?: unknown;
  readonly costUSD?: unknown;
}

export function buildStatusBar(root: HTMLElement, doc: Document): StatusBarHandle {
  const el = doc.createElement("div");
  el.classList.add("claude-wv-status-bar");
  el.setAttribute("role", "status");
  el.setAttribute("aria-label", "Claude session status");

  const badges = new Map<BadgeKind, HTMLElement>();
  const children: HTMLElement[] = [];
  for (const kind of BADGE_KINDS) {
    const badge = doc.createElement("span");
    badge.classList.add("claude-wv-status-badge", `claude-wv-status-badge--${kind}`);
    badge.setAttribute("data-kind", kind);
    badge.textContent = "-";
    badges.set(kind, badge);
    children.push(badge);
  }
  el.replaceChildren(...children);

  const rootChildren = Array.from(root.children);
  root.replaceChildren(...rootChildren, el);

  function setBadge(kind: BadgeKind, value: string): void {
    const badge = badges.get(kind);
    if (badge) badge.textContent = value;
  }

  function update(event: ResultEvent): void {
    const usage = extractModelUsage(event.modelUsage);
    setBadge("model", usage?.model ?? "-");
    setBadge("tokens", usage ? String(usage.tokens) : "-");
    setBadge(
      "ctx",
      usage && usage.contextWindow > 0
        ? `${Math.max(1, Math.round((usage.tokens / usage.contextWindow) * 100))}%`
        : "-",
    );
    const cost = usage?.costUSD ?? event.total_cost_usd;
    setBadge(
      "cost",
      typeof cost === "number" && Number.isFinite(cost)
        ? `$${cost.toFixed(4)}`
        : "-",
    );
  }

  return { el, update };
}

interface ExtractedUsage {
  readonly model: string;
  readonly tokens: number;
  readonly contextWindow: number;
  readonly costUSD: number | null;
}

function extractModelUsage(
  modelUsage: Record<string, unknown> | undefined,
): ExtractedUsage | null {
  if (!modelUsage) return null;
  const keys = Object.keys(modelUsage);
  if (keys.length === 0) return null;
  // Beta policy (MED-1 from Phase 5a review): when a turn spans multiple
  // models the status bar surfaces the FIRST key only. `claude -p` in the
  // stream-json fixtures observed so far always emits a single key, but
  // the CLI may expand to multi-model usage later. When that happens, the
  // UI will need a model-selection affordance — tracked for Phase 6+.
  const model = keys[0];
  const entry = modelUsage[model];
  if (!isRecord(entry)) return null;
  const u = entry as ModelUsageEntry;
  const inp = toFiniteNumber(u.inputTokens);
  const out = toFiniteNumber(u.outputTokens);
  const ctx = toFiniteNumber(u.contextWindow);
  const cost = toFiniteNumber(u.costUSD);
  if (inp === null || out === null) return null;
  return {
    model,
    tokens: inp + out,
    contextWindow: ctx ?? 0,
    costUSD: cost,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toFiniteNumber(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
}
