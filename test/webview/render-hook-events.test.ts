/**
 * Phase 5a Task 8 — hook_started / hook_response event rendering (MH-07).
 *
 * Runtime contract:
 *   - `renderSystemHook(state, cardsEl, event, doc, { showDebug })` is the
 *     only entry point. `showDebug=false` is the production default — the
 *     renderer MUST NOT append any element to `cardsEl` in that case
 *     (no `display:none` hidden-DOM shortcut — RALPH_PLAN.md 5a "Ralph
 *     함정" #2 explicitly forbids that).
 *   - `showDebug=true` renders a `.claude-wv-card--system-hook` card with
 *     a `<details>` element so the JSON dump is collapsed by default.
 *     `data-hook-event` / `data-hook-name` / `data-subtype` / `data-uuid`
 *     attributes are attached so downstream filters can select them.
 *   - Upsert by `uuid` — the hook fixtures emit distinct uuids per event,
 *     so re-rendering the same event does not duplicate the card.
 *   - Flipping `showDebug=false → true` mid-session is NOT required to
 *     retroactively render past events (a settings toggle takes effect
 *     on subsequent events only).
 */
import { describe, it, expect } from "vitest";
import { Window } from "happy-dom";
import path from "node:path";
import { replayFixture } from "./helpers/fixture-replay";
import {
  createSystemHookState,
  renderSystemHook,
} from "../../src/webview/renderers/system-status";
import type {
  SystemHookStartedEvent,
  SystemHookResponseEvent,
  StreamEvent,
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

function hookEvents(events: StreamEvent[]): Array<
  SystemHookStartedEvent | SystemHookResponseEvent
> {
  return events.filter(
    (e): e is SystemHookStartedEvent | SystemHookResponseEvent =>
      e.type === "system" &&
      (e.subtype === "hook_started" || e.subtype === "hook_response"),
  );
}

describe("renderSystemHook — MH-07 default-hidden + debug-visible contract", () => {
  it("showDebug=false: slash-compact fixture's 12 hook events yield ZERO cards (no hidden DOM)", () => {
    const replay = replayFixture(
      path.join(FIXTURE_DIR, "slash-compact.jsonl"),
    );
    const hooks = hookEvents(replay.events);
    // Fixture sanity — must have hook events to exercise the gate.
    expect(hooks.length).toBeGreaterThan(0);
    const { doc, cardsEl } = makeCards();
    const state = createSystemHookState();
    for (const ev of hooks) {
      renderSystemHook(state, cardsEl, ev, doc, { showDebug: false });
    }
    expect(cardsEl.querySelectorAll(".claude-wv-card--system-hook").length).toBe(0);
    // Also assert `cardsEl` has no children at all — the 'Ralph 함정' #2
    // forbids display:none hidden DOM, so the cards root must truly be empty.
    expect(cardsEl.children.length).toBe(0);
  });

  it("showDebug=true: each distinct hook_started / hook_response event renders a collapsed <details> card", () => {
    const replay = replayFixture(
      path.join(FIXTURE_DIR, "slash-compact.jsonl"),
    );
    const hooks = hookEvents(replay.events);
    const { doc, cardsEl } = makeCards();
    const state = createSystemHookState();
    for (const ev of hooks) {
      renderSystemHook(state, cardsEl, ev, doc, { showDebug: true });
    }
    const cards = cardsEl.querySelectorAll(".claude-wv-card--system-hook");
    expect(cards.length).toBe(hooks.length);
    for (const card of Array.from(cards)) {
      const cardEl = card as unknown as HTMLElement;
      const details = cardEl.querySelector("details");
      expect(details).not.toBeNull();
      expect(cardEl.getAttribute("data-subtype")).toMatch(/^hook_(started|response)$/);
      expect(cardEl.getAttribute("data-hook-event")).toBeTruthy();
    }
  });

  it("upsert by uuid — replaying the same event twice does not duplicate", () => {
    const { doc, cardsEl } = makeCards();
    const state = createSystemHookState();
    const ev: SystemHookStartedEvent = {
      type: "system",
      subtype: "hook_started",
      hook_id: "h-1",
      hook_name: "SessionStart:startup",
      hook_event: "SessionStart",
      uuid: "aaaaaaaa-0000-0000-0000-000000000000",
      session_id: "deadbeef-0000-0000-0000-000000000000",
    };
    renderSystemHook(state, cardsEl, ev, doc, { showDebug: true });
    renderSystemHook(state, cardsEl, ev, doc, { showDebug: true });
    expect(cardsEl.querySelectorAll(".claude-wv-card--system-hook").length).toBe(1);
  });

  it("slash-compact fixture: differentiates hook_started (no exit_code) from hook_response (has exit_code) via data-subtype", () => {
    const replay = replayFixture(
      path.join(FIXTURE_DIR, "slash-compact.jsonl"),
    );
    const hooks = hookEvents(replay.events);
    const { doc, cardsEl } = makeCards();
    const state = createSystemHookState();
    for (const ev of hooks) {
      renderSystemHook(state, cardsEl, ev, doc, { showDebug: true });
    }
    const startedCards = cardsEl.querySelectorAll(
      '[data-subtype="hook_started"]',
    );
    const responseCards = cardsEl.querySelectorAll(
      '[data-subtype="hook_response"]',
    );
    const startedCount = hooks.filter((h) => h.subtype === "hook_started").length;
    const responseCount = hooks.filter((h) => h.subtype === "hook_response").length;
    expect(startedCards.length).toBe(startedCount);
    expect(responseCards.length).toBe(responseCount);
    expect(startedCount).toBeGreaterThan(0);
    expect(responseCount).toBeGreaterThan(0);
  });
});
