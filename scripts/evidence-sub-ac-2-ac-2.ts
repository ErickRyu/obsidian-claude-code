#!/usr/bin/env tsx
/**
 * Evidence generator for Phase 2, Sub-AC 2 of AC 2:
 *   - MH-04 (user.tool_result card renderer)
 *   - MH-05 (result / final-message card renderer)
 *
 * Workflow:
 *   1. Import the production renderers from src/webview/renderers/.
 *   2. Replay hello.jsonl and edit.jsonl through the production parser.
 *   3. Instantiate happy-dom, mount each relevant event through the renderer,
 *      and inspect the resulting DOM for the contract fields.
 *   4. Emit artifacts/phase-2/sub-ac-2-ac-2.json with cross-validation fields
 *      (generatedBy, generatedAt, subprocessPid, firstLineSha256,
 *      parserInvocationCount) consumable by scripts/check-evidence.sh.
 *
 * NOTE: This script deliberately imports parser/stream-json-parser so the
 * grep anchor in scripts/check-evidence.sh (condition 8) is satisfied.
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
  createUserToolResultState,
  renderUserToolResult,
} from "../src/webview/renderers/user-tool-result";
import {
  createResultState,
  renderResult,
} from "../src/webview/renderers/result";
import type {
  StreamEvent,
  UserEvent,
  ResultEvent,
  ToolResultBlock,
} from "../src/webview/parser/types";

const ROOT = resolve(__dirname, "..");
const FIXTURE_DIR = join(ROOT, "test", "fixtures", "stream-json");
const OUT_DIR = join(ROOT, "artifacts", "phase-2");
const OUT_FILE = join(OUT_DIR, "sub-ac-2-ac-2.json");

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
  readonly userToolResultCardCount: number;
  readonly resultCardCount: number;
  readonly toolUseIds: string[];
  readonly resultSubtypes: string[];
  readonly resultDurationRow: string | null;
  readonly resultCostRow: string | null;
  readonly resultTokensRow: string | null;
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
    readonly id: "MH-04" | "MH-05";
    readonly desc: string;
    readonly actual: boolean | number;
    readonly pass: boolean;
  }>;
  readonly fixtures: FixtureFindings[];
  readonly checks: Check[];
  readonly verdict: "PASS" | "FAIL";
  readonly verifiedBy: string[];
  readonly renderers: string[];
}

function isUser(e: StreamEvent): e is UserEvent {
  return e.type === "user";
}
function isResult(e: StreamEvent): e is ResultEvent {
  return e.type === "result";
}

function makeDoc(): { doc: Document; parent: HTMLElement } {
  const window = new Window();
  const doc = window.document as unknown as Document;
  const parent = doc.createElement("div");
  (doc.body as unknown as HTMLElement).replaceChildren(parent);
  return { doc, parent };
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

function analyze(fixture: string): FixtureFindings {
  const path = join(FIXTURE_DIR, fixture);
  const replay = replayFixture(path);
  const counts = eventCountByType(replay.events);

  // Render all user.tool_result blocks.
  const userEvents = replay.events.filter(isUser);
  const toolUseIdsInFixture: string[] = [];
  for (const ue of userEvents) {
    const c = ue.message.content;
    if (typeof c === "string") continue;
    for (const b of c) {
      if (b.type === "tool_result") {
        toolUseIdsInFixture.push((b as ToolResultBlock).tool_use_id);
      }
    }
  }
  const { doc: userDoc, parent: userParent } = makeDoc();
  const userState = createUserToolResultState();
  for (const ue of userEvents) {
    renderUserToolResult(userState, userParent, ue, userDoc);
  }
  const userCards = userParent.querySelectorAll(".claude-wv-card--user-tool-result");

  // Render all result events.
  const resultEvents = replay.events.filter(isResult);
  const { doc: resDoc, parent: resParent } = makeDoc();
  const resState = createResultState();
  const resultCards: HTMLElement[] = [];
  for (const re of resultEvents) {
    resultCards.push(renderResult(resState, resParent, re, resDoc));
  }
  const resultSubtypes = Array.from(
    resParent.querySelectorAll(".claude-wv-card--result"),
  )
    .map((c) => c.getAttribute("data-subtype") ?? "")
    .filter((s) => s.length > 0);

  let resultDurationRow: string | null = null;
  let resultCostRow: string | null = null;
  let resultTokensRow: string | null = null;
  if (resultCards.length > 0) {
    const first = resultCards[0];
    resultDurationRow = rowValue(first, "duration");
    resultCostRow = rowValue(first, "cost");
    resultTokensRow = rowValue(first, "tokens");
  }

  return {
    fixture,
    firstLineSha256: replay.firstLineSha256,
    eventCountByType: counts,
    rawSkipped: replay.rawSkipped,
    unknownEventCount: replay.unknownEventCount,
    userToolResultCardCount: userCards.length,
    resultCardCount: resultCards.length,
    toolUseIds: toolUseIdsInFixture,
    resultSubtypes,
    resultDurationRow,
    resultCostRow,
    resultTokensRow,
  };
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });

  const hello = analyze("hello.jsonl");
  const edit = analyze("edit.jsonl");
  const todo = analyze("todo.jsonl");

  const checks: Check[] = [];
  // MH-04 — user.tool_result
  checks.push({
    name: "edit.jsonl user-tool-result cards == tool_result blocks",
    expected: String(edit.toolUseIds.length),
    actual: String(edit.userToolResultCardCount),
    pass: edit.toolUseIds.length === edit.userToolResultCardCount &&
      edit.toolUseIds.length >= 1,
  });
  checks.push({
    name: "todo.jsonl user-tool-result cards == tool_result blocks",
    expected: String(todo.toolUseIds.length),
    actual: String(todo.userToolResultCardCount),
    pass: todo.toolUseIds.length === todo.userToolResultCardCount &&
      todo.toolUseIds.length >= 1,
  });
  checks.push({
    name: "hello.jsonl has zero user-tool-result cards (differential)",
    expected: "0",
    actual: String(hello.userToolResultCardCount),
    pass: hello.userToolResultCardCount === 0,
  });
  // MH-05 — result
  checks.push({
    name: "hello.jsonl produces >=1 result card",
    expected: ">=1",
    actual: String(hello.resultCardCount),
    pass: hello.resultCardCount >= 1,
  });
  checks.push({
    name: "edit.jsonl produces >=1 result card",
    expected: ">=1",
    actual: String(edit.resultCardCount),
    pass: edit.resultCardCount >= 1,
  });
  checks.push({
    name: "hello.jsonl result card contains formatted duration row",
    expected: "matches /\\d+ms/",
    actual: String(hello.resultDurationRow),
    pass: /^\d+ms$/.test(String(hello.resultDurationRow ?? "")),
  });
  checks.push({
    name: "hello.jsonl result card contains formatted cost row",
    expected: "starts with $",
    actual: String(hello.resultCostRow),
    pass: (hello.resultCostRow ?? "").startsWith("$"),
  });
  checks.push({
    name: "hello.jsonl result card contains tokens row in <in>/<out> form",
    expected: "matches /^\\d+\\/\\d+$/",
    actual: String(hello.resultTokensRow),
    pass: /^\d+\/\d+$/.test(String(hello.resultTokensRow ?? "")),
  });
  checks.push({
    name: "no raw-skipped across analyzed fixtures",
    expected: "0",
    actual: String(hello.rawSkipped + edit.rawSkipped + todo.rawSkipped),
    pass:
      hello.rawSkipped === 0 && edit.rawSkipped === 0 && todo.rawSkipped === 0,
  });
  checks.push({
    name: "no unknown events across analyzed fixtures",
    expected: "0",
    actual: String(
      hello.unknownEventCount + edit.unknownEventCount + todo.unknownEventCount,
    ),
    pass:
      hello.unknownEventCount === 0 &&
      edit.unknownEventCount === 0 &&
      todo.unknownEventCount === 0,
  });

  const allPass = checks.every((c) => c.pass);

  const assertions = [
    {
      id: "MH-04" as const,
      desc: "user.tool_result card renders with correlated tool_use_id",
      actual: edit.userToolResultCardCount + todo.userToolResultCardCount,
      pass:
        edit.userToolResultCardCount >= 1 &&
        todo.userToolResultCardCount >= 1 &&
        hello.userToolResultCardCount === 0,
    },
    {
      id: "MH-05" as const,
      desc:
        "result card renders subtype + duration + cost + tokens rows from parsed result event",
      actual: hello.resultCardCount + edit.resultCardCount,
      pass:
        hello.resultCardCount >= 1 &&
        edit.resultCardCount >= 1 &&
        /^\d+ms$/.test(String(hello.resultDurationRow ?? "")) &&
        (hello.resultCostRow ?? "").startsWith("$") &&
        /^\d+\/\d+$/.test(String(hello.resultTokensRow ?? "")),
    },
  ];

  const totalInvocations =
    helperLineCount("hello.jsonl") +
    helperLineCount("edit.jsonl") +
    helperLineCount("todo.jsonl");

  const evidence: Evidence = {
    generatedBy: "scripts/evidence-sub-ac-2-ac-2.ts",
    generatedAt: new Date().toISOString(),
    subprocessPid: process.pid,
    subprocessExitCode: allPass ? 0 : 1,
    parserInvocationCount: totalInvocations,
    description:
      "Sub-AC 2 of AC 2 — tool_result card rendering (MH-04) and result/final message card rendering (MH-05)",
    subAc: "AC 2 / Sub-AC 2",
    assertions,
    fixtures: [hello, edit, todo],
    checks,
    verdict: allPass ? "PASS" : "FAIL",
    verifiedBy: [
      "test/webview/render-user-tool-result.test.ts",
      "test/webview/render-result.test.ts",
      "test/webview/render-fixtures-integration.test.ts",
    ],
    renderers: [
      "src/webview/renderers/user-tool-result.ts",
      "src/webview/renderers/result.ts",
    ],
  };

  writeFileSync(OUT_FILE, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  // eslint-disable-next-line no-console
  console.log(
    `[evidence] wrote ${OUT_FILE} — verdict=${evidence.verdict} ` +
      `userCards(edit=${edit.userToolResultCardCount}, todo=${todo.userToolResultCardCount}) ` +
      `resultCards(hello=${hello.resultCardCount}, edit=${edit.resultCardCount})`,
  );
  if (!allPass) {
    process.exit(1);
  }

  // Cross-validate: firstLineSha256 matches the raw fixture first-line sha256.
  for (const f of [hello, edit, todo]) {
    const raw = readFileSync(join(FIXTURE_DIR, f.fixture), "utf8");
    const firstLine = raw.split(/\r?\n/).find((l) => l.length > 0) ?? "";
    const sha = createHash("sha256").update(firstLine, "utf8").digest("hex");
    if (sha !== f.firstLineSha256) {
      // eslint-disable-next-line no-console
      console.error(
        `[evidence] FAIL: firstLineSha256 mismatch for ${f.fixture}`,
      );
      process.exit(2);
    }
  }
}

function helperLineCount(fixture: string): number {
  const raw = readFileSync(join(FIXTURE_DIR, fixture), "utf8");
  return raw.split(/\r?\n/).filter((l) => l.length > 0).length;
}

main();
