import { describe, it, expect } from "vitest";
import { Window } from "happy-dom";
import path from "node:path";
import {
  replayFixture,
  eventCountByType,
} from "./helpers/fixture-replay";
import {
  createResultState,
  renderResult,
} from "../../src/webview/renderers/result";
import type { ResultEvent, StreamEvent } from "../../src/webview/parser/types";

/**
 * AC 3 Sub-AC 4 — verify `resume.jsonl` fixture parses and renders the
 * session-resume fallback (`subtype === "error_during_execution"`,
 * `is_error === true`, `errors` array with "No conversation found with
 * session ID: …") with `rawSkipped === 0`.
 *
 * Why this fixture matters: real `claude -p --resume <id>` runs sometimes
 * cannot find the requested session (archive purged, id mistyped). When that
 * happens the CLI does not stream any `system.init` / `assistant` / `user`
 * events — it only emits a single `result` event with `errors: [...]`.
 * Phase 2 renderer must handle this "result only" shape without skipping
 * lines or dropping fields. Phase 5a/5b will add a direct archive fallback
 * that consumes this same signal, but the renderer contract lands here.
 *
 * Assertions are key-field only (no HTML snapshots) per coding constraints.
 * Differential-input checks compare resume.jsonl's single-result shape
 * against hello.jsonl (full happy-path session) so the renderer is not
 * hardcoded to a specific subtype.
 */

const FIXTURE_DIR = path.resolve(
  __dirname,
  "..",
  "fixtures",
  "stream-json",
);

function rowValue(card: HTMLElement, key: string): string | null {
  const rows = card.querySelectorAll(".claude-wv-result-row");
  for (const row of Array.from(rows)) {
    const k = row.querySelector(".claude-wv-result-key")?.textContent ?? "";
    if (k === key) {
      return row.querySelector(".claude-wv-result-value")?.textContent ?? "";
    }
  }
  return null;
}

function isResult(e: StreamEvent): e is ResultEvent {
  return e.type === "result";
}

describe("resume.jsonl rendering (AC 3 Sub-AC 4)", () => {
  const FIXTURE = "resume.jsonl";

  it("parses with rawSkipped === 0 and unknownEventCount === 0", () => {
    const replay = replayFixture(path.join(FIXTURE_DIR, FIXTURE));
    expect(replay.rawSkipped).toBe(0);
    expect(replay.unknownEventCount).toBe(0);
    expect(replay.events.length).toBe(1);
    expect(replay.parserInvocationCount).toBe(1);
  });

  it("contains exactly one result event — no system/assistant/user turns", () => {
    const replay = replayFixture(path.join(FIXTURE_DIR, FIXTURE));
    const counts = eventCountByType(replay.events);
    expect(counts.result).toBe(1);
    // Session-resume-failure shape: no other event types are present.
    expect(counts.system).toBeUndefined();
    expect(counts.assistant).toBeUndefined();
    expect(counts.user).toBeUndefined();
    expect(counts.rate_limit_event).toBeUndefined();
  });

  it("result event carries the resume-failure signal (subtype + is_error + errors)", () => {
    const replay = replayFixture(path.join(FIXTURE_DIR, FIXTURE));
    const results = replay.events.filter(isResult);
    expect(results.length).toBe(1);
    const ev = results[0];

    expect(ev.subtype).toBe("error_during_execution");
    expect(ev.is_error).toBe(true);

    // Parser must preserve the `errors` array verbatim even though it is not
    // a declared field on ResultEvent — session continuity tooling (Phase 5b
    // resume-fallback) depends on reading that message to detect the "session
    // not found" branch. We reach into the raw JSON via `Record<string,
    // unknown>` rather than loosening the ResultEvent type.
    const raw = ev as unknown as Record<string, unknown>;
    expect(Array.isArray(raw.errors)).toBe(true);
    const errors = raw.errors as unknown[];
    expect(errors.length).toBe(1);
    const first = errors[0];
    expect(typeof first).toBe("string");
    expect(first).toContain("No conversation found with session ID");
  });

  it("renders a result card with data-is-error='true' and data-subtype='error_during_execution'", () => {
    const replay = replayFixture(path.join(FIXTURE_DIR, FIXTURE));
    const results = replay.events.filter(isResult);
    expect(results.length).toBe(1);

    const window = new Window();
    const doc = window.document as unknown as Document;
    const parent = doc.createElement("div");
    parent.classList.add("claude-wv-cards");
    (doc.body as unknown as HTMLElement).replaceChildren(parent);

    const state = createResultState();
    const card = renderResult(state, parent, results[0], doc);

    expect(card.classList.contains("claude-wv-card")).toBe(true);
    expect(card.classList.contains("claude-wv-card--result")).toBe(true);
    expect(card.getAttribute("data-subtype")).toBe("error_during_execution");
    expect(card.getAttribute("data-is-error")).toBe("true");
    // The session_id on the result is the NEW session the CLI spun up after
    // failing to resume — NOT the id the user asked to resume. We assert the
    // exact fixture value so future fixture regens are forced to either
    // update this test or rotate the id intentionally.
    expect(card.getAttribute("data-session-id")).toBe(
      "d70751ee-151b-4b5b-b5c4-957c02505dc6",
    );
    expect(state.cards.size).toBe(1);
    expect(parent.children.length).toBe(1);
  });

  it("result card renders all five rows with fixture-derived values (0ms, $0.0000, 0/0, 0)", () => {
    const replay = replayFixture(path.join(FIXTURE_DIR, FIXTURE));
    const ev = replay.events.filter(isResult)[0];

    const window = new Window();
    const doc = window.document as unknown as Document;
    const parent = doc.createElement("div");
    (doc.body as unknown as HTMLElement).replaceChildren(parent);
    const state = createResultState();
    const card = renderResult(state, parent, ev, doc);

    // All values come from the actual parsed event — no hardcoded constants.
    expect(rowValue(card, "subtype")).toBe(ev.subtype);
    expect(rowValue(card, "duration")).toBe(`${ev.duration_ms}ms`);
    expect(rowValue(card, "cost")).toBe(
      `$${(ev.total_cost_usd ?? 0).toFixed(4)}`,
    );
    const usage = ev.usage as Record<string, unknown> | undefined;
    const inp = usage?.input_tokens;
    const out = usage?.output_tokens;
    expect(rowValue(card, "tokens")).toBe(`${inp}/${out}`);
    expect(rowValue(card, "turns")).toBe(String(ev.num_turns));
  });

  it("session continuity differential: resume.jsonl's session_id differs from every other fixture's result session_id", () => {
    const replay = replayFixture(path.join(FIXTURE_DIR, FIXTURE));
    const resumeResult = replay.events.filter(isResult)[0];
    const resumeSessionId = resumeResult.session_id;

    // The `errors` payload references the session id the CLI failed to find.
    // That id must not collide with resume.jsonl's own (fallback) session_id —
    // otherwise the fixture would be self-inconsistent.
    const rawErrors = (resumeResult as unknown as Record<string, unknown>).errors as
      | string[]
      | undefined;
    expect(rawErrors).toBeDefined();
    const failedId = rawErrors?.[0]?.match(
      /session ID: ([0-9a-f-]{36})/i,
    )?.[1];
    expect(failedId).toBeDefined();
    expect(failedId).not.toBe(resumeSessionId);

    // Differential: every other fixture that has a result event carries a
    // distinct session_id. (Session continuity signal — resume failure must
    // allocate a fresh session rather than aliasing an existing one.)
    const otherFixtures = [
      "hello.jsonl",
      "edit.jsonl",
      "todo.jsonl",
      "permission.jsonl",
      "plan-mode.jsonl",
      "slash-compact.jsonl",
      "slash-mcp.jsonl",
    ];
    for (const fx of otherFixtures) {
      const r = replayFixture(path.join(FIXTURE_DIR, fx));
      for (const ev of r.events.filter(isResult)) {
        expect(ev.session_id).not.toBe(resumeSessionId);
      }
    }
  });

  it("differential vs hello.jsonl: happy-path result has is_error=false; resume.jsonl has is_error=true", () => {
    const resumeReplay = replayFixture(path.join(FIXTURE_DIR, FIXTURE));
    const helloReplay = replayFixture(path.join(FIXTURE_DIR, "hello.jsonl"));

    const resumeResult = resumeReplay.events.filter(isResult)[0];
    const helloResult = helloReplay.events.filter(isResult)[0];

    // Shape differential
    expect(resumeResult.subtype).toBe("error_during_execution");
    expect(resumeResult.is_error).toBe(true);
    expect(helloResult.subtype).toBe("success");
    expect(helloResult.is_error === true).toBe(false);

    // Render both and confirm data-is-error attribute differs on DOM.
    const window = new Window();
    const doc = window.document as unknown as Document;

    const parentR = doc.createElement("div");
    (doc.body as unknown as HTMLElement).replaceChildren(parentR);
    const stateR = createResultState();
    const cardR = renderResult(stateR, parentR, resumeResult, doc);
    expect(cardR.getAttribute("data-is-error")).toBe("true");

    const parentH = doc.createElement("div");
    (doc.body as unknown as HTMLElement).replaceChildren(parentH);
    const stateH = createResultState();
    const cardH = renderResult(stateH, parentH, helloResult, doc);
    expect(cardH.hasAttribute("data-is-error")).toBe(false);
  });
});
