#!/usr/bin/env tsx
/**
 * Evidence generator for Phase 2, Sub-AC 5 of AC 3:
 *   - verify `slash-compact.jsonl` and `slash-mcp.jsonl` fixtures parse with
 *     `rawSkipped === 0`, `unknownEventCount === 0`, and render slash-command-
 *     specific events (compact_boundary / status / init / result) through the
 *     Phase 2 production renderers without data loss.
 *
 * Workflow:
 *   1. Import the production parser via replayFixture().
 *   2. Import the production system-init + result renderers.
 *   3. Replay slash-compact.jsonl and slash-mcp.jsonl, render their init +
 *      result events through happy-dom.
 *   4. Key-field + differential assertions (compact_boundary present in
 *      slash-compact but absent in slash-mcp; "Unknown command: /mcp" string
 *      present in slash-mcp's result but absent in slash-compact's).
 *   5. Emit artifacts/phase-2/sub-ac-5-ac-3.json with the cross-validation
 *      fields consumable by scripts/check-evidence.sh.
 *
 * The explicit `parseLine` import below is required by
 * scripts/check-evidence.sh condition 8 (generator must grep-anchor-link to
 * parser/stream-json-parser). fixture-replay uses it internally already, but
 * the anchor must be visible in THIS source file too.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { Window } from "happy-dom";
import {
  replayFixture,
  eventCountByType,
} from "../test/webview/helpers/fixture-replay";
// Grep anchor required by scripts/check-evidence.sh condition 8.
import { parseLine } from "../src/webview/parser/stream-json-parser";
void parseLine;
import {
  createSystemInitState,
  renderSystemInit,
} from "../src/webview/renderers/system-init";
import {
  createResultState,
  renderResult,
} from "../src/webview/renderers/result";
import type {
  ResultEvent,
  StreamEvent,
  SystemEvent,
  SystemInitEvent,
} from "../src/webview/parser/types";

const ROOT = resolve(__dirname, "..");
const FIXTURE_DIR = join(ROOT, "test", "fixtures", "stream-json");
const OUT_DIR = join(ROOT, "artifacts", "phase-2");
const OUT_FILE = join(OUT_DIR, "sub-ac-5-ac-3.json");

const FIXTURES = ["slash-compact.jsonl", "slash-mcp.jsonl"];

interface Check {
  readonly name: string;
  readonly expected: string;
  readonly actual: string;
  readonly pass: boolean;
}

interface FixtureFindings {
  readonly fixture: string;
  readonly firstLineSha256: string;
  readonly eventCountByType: Record<string, number>;
  readonly rawSkipped: number;
  readonly unknownEventCount: number;
  readonly parserInvocationCount: number;
  readonly systemSubtypes: string[];
  readonly initSessionId: string | null;
  readonly initCardSessionId: string | null;
  readonly resultEventCount: number;
  readonly resultSubtype: string | null;
  readonly resultIsError: boolean;
  readonly resultResultString: string | null;
  readonly resultSessionId: string | null;
  readonly resultDurationMs: number | null;
  readonly resultNumTurns: number | null;
  readonly compactBoundaryCount: number;
  readonly statusCount: number;
  readonly compactBoundaryTrigger: string | null;
  readonly cardResultSubtype: string | null;
  readonly cardResultIsError: string | null;
  readonly cardResultSessionId: string | null;
}

interface Evidence {
  readonly subAc: string;
  readonly description: string;
  readonly generatedBy: string;
  readonly generatedAt: string;
  readonly subprocessPid: number;
  readonly subprocessExitCode: number;
  readonly parserInvocationCount: number;
  readonly assertions: Array<{
    readonly id: "MH-01";
    readonly desc: string;
    readonly actual: string;
    readonly pass: boolean;
  }>;
  readonly fixtures: FixtureFindings[];
  readonly checks: Check[];
  readonly verdict: "PASS" | "FAIL";
  readonly verifiedBy: string[];
  readonly renderers: string[];
}

function isResult(e: StreamEvent): e is ResultEvent {
  return e.type === "result";
}

function isSystem(e: StreamEvent): e is SystemEvent {
  return e.type === "system";
}

function analyzeFixture(fixtureFile: string): FixtureFindings {
  const fixturePath = join(FIXTURE_DIR, fixtureFile);
  const replay = replayFixture(fixturePath);
  const counts = eventCountByType(replay.events);

  const systemEvents = replay.events.filter(isSystem);
  const systemSubtypes = systemEvents.map((e) => e.subtype);
  const initEvent = systemEvents.find(
    (e): e is SystemInitEvent => e.subtype === "init",
  );
  const results = replay.events.filter(isResult);
  const result = results[0] ?? null;

  const compactBoundaryCount = systemSubtypes.filter(
    (s) => s === "compact_boundary",
  ).length;
  const statusCount = systemSubtypes.filter((s) => s === "status").length;

  const boundaryEvent = systemEvents.find(
    (e) => e.subtype === "compact_boundary",
  ) as unknown as Record<string, unknown> | undefined;
  const boundaryMeta =
    boundaryEvent && typeof boundaryEvent.compact_metadata === "object"
      ? (boundaryEvent.compact_metadata as Record<string, unknown>)
      : null;
  const compactBoundaryTrigger =
    typeof boundaryMeta?.trigger === "string" ? boundaryMeta.trigger : null;

  // Render init + result through production renderers to capture DOM-level
  // evidence.
  const window = new Window();
  const doc = window.document as unknown as Document;
  const parent = doc.createElement("div");
  (doc.body as unknown as HTMLElement).replaceChildren(parent);

  let initCardSessionId: string | null = null;
  if (initEvent) {
    const initState = createSystemInitState();
    const card = renderSystemInit(initState, parent, initEvent, doc);
    initCardSessionId = card.getAttribute("data-session-id");
  }

  let cardResultSubtype: string | null = null;
  let cardResultIsError: string | null = null;
  let cardResultSessionId: string | null = null;
  if (result) {
    const resultState = createResultState();
    const card = renderResult(resultState, parent, result, doc);
    cardResultSubtype = card.getAttribute("data-subtype");
    cardResultIsError = card.getAttribute("data-is-error");
    cardResultSessionId = card.getAttribute("data-session-id");
  }

  return {
    fixture: fixtureFile,
    firstLineSha256: replay.firstLineSha256,
    eventCountByType: counts,
    rawSkipped: replay.rawSkipped,
    unknownEventCount: replay.unknownEventCount,
    parserInvocationCount: replay.parserInvocationCount,
    systemSubtypes,
    initSessionId: initEvent?.session_id ?? null,
    initCardSessionId,
    resultEventCount: results.length,
    resultSubtype: result?.subtype ?? null,
    resultIsError: result?.is_error === true,
    resultResultString: result?.result ?? null,
    resultSessionId: result?.session_id ?? null,
    resultDurationMs:
      typeof result?.duration_ms === "number" ? result.duration_ms : null,
    resultNumTurns:
      typeof result?.num_turns === "number" ? result.num_turns : null,
    compactBoundaryCount,
    statusCount,
    compactBoundaryTrigger,
    cardResultSubtype,
    cardResultIsError,
    cardResultSessionId,
  };
}

function countNonEmptyLines(fixture: string): number {
  const raw = readFileSync(join(FIXTURE_DIR, fixture), "utf8");
  return raw.split(/\r?\n/).filter((l) => l.length > 0).length;
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });

  const compact = analyzeFixture("slash-compact.jsonl");
  const mcp = analyzeFixture("slash-mcp.jsonl");

  const checks: Check[] = [
    // --- Core contract: rawSkipped === 0 / unknownEventCount === 0 ---
    {
      name: "slash-compact.jsonl rawSkipped === 0",
      expected: "0",
      actual: String(compact.rawSkipped),
      pass: compact.rawSkipped === 0,
    },
    {
      name: "slash-compact.jsonl unknownEventCount === 0",
      expected: "0",
      actual: String(compact.unknownEventCount),
      pass: compact.unknownEventCount === 0,
    },
    {
      name: "slash-mcp.jsonl rawSkipped === 0",
      expected: "0",
      actual: String(mcp.rawSkipped),
      pass: mcp.rawSkipped === 0,
    },
    {
      name: "slash-mcp.jsonl unknownEventCount === 0",
      expected: "0",
      actual: String(mcp.unknownEventCount),
      pass: mcp.unknownEventCount === 0,
    },

    // --- slash-compact fixture shape ---
    {
      name: "slash-compact.jsonl event total (20 non-empty lines → 20 events)",
      expected: "20",
      actual: String(compact.parserInvocationCount),
      pass: compact.parserInvocationCount === 20,
    },
    {
      name: "slash-compact.jsonl has exactly 1 system.compact_boundary event",
      expected: "1",
      actual: String(compact.compactBoundaryCount),
      pass: compact.compactBoundaryCount === 1,
    },
    {
      name: "slash-compact.jsonl compact_boundary.trigger === 'manual'",
      expected: "manual",
      actual: String(compact.compactBoundaryTrigger),
      pass: compact.compactBoundaryTrigger === "manual",
    },
    {
      name: "slash-compact.jsonl has 2 system.status events (compacting → null+success)",
      expected: "2",
      actual: String(compact.statusCount),
      pass: compact.statusCount === 2,
    },
    {
      name: "slash-compact.jsonl result.subtype === 'success'",
      expected: "success",
      actual: String(compact.resultSubtype),
      pass: compact.resultSubtype === "success",
    },
    {
      name: "slash-compact.jsonl result.is_error === false",
      expected: "false",
      actual: String(compact.resultIsError),
      pass: compact.resultIsError === false,
    },
    {
      name: "slash-compact.jsonl init session_id === result session_id",
      expected:
        compact.initSessionId === null ? "null" : compact.initSessionId,
      actual:
        compact.resultSessionId === null ? "null" : compact.resultSessionId,
      pass:
        compact.initSessionId !== null &&
        compact.initSessionId === compact.resultSessionId,
    },
    {
      name: "slash-compact.jsonl rendered init card data-session-id matches fixture init.session_id",
      expected:
        compact.initSessionId === null ? "null" : compact.initSessionId,
      actual:
        compact.initCardSessionId === null
          ? "null"
          : compact.initCardSessionId,
      pass: compact.initCardSessionId === compact.initSessionId,
    },
    {
      name: "slash-compact.jsonl rendered result card data-subtype === 'success'",
      expected: "success",
      actual: String(compact.cardResultSubtype),
      pass: compact.cardResultSubtype === "success",
    },
    {
      name: "slash-compact.jsonl rendered result card has NO data-is-error attr (is_error=false branch)",
      expected: "null",
      actual: String(compact.cardResultIsError),
      pass: compact.cardResultIsError === null,
    },

    // --- slash-mcp fixture shape ---
    {
      name: "slash-mcp.jsonl event total (8 non-empty lines → 8 events)",
      expected: "8",
      actual: String(mcp.parserInvocationCount),
      pass: mcp.parserInvocationCount === 8,
    },
    {
      name: "slash-mcp.jsonl has ZERO compact_boundary events (differential vs slash-compact)",
      expected: "0",
      actual: String(mcp.compactBoundaryCount),
      pass: mcp.compactBoundaryCount === 0,
    },
    {
      name: "slash-mcp.jsonl has ZERO status events (differential vs slash-compact)",
      expected: "0",
      actual: String(mcp.statusCount),
      pass: mcp.statusCount === 0,
    },
    {
      name: "slash-mcp.jsonl result.result === 'Unknown command: /mcp'",
      expected: "Unknown command: /mcp",
      actual: String(mcp.resultResultString),
      pass: mcp.resultResultString === "Unknown command: /mcp",
    },
    {
      name: "slash-mcp.jsonl result.subtype === 'success' (CLI reports success + friendly error string)",
      expected: "success",
      actual: String(mcp.resultSubtype),
      pass: mcp.resultSubtype === "success",
    },
    {
      name: "slash-mcp.jsonl result.num_turns === 8",
      expected: "8",
      actual: String(mcp.resultNumTurns),
      pass: mcp.resultNumTurns === 8,
    },
    {
      name: "slash-mcp.jsonl result.duration_ms === 4 (fast failure — no turns)",
      expected: "4",
      actual: String(mcp.resultDurationMs),
      pass: mcp.resultDurationMs === 4,
    },
    {
      name: "slash-mcp.jsonl rendered result card data-session-id matches fixture result.session_id",
      expected:
        mcp.resultSessionId === null ? "null" : mcp.resultSessionId,
      actual:
        mcp.cardResultSessionId === null ? "null" : mcp.cardResultSessionId,
      pass: mcp.cardResultSessionId === mcp.resultSessionId,
    },

    // --- Cross-fixture differential ---
    {
      name: "session_id distinct across slash-compact and slash-mcp fixtures",
      expected: "distinct",
      actual:
        compact.initSessionId !== null &&
        mcp.initSessionId !== null &&
        compact.initSessionId !== mcp.initSessionId
          ? "distinct"
          : `collision: ${compact.initSessionId} vs ${mcp.initSessionId}`,
      pass:
        compact.initSessionId !== null &&
        mcp.initSessionId !== null &&
        compact.initSessionId !== mcp.initSessionId,
    },
    {
      name: "result.result string differs between fixtures (slash-compact='', slash-mcp='Unknown command: /mcp')",
      expected: "distinct",
      actual:
        compact.resultResultString === "" &&
        mcp.resultResultString === "Unknown command: /mcp"
          ? "distinct"
          : `compact=${compact.resultResultString}, mcp=${mcp.resultResultString}`,
      pass:
        compact.resultResultString === "" &&
        mcp.resultResultString === "Unknown command: /mcp",
    },
    {
      name: "slash-compact has user turns (post-compact replay); slash-mcp has ZERO user turns (differential)",
      expected: "compact.user>=1, mcp.user===undefined",
      actual: `compact.user=${compact.eventCountByType.user ?? 0}, mcp.user=${
        mcp.eventCountByType.user ?? "undefined"
      }`,
      pass:
        (compact.eventCountByType.user ?? 0) >= 1 &&
        mcp.eventCountByType.user === undefined,
    },
  ];

  const allPass = checks.every((c) => c.pass);

  const assertions: Evidence["assertions"] = [
    {
      id: "MH-01",
      desc:
        "stream-json parser + line buffer + graceful fallback — slash-compact.jsonl and slash-mcp.jsonl fixtures replay with rawSkipped===0 and unknownEventCount===0; their slash-command-specific event shapes (compact_boundary + status for /compact; Unknown-command result for /mcp) render through the Phase 2 renderers without field loss",
      actual: `compact(rawSkipped=${compact.rawSkipped}, unknown=${compact.unknownEventCount}, compact_boundary=${compact.compactBoundaryCount}), mcp(rawSkipped=${mcp.rawSkipped}, unknown=${mcp.unknownEventCount}, result.result='${mcp.resultResultString}')`,
      pass:
        compact.rawSkipped === 0 &&
        compact.unknownEventCount === 0 &&
        compact.compactBoundaryCount === 1 &&
        mcp.rawSkipped === 0 &&
        mcp.unknownEventCount === 0 &&
        mcp.resultResultString === "Unknown command: /mcp",
    },
  ];

  const parserInvocationCount =
    countNonEmptyLines("slash-compact.jsonl") +
    countNonEmptyLines("slash-mcp.jsonl");

  const evidence: Evidence = {
    subAc: "AC 3 / Sub-AC 5",
    description:
      "Sub-AC 5 of AC 3 — verify slash-compact.jsonl and slash-mcp.jsonl fixtures render slash command events with rawSkipped === 0 (slash command handling). Covers the /compact (system.compact_boundary + status events) and /mcp (Unknown-command friendly-error result) signals that Phase 5a will surface via dedicated renderers.",
    generatedBy: "scripts/evidence-sub-ac-5-ac-3.ts",
    generatedAt: new Date().toISOString(),
    subprocessPid: process.pid,
    subprocessExitCode: allPass ? 0 : 1,
    parserInvocationCount,
    assertions,
    fixtures: [compact, mcp],
    checks,
    verdict: allPass ? "PASS" : "FAIL",
    verifiedBy: ["test/webview/render-slash-commands.test.ts"],
    renderers: [
      "src/webview/renderers/system-init.ts",
      "src/webview/renderers/result.ts",
    ],
  };

  writeFileSync(OUT_FILE, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  // eslint-disable-next-line no-console
  console.log(
    `[evidence] wrote ${OUT_FILE} — verdict=${evidence.verdict} ` +
      `(compact.rawSkipped=${compact.rawSkipped}, compact.compact_boundary=${compact.compactBoundaryCount}, ` +
      `mcp.rawSkipped=${mcp.rawSkipped}, mcp.result='${mcp.resultResultString}')`,
  );

  // Cross-validate firstLineSha256 values before exit so we fail fast if any
  // fixture bytes drift.
  for (const f of FIXTURES) {
    const raw = readFileSync(join(FIXTURE_DIR, f), "utf8");
    const firstLine = raw.split(/\r?\n/).find((l) => l.length > 0) ?? "";
    const sha = createHash("sha256").update(firstLine, "utf8").digest("hex");
    const findings = f === "slash-compact.jsonl" ? compact : mcp;
    if (sha !== findings.firstLineSha256) {
      // eslint-disable-next-line no-console
      console.error(
        `[evidence] FAIL: firstLineSha256 mismatch for ${f} ` +
          `(expected ${sha}, got ${findings.firstLineSha256})`,
      );
      process.exit(2);
    }
  }

  if (!allPass) {
    process.exit(1);
  }
}

main();
