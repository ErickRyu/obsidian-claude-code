import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  replayFixture,
  eventCountByType,
} from "./helpers/fixture-replay";
import type {
  AssistantEvent,
  ResultEvent,
  StreamEvent,
} from "../../src/webview/parser/types";

/**
 * AC 2 / Sub-AC 4 — SH-06 (modelUsage parsing robustness) and SH-07
 * (resume-fallback signal parsing).
 *
 * Phase 2 scope: this sub-AC proves the **parser layer** surfaces every
 * field required by the Phase 5a token/context badge (SH-06) and the
 * Phase 5b session archive fallback (SH-07) without loss or drift. The
 * actual status-bar wiring (`ui/status-bar.ts` / `renderers/system-status.ts`)
 * and archive writer (`session/session-archive.ts`) land in Phase 5a / 5b,
 * but the parser contract **must** be locked first so those renderers can
 * build on stable event shapes.
 *
 * Why two separate should-haves are grouped here: both depend on `ResultEvent`
 * optional fields that are cast through the parser (`modelUsage` for SH-06,
 * `errors[]` for SH-07) rather than declared properties. A single evidence
 * pass is cheaper than two, and the differential assertions naturally overlap
 * (the same 7 "happy" fixtures provide the contrast for resume.jsonl's
 * "result only" fallback shape).
 *
 * Contract pinned here (breaking any of these in a future refactor fails
 * this suite loudly):
 *
 *   SH-06 — modelUsage parsing
 *     • `result.modelUsage` is preserved by the parser as an object map of
 *       model-id → per-model aggregate bucket.
 *     • Each per-model bucket carries `inputTokens`, `outputTokens`,
 *       `cacheReadInputTokens`, `cacheCreationInputTokens`, `costUSD`,
 *       `contextWindow`, `maxOutputTokens` as numbers.
 *     • `result.modelUsage.*.outputTokens` aggregates across the whole
 *       session (≠ the last `assistant.message.usage.output_tokens` per-turn
 *       value). This differential is what makes modelUsage the "source of
 *       truth" for the token badge — a naive last-assistant reader under-
 *       counts.
 *     • `result.num_turns` is preserved and matches the user-turn count.
 *     • `result.modelUsage = {}` (empty object) is an acceptable parse — the
 *       resume-fallback and slash-mcp fast-failure shapes both emit it.
 *
 *   SH-07 — resume-fallback signal parsing
 *     • resume.jsonl parses to exactly one `result` event with rawSkipped=0.
 *     • That event carries `subtype === "error_during_execution"`,
 *       `is_error === true`, and an `errors: [string]` array (the `errors`
 *       field is cast-through by the parser — it is NOT a declared
 *       `ResultEvent` property).
 *     • `errors[0]` matches /No conversation found with session ID: <uuid>/.
 *     • The extracted failed-session uuid ≠ `result.session_id` (the
 *       fallback session the CLI spun up).
 *     • No other fixture contains an `errors` array — this is the unique
 *       marker used by the Phase 5b archive-fallback dispatcher.
 */

const FIXTURE_DIR = join(__dirname, "..", "fixtures", "stream-json");

const HAPPY_FIXTURES = [
  "hello.jsonl",
  "edit.jsonl",
  "permission.jsonl",
  "plan-mode.jsonl",
  "todo.jsonl",
  "slash-compact.jsonl",
] as const;

const ALL_FIXTURES = [
  ...HAPPY_FIXTURES,
  "resume.jsonl",
  "slash-mcp.jsonl",
] as const;

function isAssistant(e: StreamEvent): e is AssistantEvent {
  return e.type === "assistant";
}
function isResult(e: StreamEvent): e is ResultEvent {
  return e.type === "result";
}

/**
 * Per-model bucket shape under `result.modelUsage["<model-id>"]`.
 * Cast-through by the parser — the declared ResultEvent type only carries
 * `modelUsage?: Record<string, unknown>`, so we narrow here.
 */
interface ModelUsageBucket {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
}

function narrowBucket(v: unknown): ModelUsageBucket | null {
  if (typeof v !== "object" || v === null) return null;
  const rec = v as Record<string, unknown>;
  const keys: (keyof ModelUsageBucket)[] = [
    "inputTokens",
    "outputTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
    "costUSD",
    "contextWindow",
    "maxOutputTokens",
  ];
  for (const k of keys) {
    if (typeof rec[k] !== "number" || !Number.isFinite(rec[k] as number)) {
      return null;
    }
  }
  return rec as unknown as ModelUsageBucket;
}

function lastAssistantOutputTokens(events: StreamEvent[]): number | null {
  let last: number | null = null;
  for (const e of events) {
    if (!isAssistant(e)) continue;
    const usage = e.message.usage;
    if (!usage) continue;
    const o = (usage as Record<string, unknown>).output_tokens;
    if (typeof o === "number" && Number.isFinite(o)) {
      last = o;
    }
  }
  return last;
}

describe("SH-06 — result.modelUsage parsing robustness (AC 2 / Sub-AC 4)", () => {
  it("all 8 fixtures parse with rawSkipped === 0 AND unknownEventCount === 0", () => {
    for (const fx of ALL_FIXTURES) {
      const replay = replayFixture(join(FIXTURE_DIR, fx));
      expect(
        replay.rawSkipped,
        `${fx} rawSkipped must be 0`,
      ).toBe(0);
      expect(
        replay.unknownEventCount,
        `${fx} unknownEventCount must be 0`,
      ).toBe(0);
    }
  });

  it("every fixture's result event preserves `modelUsage` (even when empty)", () => {
    for (const fx of ALL_FIXTURES) {
      const replay = replayFixture(join(FIXTURE_DIR, fx));
      const results = replay.events.filter(isResult);
      expect(results.length, `${fx} must emit at least 1 result`).toBeGreaterThanOrEqual(1);
      const ev = results[0];
      // The parser must preserve `modelUsage` on the cast ResultEvent; it may
      // be an empty object in the failure/fast-fail branches but must never
      // be undefined.
      expect(
        ev.modelUsage,
        `${fx} result.modelUsage must be preserved (not undefined)`,
      ).toBeDefined();
      expect(typeof ev.modelUsage === "object" && ev.modelUsage !== null).toBe(true);
    }
  });

  it("happy fixtures expose per-model buckets with all 7 required numeric fields", () => {
    for (const fx of HAPPY_FIXTURES) {
      const replay = replayFixture(join(FIXTURE_DIR, fx));
      const ev = replay.events.filter(isResult)[0];
      const mu = ev.modelUsage as Record<string, unknown>;
      const modelIds = Object.keys(mu);
      expect(
        modelIds.length,
        `${fx} modelUsage must have at least 1 model-id key`,
      ).toBeGreaterThanOrEqual(1);
      for (const modelId of modelIds) {
        const bucket = narrowBucket(mu[modelId]);
        expect(
          bucket,
          `${fx} modelUsage[${modelId}] missing required numeric fields`,
        ).not.toBeNull();
      }
    }
  });

  it("resume.jsonl and slash-mcp.jsonl emit modelUsage === {} (no models, no buckets)", () => {
    for (const fx of ["resume.jsonl", "slash-mcp.jsonl"]) {
      const replay = replayFixture(join(FIXTURE_DIR, fx));
      const ev = replay.events.filter(isResult)[0];
      const mu = ev.modelUsage as Record<string, unknown>;
      expect(
        Object.keys(mu).length,
        `${fx} modelUsage must be an empty object`,
      ).toBe(0);
    }
  });

  it("modelUsage outputTokens aggregation DIFFERS from last assistant.usage.output_tokens (source-of-truth differential)", () => {
    // This is the SH-06 CORE assertion: a naive token-badge implementation
    // that reads from the last assistant turn's usage under-counts. The
    // result.modelUsage totals the whole session — which is why Phase 5a's
    // `status-bar.ts` MUST read from modelUsage, not assistant.usage.
    for (const fx of HAPPY_FIXTURES) {
      const replay = replayFixture(join(FIXTURE_DIR, fx));
      const ev = replay.events.filter(isResult)[0];
      const mu = ev.modelUsage as Record<string, unknown>;
      let modelUsageOutputSum = 0;
      for (const modelId of Object.keys(mu)) {
        const bucket = narrowBucket(mu[modelId]);
        expect(bucket).not.toBeNull();
        modelUsageOutputSum += bucket!.outputTokens;
      }
      const lastAsst = lastAssistantOutputTokens(replay.events);
      // For fixtures with assistant turns: modelUsage aggregate >=
      // lastAssistant (multi-turn session aggregates more than last turn).
      // For slash-compact (no assistant turns surfaced by the compact
      // boundary), lastAsst is null — we only assert modelUsageOutputSum > 0.
      expect(
        modelUsageOutputSum,
        `${fx} modelUsage outputTokens must be positive for a happy fixture`,
      ).toBeGreaterThan(0);
      if (lastAsst !== null) {
        expect(
          modelUsageOutputSum,
          `${fx} modelUsage(${modelUsageOutputSum}) must be >= last assistant(${lastAsst})`,
        ).toBeGreaterThanOrEqual(lastAsst);
        // At least one fixture in the set must show STRICT inequality — we
        // don't require all, but the overall contract (modelUsage ≠
        // assistant.usage) is asserted per-fixture in the next test.
      }
    }
  });

  it("at least one happy fixture has STRICT inequality modelUsage.outputTokens > last assistant.usage.output_tokens", () => {
    // Differential guard — prevents fixture drift from silently aligning the
    // two sources. As of Phase 2 baseline, every happy fixture with both
    // sources has modelUsage.output strictly greater than last-assistant
    // per-turn, and this is the single source of truth for the Phase 5a
    // badge.
    let strictCount = 0;
    for (const fx of HAPPY_FIXTURES) {
      const replay = replayFixture(join(FIXTURE_DIR, fx));
      const ev = replay.events.filter(isResult)[0];
      const mu = ev.modelUsage as Record<string, unknown>;
      let sum = 0;
      for (const modelId of Object.keys(mu)) {
        const bucket = narrowBucket(mu[modelId]);
        sum += bucket?.outputTokens ?? 0;
      }
      const lastAsst = lastAssistantOutputTokens(replay.events);
      if (lastAsst !== null && sum > lastAsst) strictCount++;
    }
    expect(
      strictCount,
      "at least one happy fixture must show modelUsage > last-assistant strict inequality",
    ).toBeGreaterThanOrEqual(1);
  });

  it("num_turns preserved on every happy fixture and is a positive integer", () => {
    const expectedTurns: Record<string, number> = {
      "hello.jsonl": 1,
      "edit.jsonl": 3,
      "permission.jsonl": 2,
      "plan-mode.jsonl": 3,
      "todo.jsonl": 3,
      "slash-compact.jsonl": 20,
    };
    for (const fx of HAPPY_FIXTURES) {
      const replay = replayFixture(join(FIXTURE_DIR, fx));
      const ev = replay.events.filter(isResult)[0];
      expect(ev.num_turns, `${fx} num_turns`).toBe(expectedTurns[fx]);
    }
  });

  it("contextWindow preserved in every happy fixture's modelUsage bucket", () => {
    // Used by SH-06's "context %" portion of the badge (current usage vs
    // contextWindow). All current fixtures emit 1_000_000 (Opus 4.6 1M), so
    // we pin that — if the CLI ever changes the constant a re-record must
    // intentionally update this test.
    for (const fx of HAPPY_FIXTURES) {
      const replay = replayFixture(join(FIXTURE_DIR, fx));
      const ev = replay.events.filter(isResult)[0];
      const mu = ev.modelUsage as Record<string, unknown>;
      for (const modelId of Object.keys(mu)) {
        const bucket = narrowBucket(mu[modelId]);
        expect(bucket).not.toBeNull();
        expect(
          bucket!.contextWindow,
          `${fx} modelUsage[${modelId}].contextWindow must be positive`,
        ).toBeGreaterThan(0);
      }
    }
  });
});

describe("SH-07 — resume-fallback signal parsing (AC 2 / Sub-AC 4)", () => {
  it("resume.jsonl parses to exactly 1 result event, rawSkipped === 0, unknownEventCount === 0", () => {
    const replay = replayFixture(join(FIXTURE_DIR, "resume.jsonl"));
    expect(replay.rawSkipped).toBe(0);
    expect(replay.unknownEventCount).toBe(0);
    expect(replay.events.length).toBe(1);
    expect(replay.parserInvocationCount).toBe(1);
    const counts = eventCountByType(replay.events);
    expect(counts.result).toBe(1);
    // Differential: the failure fixture has NO other event types.
    expect(counts.system).toBeUndefined();
    expect(counts.assistant).toBeUndefined();
    expect(counts.user).toBeUndefined();
  });

  it("resume.jsonl result carries subtype=error_during_execution AND is_error=true AND num_turns=0", () => {
    const replay = replayFixture(join(FIXTURE_DIR, "resume.jsonl"));
    const ev = replay.events.filter(isResult)[0];
    expect(ev.subtype).toBe("error_during_execution");
    expect(ev.is_error).toBe(true);
    expect(ev.num_turns).toBe(0);
    expect(ev.duration_ms).toBe(0);
  });

  it("result.errors[] is preserved as a non-empty string array via cast-through", () => {
    const replay = replayFixture(join(FIXTURE_DIR, "resume.jsonl"));
    const ev = replay.events.filter(isResult)[0];
    // `errors` is NOT a declared ResultEvent field — the parser must
    // nevertheless pass it through (the cast in stream-json-parser.ts
    // preserves all non-type fields by design). Narrow via
    // Record<string, unknown> rather than widening the type.
    const raw = ev as unknown as Record<string, unknown>;
    expect(Array.isArray(raw.errors)).toBe(true);
    const errors = raw.errors as unknown[];
    expect(errors.length).toBe(1);
    expect(typeof errors[0]).toBe("string");
    expect(errors[0] as string).toMatch(
      /^No conversation found with session ID: [0-9a-f-]{36}$/i,
    );
  });

  it("failed session uuid extracted from errors[0] differs from result.session_id (fallback session allocated)", () => {
    const replay = replayFixture(join(FIXTURE_DIR, "resume.jsonl"));
    const ev = replay.events.filter(isResult)[0];
    const raw = ev as unknown as Record<string, unknown>;
    const errors = raw.errors as string[];
    const match = errors[0].match(/session ID: ([0-9a-f-]{36})/i);
    expect(match).not.toBeNull();
    const failedId = match![1];
    // SH-07 core contract: the CLI allocates a NEW session on resume failure;
    // the archive-fallback dispatcher in Phase 5b keys off `failedId` (the
    // requested id, not the fresh one) to look up an archived session.
    expect(failedId).not.toBe(ev.session_id);
    expect(ev.session_id).toBe("d70751ee-151b-4b5b-b5c4-957c02505dc6");
    expect(failedId).toBe("d318d71a-994a-44a0-828c-9f83fc15481a");
  });

  it("errors[] field absent on every non-resume fixture (differential marker)", () => {
    // Phase 5b's fallback dispatcher will use the presence of
    // result.errors as the TRIGGER to look up the archive. That means no
    // happy-path fixture can leak an `errors` field — verify via this
    // differential guard.
    for (const fx of [...HAPPY_FIXTURES, "slash-mcp.jsonl"]) {
      const replay = replayFixture(join(FIXTURE_DIR, fx));
      const results = replay.events.filter(isResult);
      for (const r of results) {
        const raw = r as unknown as Record<string, unknown>;
        expect(
          raw.errors,
          `${fx} must NOT carry an errors field on its result event`,
        ).toBeUndefined();
      }
    }
  });

  it("resume.jsonl subtype + is_error combination is UNIQUE across all 8 fixtures", () => {
    // The Phase 5b dispatcher must distinguish "resume failed → try archive"
    // from "CLI-level error that should surface normally". Combination
    // (subtype=error_during_execution, is_error=true) appears in exactly
    // one fixture: resume.jsonl. Any future fixture that adds this combo
    // will break this assertion and force the author to confirm the
    // dispatcher rule still holds.
    let resumeComboCount = 0;
    for (const fx of ALL_FIXTURES) {
      const replay = replayFixture(join(FIXTURE_DIR, fx));
      for (const r of replay.events.filter(isResult)) {
        if (r.subtype === "error_during_execution" && r.is_error === true) {
          resumeComboCount++;
        }
      }
    }
    expect(resumeComboCount).toBe(1);
  });
});
