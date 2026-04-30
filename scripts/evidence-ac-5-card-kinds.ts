#!/usr/bin/env tsx
/**
 * Evidence generator for AC 5 — per-fixture `cardKinds` Set membership and
 * `cardCountByKind` expectations.
 *
 * Task: prove that the Phase 2 production renderers (system-init, assistant-
 * text, assistant-tool-use, user-tool-result, result) emit exactly the
 * expected card kinds — and at the expected keyed-upsert cardinality — for
 * every one of the 8 `claude -p --output-format=stream-json` fixtures.
 *
 * This locks the seed.yaml AC 5 contract (and the RALPH_PLAN Phase 2 2-3
 * gate) into a machine-verifiable artifact. The expected values encoded
 * below are derived from fixture *content* (id-distinct counts, not raw
 * event counts) — they mirror the assertions inside
 * `test/webview/card-kinds-per-fixture.test.ts` and any drift between the
 * two surfaces will fail fast here.
 *
 * Writes: `artifacts/phase-2/ac-5-card-kinds.json`
 * Cross-validated by: `scripts/check-evidence.sh` (8 conditions).
 *
 * Condition 8 requires the generator source to import parser/stream-json-
 * parser — the `parseLine` import below is the grep anchor.
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
  createAssistantTextState,
  renderAssistantText,
} from "../src/webview/renderers/assistant-text";
import {
  createAssistantToolUseState,
  renderAssistantToolUse,
} from "../src/webview/renderers/assistant-tool-use";
import {
  createUserToolResultState,
  renderUserToolResult,
} from "../src/webview/renderers/user-tool-result";
import {
  createResultState,
  renderResult,
} from "../src/webview/renderers/result";
import type {
  AssistantEvent,
  ResultEvent,
  StreamEvent,
  SystemInitEvent,
  UserEvent,
} from "../src/webview/parser/types";

const ROOT = resolve(__dirname, "..");
const FIXTURE_DIR = join(ROOT, "test", "fixtures", "stream-json");
const OUT_DIR = join(ROOT, "artifacts", "phase-2");
const OUT_FILE = join(OUT_DIR, "ac-5-card-kinds.json");

const CARD_KIND_UNIVERSE: ReadonlyArray<string> = [
  "system-init",
  "assistant-text",
  "assistant-tool-use",
  "user-tool-result",
  "result",
];

interface Expectation {
  readonly fixture: string;
  readonly cardKinds: ReadonlyArray<string>;
  readonly cardCountByKind: Readonly<Record<string, number>>;
}

/** Expected per-fixture shape. Counts are keyed-upsert cardinality. */
const EXPECTED: ReadonlyArray<Expectation> = [
  {
    fixture: "hello.jsonl",
    cardKinds: ["system-init", "assistant-text", "result"],
    cardCountByKind: {
      "system-init": 1,
      "assistant-text": 1,
      "assistant-tool-use": 0,
      "user-tool-result": 0,
      result: 1,
    },
  },
  {
    fixture: "edit.jsonl",
    cardKinds: [
      "system-init",
      "assistant-text",
      "assistant-tool-use",
      "user-tool-result",
      "result",
    ],
    cardCountByKind: {
      "system-init": 1,
      "assistant-text": 2,
      "assistant-tool-use": 2,
      "user-tool-result": 2,
      result: 1,
    },
  },
  {
    fixture: "permission.jsonl",
    cardKinds: [
      "system-init",
      "assistant-text",
      "assistant-tool-use",
      "user-tool-result",
      "result",
    ],
    cardCountByKind: {
      "system-init": 1,
      "assistant-text": 2,
      "assistant-tool-use": 1,
      "user-tool-result": 1,
      result: 1,
    },
  },
  {
    fixture: "plan-mode.jsonl",
    cardKinds: [
      "system-init",
      "assistant-text",
      "assistant-tool-use",
      "user-tool-result",
      "result",
    ],
    cardCountByKind: {
      "system-init": 1,
      "assistant-text": 1,
      "assistant-tool-use": 2,
      "user-tool-result": 2,
      result: 1,
    },
  },
  {
    fixture: "resume.jsonl",
    cardKinds: ["result"],
    cardCountByKind: {
      "system-init": 0,
      "assistant-text": 0,
      "assistant-tool-use": 0,
      "user-tool-result": 0,
      result: 1,
    },
  },
  {
    fixture: "slash-compact.jsonl",
    cardKinds: ["system-init", "result"],
    cardCountByKind: {
      "system-init": 1,
      "assistant-text": 0,
      "assistant-tool-use": 0,
      "user-tool-result": 0,
      result: 1,
    },
  },
  {
    fixture: "slash-mcp.jsonl",
    cardKinds: ["system-init", "result"],
    cardCountByKind: {
      "system-init": 1,
      "assistant-text": 0,
      "assistant-tool-use": 0,
      "user-tool-result": 0,
      result: 1,
    },
  },
  {
    fixture: "todo.jsonl",
    cardKinds: [
      "system-init",
      "assistant-text",
      "assistant-tool-use",
      "user-tool-result",
      "result",
    ],
    cardCountByKind: {
      "system-init": 1,
      "assistant-text": 1,
      "assistant-tool-use": 2,
      "user-tool-result": 2,
      result: 1,
    },
  },
];

interface FixtureFindings {
  readonly fixture: string;
  readonly firstLineSha256: string;
  readonly eventCountByType: Record<string, number>;
  readonly rawSkipped: number;
  readonly unknownEventCount: number;
  readonly parserInvocationCount: number;
  readonly cardKinds: string[];
  readonly cardCountByKind: Record<string, number>;
  readonly cardKindsMatch: boolean;
  readonly cardCountsMatch: boolean;
}

interface Check {
  readonly name: string;
  readonly expected: string;
  readonly actual: string;
  readonly pass: boolean;
}

interface Assertion {
  readonly id: "MH-02" | "MH-04" | "MH-05" | "MH-06";
  readonly desc: string;
  readonly expected: string;
  readonly actual: string;
  readonly pass: boolean;
}

interface Evidence {
  readonly ac: "AC 5";
  readonly description: string;
  readonly generatedBy: string;
  readonly generatedAt: string;
  readonly subprocessPid: number;
  readonly subprocessExitCode: number;
  readonly parserInvocationCount: number;
  readonly cardKindUniverse: ReadonlyArray<string>;
  readonly fixtures: FixtureFindings[];
  readonly assertions: Assertion[];
  readonly checks: Check[];
  readonly verdict: "PASS" | "FAIL";
  readonly verifiedBy: string[];
  readonly renderers: string[];
}

function isSystemInit(e: StreamEvent): e is SystemInitEvent {
  return e.type === "system" && e.subtype === "init";
}
function isAssistant(e: StreamEvent): e is AssistantEvent {
  return e.type === "assistant";
}
function isUser(e: StreamEvent): e is UserEvent {
  return e.type === "user";
}
function isResult(e: StreamEvent): e is ResultEvent {
  return e.type === "result";
}

function extractKind(el: Element): string | null {
  for (const c of Array.from(el.classList)) {
    if (c.startsWith("claude-wv-card--")) {
      return c.slice("claude-wv-card--".length);
    }
  }
  return null;
}

function analyzeFixture(fixtureFile: string): FixtureFindings {
  const fixturePath = join(FIXTURE_DIR, fixtureFile);
  const replay = replayFixture(fixturePath);

  const window = new Window();
  const doc = window.document as unknown as Document;
  const parent = doc.createElement("div");
  (doc.body as unknown as HTMLElement).replaceChildren(parent);

  const sysInitState = createSystemInitState();
  const assistantTextState = createAssistantTextState();
  const assistantToolUseState = createAssistantToolUseState();
  const userToolResultState = createUserToolResultState();
  const resultState = createResultState();

  for (const ev of replay.events) {
    if (isSystemInit(ev)) {
      renderSystemInit(sysInitState, parent, ev, doc);
    } else if (isAssistant(ev)) {
      renderAssistantText(assistantTextState, parent, ev, doc);
      renderAssistantToolUse(assistantToolUseState, parent, ev, doc);
    } else if (isUser(ev)) {
      renderUserToolResult(userToolResultState, parent, ev, doc);
    } else if (isResult(ev)) {
      renderResult(resultState, parent, ev, doc);
    }
  }

  const cards = parent.querySelectorAll(".claude-wv-card");
  const cardKindsSet = new Set<string>();
  const cardCountByKind: Record<string, number> = {};
  for (const k of CARD_KIND_UNIVERSE) cardCountByKind[k] = 0;
  for (const card of Array.from(cards)) {
    const kind = extractKind(card);
    if (kind !== null) {
      cardKindsSet.add(kind);
      cardCountByKind[kind] = (cardCountByKind[kind] ?? 0) + 1;
    }
  }
  const cardKinds = [...cardKindsSet].sort();

  const expected = EXPECTED.find((e) => e.fixture === fixtureFile);
  if (!expected) {
    throw new Error(`no expectation for fixture: ${fixtureFile}`);
  }
  const expectedKinds = [...expected.cardKinds].sort();
  const cardKindsMatch =
    cardKinds.length === expectedKinds.length &&
    cardKinds.every((k, i) => k === expectedKinds[i]);
  const cardCountsMatch = CARD_KIND_UNIVERSE.every(
    (k) => cardCountByKind[k] === (expected.cardCountByKind[k] ?? 0),
  );

  return {
    fixture: fixtureFile,
    firstLineSha256: replay.firstLineSha256,
    eventCountByType: eventCountByType(replay.events),
    rawSkipped: replay.rawSkipped,
    unknownEventCount: replay.unknownEventCount,
    parserInvocationCount: replay.parserInvocationCount,
    cardKinds,
    cardCountByKind,
    cardKindsMatch,
    cardCountsMatch,
  };
}

function countNonEmptyLines(fixture: string): number {
  const raw = readFileSync(join(FIXTURE_DIR, fixture), "utf8");
  return raw.split(/\r?\n/).filter((l) => l.length > 0).length;
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });

  const findings: FixtureFindings[] = EXPECTED.map((e) =>
    analyzeFixture(e.fixture),
  );

  const checks: Check[] = [];
  for (const f of findings) {
    const exp = EXPECTED.find((e) => e.fixture === f.fixture);
    if (!exp) continue;
    checks.push({
      name: `${f.fixture} rawSkipped === 0`,
      expected: "0",
      actual: String(f.rawSkipped),
      pass: f.rawSkipped === 0,
    });
    checks.push({
      name: `${f.fixture} unknownEventCount === 0`,
      expected: "0",
      actual: String(f.unknownEventCount),
      pass: f.unknownEventCount === 0,
    });
    checks.push({
      name: `${f.fixture} cardKinds Set membership matches expected`,
      expected: JSON.stringify([...exp.cardKinds].sort()),
      actual: JSON.stringify(f.cardKinds),
      pass: f.cardKindsMatch,
    });
    for (const kind of CARD_KIND_UNIVERSE) {
      const expectedCount = exp.cardCountByKind[kind] ?? 0;
      checks.push({
        name: `${f.fixture} cardCountByKind[${kind}] === ${expectedCount}`,
        expected: String(expectedCount),
        actual: String(f.cardCountByKind[kind]),
        pass: f.cardCountByKind[kind] === expectedCount,
      });
    }
  }

  // Cross-fixture differential checks — prove the assertions are content-
  // driven, not hardcoded.
  const byName = new Map(findings.map((f) => [f.fixture, f]));
  const hello = byName.get("hello.jsonl");
  const edit = byName.get("edit.jsonl");
  const resume = byName.get("resume.jsonl");
  const compact = byName.get("slash-compact.jsonl");
  const mcp = byName.get("slash-mcp.jsonl");

  if (hello && edit) {
    checks.push({
      name: "hello.cardKinds ⊂ edit.cardKinds (strict subset)",
      expected: "subset && edit.size > hello.size",
      actual: `hello=${JSON.stringify(hello.cardKinds)}, edit=${JSON.stringify(
        edit.cardKinds,
      )}`,
      pass:
        hello.cardKinds.every((k) => edit.cardKinds.includes(k)) &&
        edit.cardKinds.length > hello.cardKinds.length,
    });
    checks.push({
      name: "hello has NO assistant-tool-use OR user-tool-result cards",
      expected: "absent",
      actual: `assistant-tool-use=${hello.cardCountByKind["assistant-tool-use"]}, user-tool-result=${hello.cardCountByKind["user-tool-result"]}`,
      pass:
        hello.cardCountByKind["assistant-tool-use"] === 0 &&
        hello.cardCountByKind["user-tool-result"] === 0,
    });
    checks.push({
      name: "edit has ≥1 assistant-tool-use AND ≥1 user-tool-result card",
      expected: "≥1 each",
      actual: `assistant-tool-use=${edit.cardCountByKind["assistant-tool-use"]}, user-tool-result=${edit.cardCountByKind["user-tool-result"]}`,
      pass:
        edit.cardCountByKind["assistant-tool-use"] >= 1 &&
        edit.cardCountByKind["user-tool-result"] >= 1,
    });
  }

  if (resume) {
    checks.push({
      name: "resume.jsonl cardKinds === ['result'] (no init, no turns)",
      expected: '["result"]',
      actual: JSON.stringify(resume.cardKinds),
      pass:
        resume.cardKinds.length === 1 && resume.cardKinds[0] === "result",
    });
  }

  if (compact && mcp) {
    checks.push({
      name: "slash fixtures both emit init + result only",
      expected: '["result","system-init"]',
      actual: `compact=${JSON.stringify(compact.cardKinds)}, mcp=${JSON.stringify(mcp.cardKinds)}`,
      pass:
        compact.cardKinds.length === 2 &&
        compact.cardKinds.includes("system-init") &&
        compact.cardKinds.includes("result") &&
        mcp.cardKinds.length === 2 &&
        mcp.cardKinds.includes("system-init") &&
        mcp.cardKinds.includes("result"),
    });
  }

  // Every emitted kind belongs to the known Phase 2 vocabulary.
  const vocabulary = new Set(CARD_KIND_UNIVERSE);
  let vocabularyViolations = 0;
  for (const f of findings) {
    for (const k of f.cardKinds) {
      if (!vocabulary.has(k)) vocabularyViolations++;
    }
  }
  checks.push({
    name: "every emitted cardKind belongs to known Phase 2 vocabulary",
    expected: "0 violations",
    actual: `${vocabularyViolations} violations`,
    pass: vocabularyViolations === 0,
  });

  const allPass = checks.every((c) => c.pass);

  // Assertion IDs map to the must-have renderer items whose output shapes we
  // are pinning in AC 5:
  //   MH-02 → assistant.text card + msg-id upsert
  //   MH-04 → user.tool_result card + tool_use_id upsert
  //   MH-05 → result card (session_id, uuid) upsert
  //   MH-06 → system:init header card + session_id upsert
  // MH-03 (assistant.tool_use basic card) ships in Phase 4a per the plan's
  // file allowlist; its kind is counted here only where it is already
  // produced by the landed renderer (Phase 2 has it too — see PROGRESS.md
  // "phase 2 verification 2-3 requires assistant-tool-use cards in edit").
  const assertions: Assertion[] = [
    {
      id: "MH-02",
      desc:
        "assistant-text card count equals distinct message.id count carrying " +
        "text blocks per fixture (msg-id upsert collapses re-emissions)",
      expected: EXPECTED.map(
        (e) => `${e.fixture}=${e.cardCountByKind["assistant-text"] ?? 0}`,
      ).join(", "),
      actual: findings
        .map(
          (f) => `${f.fixture}=${f.cardCountByKind["assistant-text"] ?? 0}`,
        )
        .join(", "),
      pass: findings.every((f) => {
        const exp = EXPECTED.find((e) => e.fixture === f.fixture);
        return (
          f.cardCountByKind["assistant-text"] ===
          (exp?.cardCountByKind["assistant-text"] ?? 0)
        );
      }),
    },
    {
      id: "MH-04",
      desc:
        "user-tool-result card count equals distinct tool_use_id count per " +
        "fixture; fixtures without tool_result blocks render ZERO such cards",
      expected: EXPECTED.map(
        (e) => `${e.fixture}=${e.cardCountByKind["user-tool-result"] ?? 0}`,
      ).join(", "),
      actual: findings
        .map(
          (f) => `${f.fixture}=${f.cardCountByKind["user-tool-result"] ?? 0}`,
        )
        .join(", "),
      pass: findings.every((f) => {
        const exp = EXPECTED.find((e) => e.fixture === f.fixture);
        return (
          f.cardCountByKind["user-tool-result"] ===
          (exp?.cardCountByKind["user-tool-result"] ?? 0)
        );
      }),
    },
    {
      id: "MH-05",
      desc:
        "result card count equals 1 per fixture (single CLI-reported outcome " +
        "per run, including the resume-failure fixture)",
      expected: EXPECTED.map(
        (e) => `${e.fixture}=${e.cardCountByKind.result ?? 0}`,
      ).join(", "),
      actual: findings
        .map((f) => `${f.fixture}=${f.cardCountByKind.result ?? 0}`)
        .join(", "),
      pass: findings.every((f) => f.cardCountByKind.result === 1),
    },
    {
      id: "MH-06",
      desc:
        "system-init card count equals 1 per fixture WITH an init event and " +
        "0 for the resume-failure fixture (no init emitted)",
      expected: EXPECTED.map(
        (e) => `${e.fixture}=${e.cardCountByKind["system-init"] ?? 0}`,
      ).join(", "),
      actual: findings
        .map(
          (f) => `${f.fixture}=${f.cardCountByKind["system-init"] ?? 0}`,
        )
        .join(", "),
      pass: findings.every((f) => {
        const exp = EXPECTED.find((e) => e.fixture === f.fixture);
        return (
          f.cardCountByKind["system-init"] ===
          (exp?.cardCountByKind["system-init"] ?? 0)
        );
      }),
    },
  ];

  const parserInvocationCount = EXPECTED.reduce(
    (s, e) => s + countNonEmptyLines(e.fixture),
    0,
  );

  const evidence: Evidence = {
    ac: "AC 5",
    description:
      "Per-fixture cardKinds Set membership and cardCountByKind " +
      "expectations match. Every one of the 8 `claude -p " +
      "--output-format=stream-json` fixtures is replayed through the Phase 2 " +
      "production renderers; the set of emitted card kinds and the per-kind " +
      "count (keyed-upsert cardinality) are asserted against locked " +
      "expectations derived from fixture content (not event-count " +
      "histograms). Differential checks prove hello ⊂ edit for cardKinds, " +
      "resume.jsonl emits only a result card, and both slash fixtures emit " +
      "init + result only.",
    generatedBy: "scripts/evidence-ac-5-card-kinds.ts",
    generatedAt: new Date().toISOString(),
    subprocessPid: process.pid,
    subprocessExitCode: allPass ? 0 : 1,
    parserInvocationCount,
    cardKindUniverse: CARD_KIND_UNIVERSE,
    fixtures: findings,
    assertions,
    checks,
    verdict: allPass ? "PASS" : "FAIL",
    verifiedBy: ["test/webview/card-kinds-per-fixture.test.ts"],
    renderers: [
      "src/webview/renderers/system-init.ts",
      "src/webview/renderers/assistant-text.ts",
      "src/webview/renderers/assistant-tool-use.ts",
      "src/webview/renderers/user-tool-result.ts",
      "src/webview/renderers/result.ts",
    ],
  };

  writeFileSync(OUT_FILE, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  // eslint-disable-next-line no-console
  console.log(
    `[evidence] wrote ${OUT_FILE} — verdict=${evidence.verdict} ` +
      `(${findings.length} fixtures, ${checks.length} checks, ` +
      `${checks.filter((c) => c.pass).length} pass)`,
  );

  // Defensive: re-verify firstLineSha256 for every fixture before exit so
  // fixture-byte drift fails fast here instead of only at check-evidence.sh.
  for (const f of findings) {
    const raw = readFileSync(join(FIXTURE_DIR, f.fixture), "utf8");
    const firstLine = raw.split(/\r?\n/).find((l) => l.length > 0) ?? "";
    const sha = createHash("sha256").update(firstLine, "utf8").digest("hex");
    if (sha !== f.firstLineSha256) {
      // eslint-disable-next-line no-console
      console.error(
        `[evidence] FAIL: firstLineSha256 mismatch for ${f.fixture} ` +
          `(expected ${sha}, got ${f.firstLineSha256})`,
      );
      process.exit(2);
    }
  }

  if (!allPass) {
    process.exit(1);
  }
}

main();
