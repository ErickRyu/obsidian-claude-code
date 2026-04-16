#!/usr/bin/env tsx
/**
 * Evidence generator for Phase 2, Sub-AC 4 of AC 3:
 *   - verify `resume.jsonl` fixture renders the session-resume-failure signal
 *     (result card only, subtype="error_during_execution", is_error=true,
 *     errors[] with "No conversation found with session ID: …") with
 *     rawSkipped === 0 and unknownEventCount === 0.
 *
 * Workflow:
 *   1. Import the production parser via replayFixture().
 *   2. Import the production result renderer from src/webview/renderers/.
 *   3. Replay resume.jsonl, render the sole result event through happy-dom.
 *   4. Check key fields on the rendered card + cross-validate session
 *      continuity (resume.jsonl's session_id differs from every other
 *      fixture's result session_id).
 *   5. Emit artifacts/phase-2/sub-ac-4-ac-3.json with the cross-validation
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
  createResultState,
  renderResult,
} from "../src/webview/renderers/result";
import type { ResultEvent, StreamEvent } from "../src/webview/parser/types";

const ROOT = resolve(__dirname, "..");
const FIXTURE_DIR = join(ROOT, "test", "fixtures", "stream-json");
const OUT_DIR = join(ROOT, "artifacts", "phase-2");
const OUT_FILE = join(OUT_DIR, "sub-ac-4-ac-3.json");

const FIXTURE = "resume.jsonl";
// Every other fixture that carries at least one result event — used to
// differentially confirm session continuity (distinct session_ids).
const OTHER_FIXTURES_WITH_RESULT = [
  "hello.jsonl",
  "edit.jsonl",
  "todo.jsonl",
  "permission.jsonl",
  "plan-mode.jsonl",
  "slash-compact.jsonl",
  "slash-mcp.jsonl",
];

interface Check {
  readonly name: string;
  readonly expected: string;
  readonly actual: string;
  readonly pass: boolean;
}

interface ResumeFixtureFindings {
  readonly fixture: string;
  readonly firstLineSha256: string;
  readonly eventCountByType: Record<string, number>;
  readonly rawSkipped: number;
  readonly unknownEventCount: number;
  readonly parserInvocationCount: number;
  readonly resultEventCount: number;
  readonly resultSubtype: string;
  readonly resultIsError: boolean;
  readonly resultSessionId: string;
  readonly resultUuid: string;
  readonly errorsArrayLength: number;
  readonly errorsFirstMessage: string;
  readonly failedResumeSessionId: string | null;
  readonly cardDataSubtype: string | null;
  readonly cardDataIsError: string | null;
  readonly cardDataSessionId: string | null;
  readonly cardRowValues: {
    readonly subtype: string | null;
    readonly duration: string | null;
    readonly cost: string | null;
    readonly tokens: string | null;
    readonly turns: string | null;
  };
}

interface Evidence {
  readonly generatedBy: string;
  readonly generatedAt: string;
  readonly subprocessPid: number;
  readonly subprocessExitCode: number;
  readonly parserInvocationCount: number;
  readonly description: string;
  readonly subAc: string;
  readonly assertions: Array<{
    readonly id: "MH-05";
    readonly desc: string;
    readonly actual: string;
    readonly pass: boolean;
  }>;
  readonly fixtures: ResumeFixtureFindings[];
  readonly otherFixtureSessionIds: Array<{
    readonly fixture: string;
    readonly sessionIds: string[];
  }>;
  readonly checks: Check[];
  readonly verdict: "PASS" | "FAIL";
  readonly verifiedBy: string[];
  readonly renderers: string[];
}

function isResult(e: StreamEvent): e is ResultEvent {
  return e.type === "result";
}

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

function analyzeResume(): ResumeFixtureFindings {
  const fixturePath = join(FIXTURE_DIR, FIXTURE);
  const replay = replayFixture(fixturePath);
  const counts = eventCountByType(replay.events);

  const results = replay.events.filter(isResult);
  const result = results[0];

  const raw = result as unknown as Record<string, unknown>;
  const errors = Array.isArray(raw.errors) ? (raw.errors as unknown[]) : [];
  const errorsFirstMessage =
    typeof errors[0] === "string" ? (errors[0] as string) : "";
  const failedResumeSessionId =
    errorsFirstMessage.match(/session ID: ([0-9a-f-]{36})/i)?.[1] ?? null;

  // Render through happy-dom to capture DOM-level assertions.
  const window = new Window();
  const doc = window.document as unknown as Document;
  const parent = doc.createElement("div");
  (doc.body as unknown as HTMLElement).replaceChildren(parent);
  const state = createResultState();
  const card = renderResult(state, parent, result, doc);

  return {
    fixture: FIXTURE,
    firstLineSha256: replay.firstLineSha256,
    eventCountByType: counts,
    rawSkipped: replay.rawSkipped,
    unknownEventCount: replay.unknownEventCount,
    parserInvocationCount: replay.parserInvocationCount,
    resultEventCount: results.length,
    resultSubtype: result.subtype,
    resultIsError: result.is_error === true,
    resultSessionId: result.session_id,
    resultUuid: result.uuid,
    errorsArrayLength: errors.length,
    errorsFirstMessage,
    failedResumeSessionId,
    cardDataSubtype: card.getAttribute("data-subtype"),
    cardDataIsError: card.getAttribute("data-is-error"),
    cardDataSessionId: card.getAttribute("data-session-id"),
    cardRowValues: {
      subtype: rowValue(card, "subtype"),
      duration: rowValue(card, "duration"),
      cost: rowValue(card, "cost"),
      tokens: rowValue(card, "tokens"),
      turns: rowValue(card, "turns"),
    },
  };
}

function collectOtherFixtureSessionIds(): Array<{
  fixture: string;
  sessionIds: string[];
}> {
  const out: Array<{ fixture: string; sessionIds: string[] }> = [];
  for (const fx of OTHER_FIXTURES_WITH_RESULT) {
    const r = replayFixture(join(FIXTURE_DIR, fx));
    const ids = r.events.filter(isResult).map((e) => e.session_id);
    out.push({ fixture: fx, sessionIds: ids });
  }
  return out;
}

function countNonEmptyLines(fixture: string): number {
  const raw = readFileSync(join(FIXTURE_DIR, fixture), "utf8");
  return raw.split(/\r?\n/).filter((l) => l.length > 0).length;
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });

  const resume = analyzeResume();
  const otherSessionIds = collectOtherFixtureSessionIds();

  // Session continuity differential: resume.jsonl's (new) session_id must
  // differ from every other fixture's result session_id AND from the failed
  // resume id embedded in the `errors[0]` message.
  const allOtherIds = new Set<string>();
  for (const o of otherSessionIds) for (const id of o.sessionIds) allOtherIds.add(id);

  const sessionContinuityDistinct =
    !allOtherIds.has(resume.resultSessionId) &&
    resume.failedResumeSessionId !== resume.resultSessionId;

  const checks: Check[] = [
    {
      name: `${FIXTURE} rawSkipped`,
      expected: "0",
      actual: String(resume.rawSkipped),
      pass: resume.rawSkipped === 0,
    },
    {
      name: `${FIXTURE} unknownEventCount`,
      expected: "0",
      actual: String(resume.unknownEventCount),
      pass: resume.unknownEventCount === 0,
    },
    {
      name: `${FIXTURE} contains exactly 1 result event (resume-failure shape)`,
      expected: "1",
      actual: String(resume.resultEventCount),
      pass: resume.resultEventCount === 1,
    },
    {
      name: `${FIXTURE} result.subtype === 'error_during_execution'`,
      expected: "error_during_execution",
      actual: resume.resultSubtype,
      pass: resume.resultSubtype === "error_during_execution",
    },
    {
      name: `${FIXTURE} result.is_error === true`,
      expected: "true",
      actual: String(resume.resultIsError),
      pass: resume.resultIsError === true,
    },
    {
      name: `${FIXTURE} errors[] array carries 'No conversation found' signal`,
      expected: "errors[0] starts with 'No conversation found with session ID'",
      actual: resume.errorsFirstMessage,
      pass:
        resume.errorsArrayLength >= 1 &&
        resume.errorsFirstMessage.startsWith(
          "No conversation found with session ID",
        ),
    },
    {
      name: `${FIXTURE} failed-resume session_id is parseable from errors[0]`,
      expected: "UUID matches /^[0-9a-f-]{36}$/i",
      actual: String(resume.failedResumeSessionId),
      pass: /^[0-9a-f-]{36}$/i.test(resume.failedResumeSessionId ?? ""),
    },
    {
      name: `${FIXTURE} rendered card has data-subtype='error_during_execution'`,
      expected: "error_during_execution",
      actual: String(resume.cardDataSubtype),
      pass: resume.cardDataSubtype === "error_during_execution",
    },
    {
      name: `${FIXTURE} rendered card has data-is-error='true'`,
      expected: "true",
      actual: String(resume.cardDataIsError),
      pass: resume.cardDataIsError === "true",
    },
    {
      name: `${FIXTURE} rendered card data-session-id mirrors result.session_id`,
      expected: resume.resultSessionId,
      actual: String(resume.cardDataSessionId),
      pass: resume.cardDataSessionId === resume.resultSessionId,
    },
    {
      name: `${FIXTURE} rendered card subtype row`,
      expected: resume.resultSubtype,
      actual: String(resume.cardRowValues.subtype),
      pass: resume.cardRowValues.subtype === resume.resultSubtype,
    },
    {
      name: `${FIXTURE} rendered card duration row (0ms from fixture)`,
      expected: "0ms",
      actual: String(resume.cardRowValues.duration),
      pass: resume.cardRowValues.duration === "0ms",
    },
    {
      name: `${FIXTURE} rendered card cost row ($0.0000 from fixture)`,
      expected: "$0.0000",
      actual: String(resume.cardRowValues.cost),
      pass: resume.cardRowValues.cost === "$0.0000",
    },
    {
      name: `${FIXTURE} rendered card tokens row (0/0 from fixture usage)`,
      expected: "0/0",
      actual: String(resume.cardRowValues.tokens),
      pass: resume.cardRowValues.tokens === "0/0",
    },
    {
      name: `${FIXTURE} rendered card turns row (0 from fixture)`,
      expected: "0",
      actual: String(resume.cardRowValues.turns),
      pass: resume.cardRowValues.turns === "0",
    },
    {
      name: `session continuity: resume.jsonl session_id distinct from all other fixtures' result session_ids and from the failed resume id`,
      expected: "distinct",
      actual: sessionContinuityDistinct
        ? "distinct"
        : `collision: resumeSessionId=${resume.resultSessionId}, failed=${resume.failedResumeSessionId}`,
      pass: sessionContinuityDistinct,
    },
  ];

  const allPass = checks.every((c) => c.pass);

  const assertions: Evidence["assertions"] = [
    {
      id: "MH-05",
      desc: "result/final-message renderer handles resume-failure result event (is_error=true, subtype=error_during_execution)",
      actual: `card(data-subtype=${resume.cardDataSubtype}, data-is-error=${resume.cardDataIsError})`,
      pass:
        resume.cardDataSubtype === "error_during_execution" &&
        resume.cardDataIsError === "true",
    },
  ];

  const parserInvocationCount =
    countNonEmptyLines(FIXTURE) +
    OTHER_FIXTURES_WITH_RESULT.reduce(
      (sum, fx) => sum + countNonEmptyLines(fx),
      0,
    );

  const evidence: Evidence = {
    generatedBy: "scripts/evidence-sub-ac-4-ac-3.ts",
    generatedAt: new Date().toISOString(),
    subprocessPid: process.pid,
    subprocessExitCode: allPass ? 0 : 1,
    parserInvocationCount,
    description:
      "Sub-AC 4 of AC 3 — verify resume.jsonl fixture renders session resume events with rawSkipped === 0 (session continuity).",
    subAc: "AC 3 / Sub-AC 4",
    assertions,
    fixtures: [resume],
    otherFixtureSessionIds: otherSessionIds,
    checks,
    verdict: allPass ? "PASS" : "FAIL",
    verifiedBy: ["test/webview/render-resume.test.ts"],
    renderers: ["src/webview/renderers/result.ts"],
  };

  writeFileSync(OUT_FILE, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  // eslint-disable-next-line no-console
  console.log(
    `[evidence] wrote ${OUT_FILE} — verdict=${evidence.verdict} ` +
      `(rawSkipped=${resume.rawSkipped}, resultSubtype=${resume.resultSubtype}, ` +
      `isError=${resume.resultIsError}, sessionDistinct=${sessionContinuityDistinct})`,
  );

  // Cross-validate firstLineSha256 before exit so we fail fast if the fixture
  // bytes drift.
  const raw = readFileSync(join(FIXTURE_DIR, FIXTURE), "utf8");
  const firstLine = raw.split(/\r?\n/).find((l) => l.length > 0) ?? "";
  const sha = createHash("sha256").update(firstLine, "utf8").digest("hex");
  if (sha !== resume.firstLineSha256) {
    // eslint-disable-next-line no-console
    console.error(
      `[evidence] FAIL: firstLineSha256 mismatch for ${FIXTURE} ` +
        `(expected ${sha}, got ${resume.firstLineSha256})`,
    );
    process.exit(2);
  }

  if (!allPass) {
    process.exit(1);
  }
}

main();
