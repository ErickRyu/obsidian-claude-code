/**
 * Phase 5a Task 6 (SH-04) — compact-boundary renderer.
 *
 * Runtime contract:
 *   - `renderCompactBoundary(state, cardsEl, event, doc)` appends a card
 *     `.claude-wv-card--compact-boundary` to `cardsEl` upserted by
 *     `session_id|uuid`.
 *   - Card textContent includes:
 *       (a) the word "compacted" (human divider signal), AND
 *       (b) the pre_tokens → post_tokens token pair in `<pre>→<post>` form
 *           when `compact_metadata` is present, AND
 *       (c) the duration_ms suffix "Nms" when present.
 *   - `role="separator"` is set so AT tools announce it as a divider.
 *   - `data-session-id` / `data-uuid` attributes are attached for downstream
 *     test differentiation.
 *   - When `compact_metadata` is absent the card still renders with the
 *     "compacted" text but no token / duration suffix — a defensive path
 *     in case the CLI ever elides the metadata block.
 */
import { describe, it, expect } from "vitest";
import { Window } from "happy-dom";
import path from "node:path";
import { replayFixture } from "./helpers/fixture-replay";
import {
  createCompactBoundaryState,
  renderCompactBoundary,
} from "../../src/webview/renderers/compact-boundary";
import type {
  StreamEvent,
  SystemCompactBoundaryEvent,
} from "../../src/webview/parser/types";

const FIXTURE_DIR = path.resolve(__dirname, "..", "fixtures", "stream-json");

function makeCards(): { doc: Document; cardsEl: HTMLElement } {
  const { document } = new Window();
  const doc = document as unknown as Document;
  const cardsEl = doc.createElement("div");
  cardsEl.className = "claude-wv-cards";
  (doc.body as unknown as HTMLElement).replaceChildren(cardsEl);
  return { doc, cardsEl };
}

function findBoundary(events: StreamEvent[]): SystemCompactBoundaryEvent {
  const hit = events.find(
    (e): e is SystemCompactBoundaryEvent =>
      e.type === "system" && e.subtype === "compact_boundary",
  );
  if (!hit) throw new Error("fixture lacks compact_boundary");
  return hit;
}

describe("renderCompactBoundary (SH-04)", () => {
  it("slash-compact.jsonl replay yields a single compact-boundary card whose textContent carries 'compacted', pre→post tokens, and duration", () => {
    const replay = replayFixture(
      path.join(FIXTURE_DIR, "slash-compact.jsonl"),
    );
    const boundary = findBoundary(replay.events);
    const { doc, cardsEl } = makeCards();
    const state = createCompactBoundaryState();
    renderCompactBoundary(state, cardsEl, boundary, doc);

    const cards = cardsEl.querySelectorAll(".claude-wv-card--compact-boundary");
    expect(cards.length).toBe(1);
    const card = cards[0] as unknown as HTMLElement;
    const text = (card.textContent ?? "").toLowerCase();
    expect(text).toContain("compacted");
    // Fixture values — `pre_tokens: 1601`, `post_tokens: 3632`, `duration_ms: 13428`.
    expect(card.textContent ?? "").toContain("1601");
    expect(card.textContent ?? "").toContain("3632");
    expect(card.textContent ?? "").toContain("13428ms");
    expect(card.getAttribute("role")).toBe("separator");
    expect(card.getAttribute("data-session-id")).toBe(boundary.session_id);
  });

  it("re-rendering the same event upserts in place (single card, no duplicates)", () => {
    const replay = replayFixture(
      path.join(FIXTURE_DIR, "slash-compact.jsonl"),
    );
    const boundary = findBoundary(replay.events);
    const { doc, cardsEl } = makeCards();
    const state = createCompactBoundaryState();
    renderCompactBoundary(state, cardsEl, boundary, doc);
    renderCompactBoundary(state, cardsEl, boundary, doc);
    expect(
      cardsEl.querySelectorAll(".claude-wv-card--compact-boundary").length,
    ).toBe(1);
  });

  it("missing compact_metadata still renders the divider card with the 'compacted' label and no token suffix", () => {
    const { doc, cardsEl } = makeCards();
    const state = createCompactBoundaryState();
    const ev: SystemCompactBoundaryEvent = {
      type: "system",
      subtype: "compact_boundary",
      session_id: "deadbeef-0000-0000-0000-000000000000",
      uuid: "cafebabe-0000-0000-0000-000000000000",
    };
    renderCompactBoundary(state, cardsEl, ev, doc);
    const card = cardsEl.querySelector(
      ".claude-wv-card--compact-boundary",
    ) as unknown as HTMLElement;
    expect(card).not.toBeNull();
    const text = (card.textContent ?? "").toLowerCase();
    expect(text).toContain("compacted");
    // No token pair when metadata is absent.
    expect(card.textContent ?? "").not.toMatch(/\d+→\d+/);
  });

  it("two distinct boundary events (different uuid) produce two separate cards", () => {
    const { doc, cardsEl } = makeCards();
    const state = createCompactBoundaryState();
    const base: SystemCompactBoundaryEvent = {
      type: "system",
      subtype: "compact_boundary",
      session_id: "deadbeef-0000-0000-0000-000000000000",
      uuid: "aaaa1111-0000-0000-0000-000000000000",
      compact_metadata: { pre_tokens: 10, post_tokens: 5, duration_ms: 100 },
    };
    const second: SystemCompactBoundaryEvent = {
      ...base,
      uuid: "bbbb2222-0000-0000-0000-000000000000",
      compact_metadata: { pre_tokens: 20, post_tokens: 7, duration_ms: 200 },
    };
    renderCompactBoundary(state, cardsEl, base, doc);
    renderCompactBoundary(state, cardsEl, second, doc);
    expect(
      cardsEl.querySelectorAll(".claude-wv-card--compact-boundary").length,
    ).toBe(2);
  });
});
