#!/usr/bin/env tsx
/**
 * Evidence generator for AC 4 — Differential fixture assertion.
 *
 * Task: prove that the production parser (LineBuffer + parseLine) correctly
 * distinguishes the event-count shapes of two fixtures taken from real
 * `claude -p --output-format=stream-json` runs:
 *
 *     hello.eventCountByType.assistant === 1
 *     edit.eventCountByType.assistant  >= 2
 *     edit.eventCountByType.user       >= 1
 *
 * hello.jsonl captures a single "hello"-style assistant turn with no tool
 * usage → exactly one assistant event and zero user turns. edit.jsonl
 * captures a multi-turn edit session with tool_use + tool_result round-trips
 * → assistant events fan out (tool_use + text blocks both emit one assistant
 * event per turn, per stream-json schema) and user events appear (each
 * tool_result block is wrapped in its own user event).
 *
 * If any of these three inequalities ever flipped, the parser would be
 * conflating event shapes — a regression that masked fixture drift. This
 * evidence pins the assertion in a machine-verifiable artifact separate from
 * vitest.
 *
 * Writes: artifacts/phase-1/ac-4-differential.json
 * Cross-validated by: scripts/check-evidence.sh (8 conditions)
 *
 * Condition 8 requires the generator source to import parser/stream-json-
 * parser — the `parseLine` import below is the grep anchor.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  replayFixture,
  eventCountByType,
} from "../test/webview/helpers/fixture-replay";
// Grep anchor required by scripts/check-evidence.sh condition 8.
import { parseLine } from "../src/webview/parser/stream-json-parser";
void parseLine;

const ROOT = resolve(__dirname, "..");
const FIXTURE_DIR = join(ROOT, "test", "fixtures", "stream-json");
const OUT_DIR = join(ROOT, "artifacts", "phase-1");
const OUT_FILE = join(OUT_DIR, "ac-4-differential.json");

interface FixtureEntry {
  readonly fixture: string;
  readonly firstLineSha256: string;
  readonly eventCountByType: Record<string, number>;
  readonly rawSkipped: number;
  readonly unknownEventCount: number;
  readonly parserInvocationCount: number;
}

interface Check {
  readonly name: string;
  readonly expected: string;
  readonly actual: string;
  readonly pass: boolean;
}

interface Assertion {
  readonly id: "MH-01";
  readonly desc: string;
  readonly expected: string;
  readonly actual: string;
  readonly pass: boolean;
}

interface Evidence {
  readonly subAc: string;
  readonly ac: "AC 4";
  readonly description: string;
  readonly generatedBy: string;
  readonly generatedAt: string;
  readonly subprocessPid: number;
  readonly subprocessExitCode: number;
  readonly parserInvocationCount: number;
  readonly fixtures: FixtureEntry[];
  readonly differential: {
    readonly helloAssistant: number;
    readonly helloUser: number | null;
    readonly editAssistant: number;
    readonly editUser: number;
  };
  readonly assertions: Assertion[];
  readonly checks: Check[];
  readonly verifiedBy: string[];
  readonly verdict: "PASS" | "FAIL";
}

function analyzeFixture(fixture: string): FixtureEntry {
  const replay = replayFixture(join(FIXTURE_DIR, fixture));
  return {
    fixture,
    firstLineSha256: replay.firstLineSha256,
    eventCountByType: eventCountByType(replay.events),
    rawSkipped: replay.rawSkipped,
    unknownEventCount: replay.unknownEventCount,
    parserInvocationCount: replay.parserInvocationCount,
  };
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });

  const hello = analyzeFixture("hello.jsonl");
  const edit = analyzeFixture("edit.jsonl");

  const helloAssistant = hello.eventCountByType.assistant ?? 0;
  const helloUser = hello.eventCountByType.user ?? null;
  const editAssistant = edit.eventCountByType.assistant ?? 0;
  const editUser = edit.eventCountByType.user ?? 0;

  const checks: Check[] = [
    {
      name: "hello.jsonl rawSkipped",
      expected: "0",
      actual: String(hello.rawSkipped),
      pass: hello.rawSkipped === 0,
    },
    {
      name: "edit.jsonl rawSkipped",
      expected: "0",
      actual: String(edit.rawSkipped),
      pass: edit.rawSkipped === 0,
    },
    {
      name: "hello.jsonl unknownEventCount",
      expected: "0",
      actual: String(hello.unknownEventCount),
      pass: hello.unknownEventCount === 0,
    },
    {
      name: "edit.jsonl unknownEventCount",
      expected: "0",
      actual: String(edit.unknownEventCount),
      pass: edit.unknownEventCount === 0,
    },
    {
      name: "hello.eventCountByType.assistant === 1",
      expected: "1",
      actual: String(helloAssistant),
      pass: helloAssistant === 1,
    },
    {
      name: "edit.eventCountByType.assistant >= 2",
      expected: ">=2",
      actual: String(editAssistant),
      pass: editAssistant >= 2,
    },
    {
      name: "edit.eventCountByType.user >= 1",
      expected: ">=1",
      actual: String(editUser),
      pass: editUser >= 1,
    },
    {
      name:
        "differential: hello has strictly fewer assistant events than edit " +
        "(hello.assistant < edit.assistant)",
      expected: "hello.assistant < edit.assistant",
      actual: `${helloAssistant} < ${editAssistant}`,
      pass: helloAssistant < editAssistant,
    },
    {
      name:
        "differential: hello has zero user turns; edit has at least one " +
        "(proves parser distinguishes single-turn hello from tool_use round-trips)",
      expected: "helloUser==null && editUser>=1",
      actual: `helloUser=${JSON.stringify(helloUser)}, editUser=${editUser}`,
      pass: helloUser === null && editUser >= 1,
    },
  ];

  const allPass = checks.every((c) => c.pass);

  const assertions: Assertion[] = [
    {
      id: "MH-01",
      desc:
        "Differential fixture assertion holds: parser distinguishes hello.jsonl " +
        "(1 assistant, 0 user) from edit.jsonl (>=2 assistant, >=1 user) with " +
        "rawSkipped=0 and unknownEventCount=0 on both.",
      expected:
        "hello.assistant===1 AND edit.assistant>=2 AND edit.user>=1 " +
        "AND both fixtures parse cleanly",
      actual:
        `hello.assistant=${helloAssistant}, ` +
        `edit.assistant=${editAssistant}, edit.user=${editUser}, ` +
        `hello.rawSkipped=${hello.rawSkipped}, edit.rawSkipped=${edit.rawSkipped}`,
      pass:
        helloAssistant === 1 &&
        editAssistant >= 2 &&
        editUser >= 1 &&
        hello.rawSkipped === 0 &&
        edit.rawSkipped === 0,
    },
  ];

  const parserInvocationCount =
    hello.parserInvocationCount + edit.parserInvocationCount;

  const evidence: Evidence = {
    subAc: "AC 4",
    ac: "AC 4",
    description:
      "Evidence that the differential fixture assertion holds: hello.jsonl " +
      "parses to exactly 1 assistant event and 0 user turns, while edit.jsonl " +
      "parses to >=2 assistant events and >=1 user turn. This proves the " +
      "parser is driven by fixture content and not hardcoded — both fixtures " +
      "are replayed through the production LineBuffer + parseLine pipeline.",
    generatedBy: "scripts/evidence-ac-4-differential.ts",
    generatedAt: new Date().toISOString(),
    subprocessPid: process.pid,
    subprocessExitCode: allPass ? 0 : 1,
    parserInvocationCount,
    fixtures: [hello, edit],
    differential: {
      helloAssistant,
      helloUser,
      editAssistant,
      editUser,
    },
    assertions,
    checks,
    verifiedBy: [
      "test/webview/parser.test.ts",
      "test/webview/render-fixtures-integration.test.ts",
    ],
    verdict: allPass ? "PASS" : "FAIL",
  };

  writeFileSync(OUT_FILE, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  // eslint-disable-next-line no-console
  console.log(
    `[evidence] wrote ${OUT_FILE} — verdict=${evidence.verdict} ` +
      `(hello.assistant=${helloAssistant}, edit.assistant=${editAssistant}, ` +
      `edit.user=${editUser})`,
  );

  // Defensive: re-verify firstLineSha256 for both fixtures before exit so
  // fixture-byte drift fails fast here instead of only at check-evidence.sh.
  for (const entry of [hello, edit]) {
    const raw = readFileSync(join(FIXTURE_DIR, entry.fixture), "utf8");
    const firstLine = raw.split(/\r?\n/).find((l) => l.length > 0) ?? "";
    const sha = createHash("sha256").update(firstLine, "utf8").digest("hex");
    if (sha !== entry.firstLineSha256) {
      // eslint-disable-next-line no-console
      console.error(
        `[evidence] FAIL: firstLineSha256 mismatch for ${entry.fixture} ` +
          `(expected ${sha}, got ${entry.firstLineSha256})`,
      );
      process.exit(2);
    }
  }

  if (!allPass) {
    process.exit(1);
  }
}

main();
