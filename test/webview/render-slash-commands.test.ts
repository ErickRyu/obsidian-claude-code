import { describe, it, expect } from "vitest";
import { Window } from "happy-dom";
import path from "node:path";
import {
  replayFixture,
  eventCountByType,
} from "./helpers/fixture-replay";
import {
  createSystemInitState,
  renderSystemInit,
} from "../../src/webview/renderers/system-init";
import {
  createResultState,
  renderResult,
} from "../../src/webview/renderers/result";
import type {
  ResultEvent,
  StreamEvent,
  SystemInitEvent,
  SystemEvent,
} from "../../src/webview/parser/types";

/**
 * AC 3 Sub-AC 5 — verify `slash-compact.jsonl` and `slash-mcp.jsonl`
 * fixtures parse with `rawSkipped === 0` and render slash-command-specific
 * events (the /compact and /mcp slash commands) through the Phase 2 production
 * renderers without dropping data.
 *
 * Why these two fixtures matter:
 * - `slash-compact.jsonl` — captures a real `/compact` slash command session
 *   where the CLI runs PreCompact hooks, emits `system.status` ("compacting"),
 *   resets context via `system.compact_boundary`, and finishes with a new
 *   `system.init` + replay `user` turn + successful `result`. The parser must
 *   preserve all four subtypes without falling back to UnknownEvent.
 * - `slash-mcp.jsonl` — captures an unsupported `/mcp` slash command where the
 *   CLI runs hooks, emits `system.init`, then fails with
 *   `result.result === "Unknown command: /mcp"` (duration_ms: 4, no turns). The
 *   webview beta constraint states `/mcp` is NOT supported, so the fixture
 *   serves as the canonical "friendly error" signal the Phase 5a renderer
 *   will consume.
 *
 * Assertions are key-field only (no HTML snapshots) per coding constraints.
 * Differential-input checks confirm the parser is NOT hardcoded — slash-compact
 * has a compact_boundary event that slash-mcp lacks, and slash-mcp's result
 * carries the "Unknown command: /mcp" string that slash-compact's does not.
 */

const FIXTURE_DIR = path.resolve(__dirname, "..", "fixtures", "stream-json");

function isResult(e: StreamEvent): e is ResultEvent {
  return e.type === "result";
}

function isSystem(e: StreamEvent): e is SystemEvent {
  return e.type === "system";
}

function systemSubtype(e: SystemEvent): string {
  return e.subtype;
}

describe("slash-compact.jsonl rendering (AC 3 Sub-AC 5)", () => {
  const FIXTURE = "slash-compact.jsonl";

  it("parses with rawSkipped === 0 and unknownEventCount === 0", () => {
    const replay = replayFixture(path.join(FIXTURE_DIR, FIXTURE));
    expect(replay.rawSkipped).toBe(0);
    expect(replay.unknownEventCount).toBe(0);
    expect(replay.events.length).toBeGreaterThan(0);
    // The fixture has 20 non-empty lines; every line must parse.
    expect(replay.parserInvocationCount).toBe(20);
    expect(replay.events.length).toBe(20);
  });

  it("contains the full /compact sequence (hook_* + status + init + compact_boundary + user + result)", () => {
    const replay = replayFixture(path.join(FIXTURE_DIR, FIXTURE));
    const counts = eventCountByType(replay.events);
    // 16 system events: 6 hook_started + 6 hook_response + 2 status + 1 init +
    // 1 compact_boundary = 16 (matches fixture byte-layout).
    expect(counts.system).toBe(16);
    expect(counts.rate_limit_event).toBe(1);
    expect(counts.user).toBe(2);
    expect(counts.result).toBe(1);
    // No UnknownEvent wrappers — all top-level types are known.
    const unknownKeys = Object.keys(counts).filter((k) =>
      k.startsWith("__unknown__:"),
    );
    expect(unknownKeys).toEqual([]);
  });

  it("emits exactly one system.compact_boundary event (the /compact reset signal)", () => {
    const replay = replayFixture(path.join(FIXTURE_DIR, FIXTURE));
    const boundaries = replay.events
      .filter(isSystem)
      .filter((e) => systemSubtype(e) === "compact_boundary");
    expect(boundaries.length).toBe(1);
    const boundary = boundaries[0];
    // compact_metadata is preserved verbatim through the parser.
    const raw = boundary as unknown as Record<string, unknown>;
    const meta = raw.compact_metadata as Record<string, unknown> | undefined;
    expect(meta).toBeDefined();
    expect(meta?.trigger).toBe("manual");
    expect(typeof meta?.pre_tokens).toBe("number");
    expect(typeof meta?.post_tokens).toBe("number");
    expect(typeof meta?.duration_ms).toBe("number");
  });

  it("emits system.status events that straddle the compact boundary ('compacting' → null+success)", () => {
    const replay = replayFixture(path.join(FIXTURE_DIR, FIXTURE));
    const statuses = replay.events
      .filter(isSystem)
      .filter((e) => systemSubtype(e) === "status");
    expect(statuses.length).toBe(2);
    const raw0 = statuses[0] as unknown as Record<string, unknown>;
    const raw1 = statuses[1] as unknown as Record<string, unknown>;
    expect(raw0.status).toBe("compacting");
    expect(raw1.status).toBe(null);
    expect(raw1.compact_result).toBe("success");
  });

  it("renders the system.init card with session_id matching the /compact session", () => {
    const replay = replayFixture(path.join(FIXTURE_DIR, FIXTURE));
    const initEvent = replay.events
      .filter(isSystem)
      .find(
        (e): e is SystemInitEvent => systemSubtype(e) === "init",
      ) as SystemInitEvent | undefined;
    expect(initEvent).toBeDefined();
    if (!initEvent) return;

    const window = new Window();
    const doc = window.document as unknown as Document;
    const parent = doc.createElement("div");
    (doc.body as unknown as HTMLElement).replaceChildren(parent);

    const state = createSystemInitState();
    const card = renderSystemInit(state, parent, initEvent, doc);
    expect(card.classList.contains("claude-wv-card--system-init")).toBe(true);
    expect(card.getAttribute("data-session-id")).toBe(
      "941c73af-696b-4202-8807-4175fa5608f2",
    );
    expect(state.cards.size).toBe(1);
  });

  it("renders the result card with subtype='success', duration>0, and num_turns>0 (differential vs slash-mcp)", () => {
    const replay = replayFixture(path.join(FIXTURE_DIR, FIXTURE));
    const results = replay.events.filter(isResult);
    expect(results.length).toBe(1);
    const ev = results[0];

    const window = new Window();
    const doc = window.document as unknown as Document;
    const parent = doc.createElement("div");
    (doc.body as unknown as HTMLElement).replaceChildren(parent);

    const state = createResultState();
    const card = renderResult(state, parent, ev, doc);
    expect(card.classList.contains("claude-wv-card--result")).toBe(true);
    expect(card.getAttribute("data-subtype")).toBe("success");
    expect(card.hasAttribute("data-is-error")).toBe(false);
    expect(card.getAttribute("data-session-id")).toBe(
      "941c73af-696b-4202-8807-4175fa5608f2",
    );
    // Differential from slash-mcp (duration_ms: 4, num_turns: 8).
    expect(ev.duration_ms).toBeGreaterThan(100);
    expect(ev.num_turns).toBeGreaterThan(10);
  });
});

describe("slash-mcp.jsonl rendering (AC 3 Sub-AC 5)", () => {
  const FIXTURE = "slash-mcp.jsonl";

  it("parses with rawSkipped === 0 and unknownEventCount === 0", () => {
    const replay = replayFixture(path.join(FIXTURE_DIR, FIXTURE));
    expect(replay.rawSkipped).toBe(0);
    expect(replay.unknownEventCount).toBe(0);
    expect(replay.events.length).toBeGreaterThan(0);
    // The fixture has 8 non-empty lines (3 hook_started + 3 hook_response +
    // 1 init + 1 result).
    expect(replay.parserInvocationCount).toBe(8);
    expect(replay.events.length).toBe(8);
  });

  it("contains the /mcp unsupported-command shape (hook_* + init + result ONLY — no user/assistant/compact_boundary)", () => {
    const replay = replayFixture(path.join(FIXTURE_DIR, FIXTURE));
    const counts = eventCountByType(replay.events);
    // 7 system events: 3 hook_started + 3 hook_response + 1 init.
    expect(counts.system).toBe(7);
    expect(counts.result).toBe(1);
    // Differential vs slash-compact: no user turns, no rate_limit, no
    // compact_boundary, no assistant events.
    expect(counts.user).toBeUndefined();
    expect(counts.assistant).toBeUndefined();
    expect(counts.rate_limit_event).toBeUndefined();
    const unknownKeys = Object.keys(counts).filter((k) =>
      k.startsWith("__unknown__:"),
    );
    expect(unknownKeys).toEqual([]);
    // Subtype-level differential: no compact_boundary / status events here.
    const subtypes = new Set(
      replay.events.filter(isSystem).map((e) => systemSubtype(e)),
    );
    expect(subtypes.has("compact_boundary")).toBe(false);
    expect(subtypes.has("status")).toBe(false);
    expect(subtypes.has("init")).toBe(true);
    expect(subtypes.has("hook_started")).toBe(true);
    expect(subtypes.has("hook_response")).toBe(true);
  });

  it("renders the result card carrying the 'Unknown command: /mcp' signal", () => {
    const replay = replayFixture(path.join(FIXTURE_DIR, FIXTURE));
    const results = replay.events.filter(isResult);
    expect(results.length).toBe(1);
    const ev = results[0];

    // The fixture's result field is the friendly-error string. The parser
    // does not strip it — Phase 5a renderer will surface it via a
    // slash-mcp-specific card. For Sub-AC 5 we just assert it survives
    // the replay pipeline verbatim.
    expect(ev.subtype).toBe("success");
    expect(ev.is_error === true).toBe(false);
    expect(ev.result).toBe("Unknown command: /mcp");
    expect(ev.num_turns).toBe(8);
    expect(ev.duration_ms).toBe(4);

    const window = new Window();
    const doc = window.document as unknown as Document;
    const parent = doc.createElement("div");
    (doc.body as unknown as HTMLElement).replaceChildren(parent);

    const state = createResultState();
    const card = renderResult(state, parent, ev, doc);
    expect(card.classList.contains("claude-wv-card--result")).toBe(true);
    expect(card.getAttribute("data-subtype")).toBe("success");
    expect(card.hasAttribute("data-is-error")).toBe(false);
    expect(card.getAttribute("data-session-id")).toBe(
      "514373d4-115c-4f65-a428-c513068b04c3",
    );
  });

  it("renders the system.init card with session_id distinct from slash-compact.jsonl", () => {
    const replay = replayFixture(path.join(FIXTURE_DIR, FIXTURE));
    const initEvent = replay.events
      .filter(isSystem)
      .find(
        (e): e is SystemInitEvent => systemSubtype(e) === "init",
      ) as SystemInitEvent | undefined;
    expect(initEvent).toBeDefined();
    if (!initEvent) return;

    const window = new Window();
    const doc = window.document as unknown as Document;
    const parent = doc.createElement("div");
    (doc.body as unknown as HTMLElement).replaceChildren(parent);

    const state = createSystemInitState();
    const card = renderSystemInit(state, parent, initEvent, doc);
    expect(card.getAttribute("data-session-id")).toBe(
      "514373d4-115c-4f65-a428-c513068b04c3",
    );
    // Differential vs slash-compact's session (distinct uuids).
    expect(card.getAttribute("data-session-id")).not.toBe(
      "941c73af-696b-4202-8807-4175fa5608f2",
    );
  });
});

describe("slash command fixtures differential (AC 3 Sub-AC 5)", () => {
  it("slash-compact has compact_boundary+status events that slash-mcp lacks", () => {
    const compact = replayFixture(
      path.join(FIXTURE_DIR, "slash-compact.jsonl"),
    );
    const mcp = replayFixture(path.join(FIXTURE_DIR, "slash-mcp.jsonl"));

    const compactSubtypes = new Set(
      compact.events.filter(isSystem).map((e) => systemSubtype(e)),
    );
    const mcpSubtypes = new Set(
      mcp.events.filter(isSystem).map((e) => systemSubtype(e)),
    );

    // Differential — inclusion signals
    expect(compactSubtypes.has("compact_boundary")).toBe(true);
    expect(compactSubtypes.has("status")).toBe(true);
    // Differential — exclusion signals
    expect(mcpSubtypes.has("compact_boundary")).toBe(false);
    expect(mcpSubtypes.has("status")).toBe(false);
  });

  it("both fixtures parse with rawSkipped === 0 simultaneously (contract guarantee)", () => {
    const compact = replayFixture(
      path.join(FIXTURE_DIR, "slash-compact.jsonl"),
    );
    const mcp = replayFixture(path.join(FIXTURE_DIR, "slash-mcp.jsonl"));
    expect(compact.rawSkipped).toBe(0);
    expect(mcp.rawSkipped).toBe(0);
    expect(compact.unknownEventCount).toBe(0);
    expect(mcp.unknownEventCount).toBe(0);
  });

  it("result carriers are distinct: slash-compact.result.result is empty; slash-mcp.result.result is 'Unknown command: /mcp'", () => {
    const compact = replayFixture(
      path.join(FIXTURE_DIR, "slash-compact.jsonl"),
    );
    const mcp = replayFixture(path.join(FIXTURE_DIR, "slash-mcp.jsonl"));
    const compactResult = compact.events.filter(isResult)[0];
    const mcpResult = mcp.events.filter(isResult)[0];
    // slash-compact's result carries an empty `result` string (the /compact
    // flow concluded silently — the compact_boundary event is the signal).
    expect(compactResult.result).toBe("");
    // slash-mcp's result is the "Unknown command" friendly error.
    expect(mcpResult.result).toBe("Unknown command: /mcp");
    // Both have subtype='success' because the CLI itself did not error
    // internally — the /mcp command simply isn't supported. The webview
    // Phase 5a renderer will surface this via a dedicated friendly-error card.
    expect(compactResult.subtype).toBe("success");
    expect(mcpResult.subtype).toBe("success");
  });
});
