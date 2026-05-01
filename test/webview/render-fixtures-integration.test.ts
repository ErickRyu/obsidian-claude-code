/**
 * Sub-AC 2 of AC 2 — integration verification for:
 *   - MH-04 (user.tool_result card renderer)
 *   - MH-05 (result / final-message card renderer)
 *
 * Each test feeds a real claude -p fixture (hello.jsonl / edit.jsonl) through
 * the parser, then dispatches just the relevant event types through the
 * renderers. The assertions operate on key fields — no HTML snapshot
 * fragility — and the differential input check (edit vs hello) proves the
 * renderers are not hardcoded.
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { Window } from "happy-dom";
import { replayFixture } from "./helpers/fixture-replay";
import {
  createUserToolResultState,
  renderUserToolResult,
} from "../../src/webview/renderers/user-tool-result";
import { createActivityGroupState } from "../../src/webview/renderers/activity-group";
import {
  createResultState,
  renderResult,
} from "../../src/webview/renderers/result";
import type {
  StreamEvent,
  UserEvent,
  ResultEvent,
  ToolResultBlock,
} from "../../src/webview/parser/types";

const FIXTURE_DIR = join(__dirname, "..", "fixtures", "stream-json");

function makeDoc(): { doc: Document; parent: HTMLElement } {
  const window = new Window();
  const doc = window.document as unknown as Document;
  const parent = doc.createElement("div");
  (doc.body as unknown as HTMLElement).replaceChildren(parent);
  return { doc, parent };
}

function isUser(e: StreamEvent): e is UserEvent {
  return e.type === "user";
}
function isResult(e: StreamEvent): e is ResultEvent {
  return e.type === "result";
}

describe("fixture integration — MH-04 tool_result + MH-05 result", () => {
  it("hello.jsonl — result card renders with expected key fields from parsed event", () => {
    const replay = replayFixture(join(FIXTURE_DIR, "hello.jsonl"));
    expect(replay.rawSkipped).toBe(0);

    const results = replay.events.filter(isResult);
    expect(results.length).toBeGreaterThanOrEqual(1);

    const { doc, parent } = makeDoc();
    const state = createResultState();
    const ev = results[0];
    const card = renderResult(state, parent, ev, doc);

    expect(card.classList.contains("claude-wv-card--result")).toBe(true);
    expect(card.getAttribute("data-session-id")).toBe(ev.session_id);
    expect(card.getAttribute("data-subtype")).toBe(ev.subtype);

    // Key-field assertions against the actual parsed event (no hardcoded values).
    const rows = card.querySelectorAll(".claude-wv-result-row");
    const getRow = (k: string): string => {
      for (const row of Array.from(rows)) {
        if (row.querySelector(".claude-wv-result-key")?.textContent === k) {
          return row.querySelector(".claude-wv-result-value")?.textContent ?? "";
        }
      }
      return "";
    };

    expect(getRow("subtype")).toBe(ev.subtype);
    if (typeof ev.duration_ms === "number") {
      expect(getRow("duration")).toBe(`${ev.duration_ms}ms`);
    }
    if (typeof ev.total_cost_usd === "number") {
      expect(getRow("cost")).toBe(`$${ev.total_cost_usd.toFixed(4)}`);
    }
    const usage = ev.usage;
    if (
      usage &&
      typeof usage.input_tokens === "number" &&
      typeof usage.output_tokens === "number"
    ) {
      expect(getRow("tokens")).toBe(`${usage.input_tokens}/${usage.output_tokens}`);
    }
    if (typeof ev.num_turns === "number") {
      expect(getRow("turns")).toBe(String(ev.num_turns));
    }
  });

  it("edit.jsonl — tool_result cards correlate to upstream tool_use_id values", () => {
    const replay = replayFixture(join(FIXTURE_DIR, "edit.jsonl"));
    expect(replay.rawSkipped).toBe(0);

    const userEvents = replay.events.filter(isUser);
    expect(userEvents.length).toBeGreaterThanOrEqual(1);

    // Collect tool_use_ids emitted by the user tool_result blocks in this fixture.
    const expectedToolUseIds: string[] = [];
    for (const ue of userEvents) {
      const content = ue.message.content;
      if (typeof content === "string") continue;
      for (const block of content) {
        if (block.type === "tool_result") {
          expectedToolUseIds.push((block as ToolResultBlock).tool_use_id);
        }
      }
    }
    expect(expectedToolUseIds.length).toBeGreaterThanOrEqual(1);

    const { doc, parent } = makeDoc();
    const state = createUserToolResultState();
    const groupState = createActivityGroupState();
    for (const ue of userEvents) {
      renderUserToolResult(state, groupState, parent, ue, doc);
    }

    // No matching tool-line in this isolated render — all results render
    // as fallback cards, so the count still matches the fixture's
    // tool_result block count.
    const cards = parent.querySelectorAll(".claude-wv-card--user-tool-result");
    expect(cards.length).toBe(expectedToolUseIds.length);

    // Every card's data-tool-use-id must match an id we saw in the fixture
    // (no phantom cards, no hardcoded tool_use_ids).
    const cardIds = Array.from(cards).map(
      (c) => c.getAttribute("data-tool-use-id") ?? "",
    );
    for (const expected of expectedToolUseIds) {
      expect(cardIds).toContain(expected);
    }

    // Each card should have a non-empty `<pre>` body (string content) or
    // multiple child blocks (array content).
    for (const card of Array.from(cards)) {
      const bodies = card.querySelectorAll(".claude-wv-tool-result-body");
      const images = card.querySelectorAll(".claude-wv-tool-result-image");
      expect(bodies.length + images.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("differential — hello.jsonl result has no tool_result cards; edit.jsonl has ≥1", () => {
    const helloReplay = replayFixture(join(FIXTURE_DIR, "hello.jsonl"));
    const editReplay = replayFixture(join(FIXTURE_DIR, "edit.jsonl"));

    const helloToolResults = countToolResultBlocks(helloReplay.events);
    const editToolResults = countToolResultBlocks(editReplay.events);

    expect(helloToolResults).toBe(0);
    expect(editToolResults).toBeGreaterThanOrEqual(1);

    // Render both through the same renderer and confirm the DOM reflects the
    // differential: hello mounts zero user-tool-result cards, edit mounts
    // exactly as many as there are tool_result blocks in its user events.
    const { doc: dH, parent: pH } = makeDoc();
    const stateH = createUserToolResultState();
    const gH = createActivityGroupState();
    for (const ev of helloReplay.events.filter(isUser)) {
      renderUserToolResult(stateH, gH, pH, ev, dH);
    }
    expect(pH.querySelectorAll(".claude-wv-card--user-tool-result").length).toBe(0);

    const { doc: dE, parent: pE } = makeDoc();
    const stateE = createUserToolResultState();
    const gE = createActivityGroupState();
    for (const ev of editReplay.events.filter(isUser)) {
      renderUserToolResult(stateE, gE, pE, ev, dE);
    }
    expect(pE.querySelectorAll(".claude-wv-card--user-tool-result").length).toBe(
      editToolResults,
    );
  });

  it("todo.jsonl — TodoWrite tool_result lands as a user-tool-result card with correct id", () => {
    const replay = replayFixture(join(FIXTURE_DIR, "todo.jsonl"));
    expect(replay.rawSkipped).toBe(0);

    const userEvents = replay.events.filter(isUser);
    const toolResultBlocks: ToolResultBlock[] = [];
    for (const ue of userEvents) {
      const c = ue.message.content;
      if (typeof c === "string") continue;
      for (const b of c) {
        if (b.type === "tool_result") toolResultBlocks.push(b as ToolResultBlock);
      }
    }
    expect(toolResultBlocks.length).toBeGreaterThanOrEqual(1);

    const { doc, parent } = makeDoc();
    const state = createUserToolResultState();
    const groupState = createActivityGroupState();
    for (const ue of userEvents) {
      renderUserToolResult(state, groupState, parent, ue, doc);
    }

    const cards = parent.querySelectorAll(".claude-wv-card--user-tool-result");
    expect(cards.length).toBe(toolResultBlocks.length);

    // Differential: every tool_use_id seen in source must be visible in DOM.
    const ids = new Set(
      Array.from(cards).map((c) => c.getAttribute("data-tool-use-id") ?? ""),
    );
    for (const b of toolResultBlocks) {
      expect(ids.has(b.tool_use_id)).toBe(true);
    }
  });
});

function countToolResultBlocks(events: StreamEvent[]): number {
  let n = 0;
  for (const e of events) {
    if (e.type !== "user") continue;
    const c = e.message.content;
    if (typeof c === "string") continue;
    for (const b of c) if (b.type === "tool_result") n++;
  }
  return n;
}
