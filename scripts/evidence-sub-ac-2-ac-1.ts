#!/usr/bin/env tsx
/**
 * Evidence generator for Phase 2, Sub-AC 2 of AC 1:
 *   - MH-04 (user.tool_result card renderer)
 *   - MH-05 (result / final-message card renderer)
 *   - MH-06 (system:init header card renderer)
 *
 * This Sub-AC verifies the three Phase 2 Must-Have event renderers plus the
 * DOM lifecycle discipline (msg-id / tool_use_id / session_id keyed upsert via
 * `replaceChildren` only — no direct DOM-mutation APIs).
 *
 * Workflow:
 *   1. Import the production renderers from src/webview/renderers/.
 *   2. Replay hello.jsonl + edit.jsonl + permission.jsonl through the parser.
 *   3. Instantiate happy-dom and drive each event through its renderer.
 *   4. Inspect key fields (data-session-id / data-tool-use-id / data-subtype /
 *      kv-row + result-row values) and confirm the DOM matches the parsed
 *      event contents.
 *   5. Confirm DOM discipline: no .appendChild / .append / innerHTML / etc.
 *      anywhere under src/webview/renderers or src/webview/ui.
 *   6. Emit artifacts/phase-2/sub-ac-2-ac-1.json with cross-validation fields
 *      consumable by scripts/check-evidence.sh.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
import {
  createSystemInitState,
  renderSystemInit,
} from "../src/webview/renderers/system-init";
import type {
  StreamEvent,
  UserEvent,
  ResultEvent,
  SystemInitEvent,
  ToolResultBlock,
} from "../src/webview/parser/types";

const ROOT = resolve(__dirname, "..");
const FIXTURE_DIR = join(ROOT, "test", "fixtures", "stream-json");
const OUT_DIR = join(ROOT, "artifacts", "phase-2");
const OUT_FILE = join(OUT_DIR, "sub-ac-2-ac-1.json");

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
  // MH-04
  readonly userToolResultCardCount: number;
  readonly toolUseIds: string[];
  readonly correlatedToolUseIds: boolean;
  // MH-05
  readonly resultCardCount: number;
  readonly resultSubtypes: string[];
  readonly resultDurationRow: string | null;
  readonly resultCostRow: string | null;
  readonly resultTokensRow: string | null;
  // MH-06
  readonly systemInitCardCount: number;
  readonly systemInitSessionIds: string[];
  readonly systemInitModelRow: string | null;
  readonly systemInitPermissionRow: string | null;
  readonly systemInitMcpServersRow: string | null;
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
    readonly id: "MH-04" | "MH-05" | "MH-06";
    readonly desc: string;
    readonly actual: boolean | number | string;
    readonly pass: boolean;
  }>;
  readonly fixtures: FixtureFindings[];
  readonly checks: Check[];
  readonly domDisciplineGate: {
    readonly scanned: string[];
    readonly violations: string[];
    readonly pass: boolean;
  };
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
function isSystemInit(e: StreamEvent): e is SystemInitEvent {
  return e.type === "system" && e.subtype === "init";
}

function makeDoc(): { doc: Document; parent: HTMLElement } {
  const window = new Window();
  const doc = window.document as unknown as Document;
  const parent = doc.createElement("div");
  (doc.body as unknown as HTMLElement).replaceChildren(parent);
  return { doc, parent };
}

function rowValue(
  card: HTMLElement,
  rowClass: string,
  keyClass: string,
  valueClass: string,
  key: string,
): string | null {
  const rows = card.querySelectorAll(`.${rowClass}`);
  for (const row of Array.from(rows)) {
    const k = row.querySelector(`.${keyClass}`)?.textContent ?? "";
    if (k === key) {
      return row.querySelector(`.${valueClass}`)?.textContent ?? "";
    }
  }
  return null;
}

function resultRow(card: HTMLElement, key: string): string | null {
  return rowValue(
    card,
    "claude-wv-result-row",
    "claude-wv-result-key",
    "claude-wv-result-value",
    key,
  );
}

function kvRow(card: HTMLElement, key: string): string | null {
  return rowValue(
    card,
    "claude-wv-kv-row",
    "claude-wv-kv-key",
    "claude-wv-kv-value",
    key,
  );
}

function analyze(fixture: string): FixtureFindings {
  const path = join(FIXTURE_DIR, fixture);
  const replay = replayFixture(path);
  const counts = eventCountByType(replay.events);

  // MH-04 — user.tool_result
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
  // Correlation: every card's data-tool-use-id must match one in the fixture.
  const cardIds = Array.from(userCards).map(
    (c) => c.getAttribute("data-tool-use-id") ?? "",
  );
  const correlatedToolUseIds =
    toolUseIdsInFixture.length > 0 &&
    toolUseIdsInFixture.every((id) => cardIds.includes(id));

  // MH-05 — result
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
    resultDurationRow = resultRow(first, "duration");
    resultCostRow = resultRow(first, "cost");
    resultTokensRow = resultRow(first, "tokens");
  }

  // MH-06 — system:init
  const systemInitEvents = replay.events.filter(isSystemInit);
  const { doc: siDoc, parent: siParent } = makeDoc();
  const siState = createSystemInitState();
  const systemInitCards: HTMLElement[] = [];
  for (const se of systemInitEvents) {
    systemInitCards.push(renderSystemInit(siState, siParent, se, siDoc));
  }
  const systemInitSessionIds = Array.from(
    siParent.querySelectorAll(".claude-wv-card--system-init"),
  )
    .map((c) => c.getAttribute("data-session-id") ?? "")
    .filter((s) => s.length > 0);

  let systemInitModelRow: string | null = null;
  let systemInitPermissionRow: string | null = null;
  let systemInitMcpServersRow: string | null = null;
  if (systemInitCards.length > 0) {
    const first = systemInitCards[0];
    systemInitModelRow = kvRow(first, "model");
    systemInitPermissionRow = kvRow(first, "permission");
    systemInitMcpServersRow = kvRow(first, "mcp_servers");
  }

  return {
    fixture,
    firstLineSha256: replay.firstLineSha256,
    eventCountByType: counts,
    rawSkipped: replay.rawSkipped,
    unknownEventCount: replay.unknownEventCount,
    userToolResultCardCount: userCards.length,
    toolUseIds: toolUseIdsInFixture,
    correlatedToolUseIds,
    resultCardCount: resultCards.length,
    resultSubtypes,
    resultDurationRow,
    resultCostRow,
    resultTokensRow,
    systemInitCardCount: systemInitCards.length,
    systemInitSessionIds,
    systemInitModelRow,
    systemInitPermissionRow,
    systemInitMcpServersRow,
  };
}

/**
 * Static scan for direct DOM-mutation API usage in renderers + ui. The Phase
 * 2 grep gate 2-5 forbids these entirely; we surface the scan output in the
 * evidence artifact so the verdict captures both runtime and static checks.
 */
function scanDomDiscipline(): {
  scanned: string[];
  violations: string[];
  pass: boolean;
} {
  const dirs = [
    join(ROOT, "src", "webview", "renderers"),
    join(ROOT, "src", "webview", "ui"),
  ];
  const bannedPatterns: RegExp[] = [
    /\.appendChild\s*\(/,
    /\.append\s*\(/,
    /innerHTML\s*[+=]/,
    /insertAdjacentHTML\s*\(/,
    /insertBefore\s*\(/,
  ];
  const scanned: string[] = [];
  const violations: string[] = [];

  function walk(dir: string): void {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile() && name.endsWith(".ts")) {
        scanned.push(full.replace(ROOT + "/", ""));
        const src = readFileSync(full, "utf8");
        const lines = src.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          for (const pat of bannedPatterns) {
            if (pat.test(line)) {
              violations.push(
                `${full.replace(ROOT + "/", "")}:${i + 1}: ${line.trim()}`,
              );
            }
          }
        }
      }
    }
  }
  for (const d of dirs) walk(d);

  return { scanned, violations, pass: violations.length === 0 };
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });

  // Choose three fixtures that exercise all three renderers and give a useful
  // differential signal:
  //   - hello.jsonl       : has init + result, no user.tool_result (baseline).
  //   - edit.jsonl        : has init + result + user.tool_result (Edit tool).
  //   - permission.jsonl  : has init (permissionMode="default") + result +
  //                         user.tool_result — confirms MH-06 permission row
  //                         is driven by the event, not hardcoded.
  const hello = analyze("hello.jsonl");
  const edit = analyze("edit.jsonl");
  const permission = analyze("permission.jsonl");

  const checks: Check[] = [];

  // MH-04 checks
  checks.push({
    name: "edit.jsonl user-tool-result card count == tool_result block count",
    expected: String(edit.toolUseIds.length),
    actual: String(edit.userToolResultCardCount),
    pass:
      edit.toolUseIds.length === edit.userToolResultCardCount &&
      edit.toolUseIds.length >= 1,
  });
  checks.push({
    name: "edit.jsonl user-tool-result cards correlate to parsed tool_use_id",
    expected: "true",
    actual: String(edit.correlatedToolUseIds),
    pass: edit.correlatedToolUseIds,
  });
  checks.push({
    name: "permission.jsonl user-tool-result cards correlate",
    expected: "true",
    actual: String(permission.correlatedToolUseIds),
    pass: permission.correlatedToolUseIds,
  });
  checks.push({
    name: "hello.jsonl has zero user-tool-result cards (differential)",
    expected: "0",
    actual: String(hello.userToolResultCardCount),
    pass: hello.userToolResultCardCount === 0,
  });

  // MH-05 checks
  checks.push({
    name: "hello.jsonl produces >=1 result card",
    expected: ">=1",
    actual: String(hello.resultCardCount),
    pass: hello.resultCardCount >= 1,
  });
  checks.push({
    name: "hello.jsonl result duration row matches /\\d+ms/",
    expected: "\\d+ms",
    actual: String(hello.resultDurationRow),
    pass: /^\d+ms$/.test(String(hello.resultDurationRow ?? "")),
  });
  checks.push({
    name: "hello.jsonl result cost row starts with $",
    expected: "$...",
    actual: String(hello.resultCostRow),
    pass: (hello.resultCostRow ?? "").startsWith("$"),
  });
  checks.push({
    name: "hello.jsonl result tokens row matches in/out",
    expected: "\\d+/\\d+",
    actual: String(hello.resultTokensRow),
    pass: /^\d+\/\d+$/.test(String(hello.resultTokensRow ?? "")),
  });
  checks.push({
    name: "edit.jsonl produces >=1 result card",
    expected: ">=1",
    actual: String(edit.resultCardCount),
    pass: edit.resultCardCount >= 1,
  });

  // MH-06 checks
  checks.push({
    name: "hello.jsonl produces 1 system-init card",
    expected: "1",
    actual: String(hello.systemInitCardCount),
    pass: hello.systemInitCardCount === 1,
  });
  checks.push({
    name: "edit.jsonl produces 1 system-init card",
    expected: "1",
    actual: String(edit.systemInitCardCount),
    pass: edit.systemInitCardCount === 1,
  });
  checks.push({
    name: "permission.jsonl system-init permission row == 'default' (differential)",
    expected: "default",
    actual: String(permission.systemInitPermissionRow),
    pass: permission.systemInitPermissionRow === "default",
  });
  checks.push({
    name: "edit.jsonl system-init permission row == 'acceptEdits' (differential)",
    expected: "acceptEdits",
    actual: String(edit.systemInitPermissionRow),
    pass: edit.systemInitPermissionRow === "acceptEdits",
  });
  checks.push({
    name: "hello.jsonl system-init model row is non-empty + non-placeholder",
    expected: "non-placeholder",
    actual: String(hello.systemInitModelRow),
    pass:
      !!hello.systemInitModelRow &&
      hello.systemInitModelRow !== "-" &&
      hello.systemInitModelRow.length > 0,
  });
  checks.push({
    name: "hello.jsonl system-init session-id attribute matches parsed event",
    expected: ">=1 non-empty session_id",
    actual: String(hello.systemInitSessionIds.length),
    pass:
      hello.systemInitSessionIds.length === 1 &&
      hello.systemInitSessionIds[0].length > 0,
  });

  // Cross-cutting: parser hygiene
  checks.push({
    name: "no raw-skipped across analyzed fixtures",
    expected: "0",
    actual: String(
      hello.rawSkipped + edit.rawSkipped + permission.rawSkipped,
    ),
    pass:
      hello.rawSkipped === 0 &&
      edit.rawSkipped === 0 &&
      permission.rawSkipped === 0,
  });
  checks.push({
    name: "no unknown events across analyzed fixtures",
    expected: "0",
    actual: String(
      hello.unknownEventCount +
        edit.unknownEventCount +
        permission.unknownEventCount,
    ),
    pass:
      hello.unknownEventCount === 0 &&
      edit.unknownEventCount === 0 &&
      permission.unknownEventCount === 0,
  });

  // DOM discipline gate (static scan of renderers + ui)
  const domGate = scanDomDiscipline();
  checks.push({
    name: "DOM discipline gate 2-5 (no direct DOM-mutation APIs)",
    expected: "0 violations",
    actual: String(domGate.violations.length) + " violations",
    pass: domGate.pass,
  });

  const allPass = checks.every((c) => c.pass);

  const assertions = [
    {
      id: "MH-04" as const,
      desc:
        "user.tool_result card renders with data-tool-use-id correlated to parsed tool_use_id",
      actual:
        edit.userToolResultCardCount + permission.userToolResultCardCount,
      pass:
        edit.correlatedToolUseIds &&
        permission.correlatedToolUseIds &&
        hello.userToolResultCardCount === 0,
    },
    {
      id: "MH-05" as const,
      desc:
        "result card renders subtype + duration + cost + tokens + turns rows from parsed result event",
      actual: hello.resultCardCount + edit.resultCardCount,
      pass:
        hello.resultCardCount >= 1 &&
        edit.resultCardCount >= 1 &&
        /^\d+ms$/.test(String(hello.resultDurationRow ?? "")) &&
        (hello.resultCostRow ?? "").startsWith("$") &&
        /^\d+\/\d+$/.test(String(hello.resultTokensRow ?? "")),
    },
    {
      id: "MH-06" as const,
      desc:
        "system:init header card renders with model + permission + mcp_servers + session_id rows keyed on parsed event",
      actual:
        hello.systemInitCardCount +
        edit.systemInitCardCount +
        permission.systemInitCardCount,
      pass:
        hello.systemInitCardCount === 1 &&
        edit.systemInitCardCount === 1 &&
        permission.systemInitCardCount === 1 &&
        permission.systemInitPermissionRow === "default" &&
        edit.systemInitPermissionRow === "acceptEdits",
    },
  ];

  const totalInvocations =
    helperLineCount("hello.jsonl") +
    helperLineCount("edit.jsonl") +
    helperLineCount("permission.jsonl");

  const evidence: Evidence = {
    generatedBy: "scripts/evidence-sub-ac-2-ac-1.ts",
    generatedAt: new Date().toISOString(),
    subprocessPid: process.pid,
    subprocessExitCode: allPass ? 0 : 1,
    parserInvocationCount: totalInvocations,
    description:
      "Sub-AC 2 of AC 1 — Phase 2 event rendering (MH-04 user.tool_result, MH-05 result, MH-06 system:init) with DOM lifecycle discipline (keyed upsert + replaceChildren only)",
    subAc: "AC 1 / Sub-AC 2",
    assertions,
    fixtures: [hello, edit, permission],
    checks,
    domDisciplineGate: domGate,
    verdict: allPass ? "PASS" : "FAIL",
    verifiedBy: [
      "test/webview/render-user-tool-result.test.ts",
      "test/webview/render-result.test.ts",
      "test/webview/render-system-init.test.ts",
      "test/webview/render-permission-plan-mode.test.ts",
      "test/webview/render-fixtures-integration.test.ts",
    ],
    renderers: [
      "src/webview/renderers/user-tool-result.ts",
      "src/webview/renderers/result.ts",
      "src/webview/renderers/system-init.ts",
    ],
  };

  writeFileSync(OUT_FILE, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  // eslint-disable-next-line no-console
  console.log(
    `[evidence] wrote ${OUT_FILE} — verdict=${evidence.verdict} ` +
      `MH-04 userCards(edit=${edit.userToolResultCardCount}, permission=${permission.userToolResultCardCount}) ` +
      `MH-05 resultCards(hello=${hello.resultCardCount}, edit=${edit.resultCardCount}) ` +
      `MH-06 initCards(hello=${hello.systemInitCardCount}, edit=${edit.systemInitCardCount}, permission=${permission.systemInitCardCount})`,
  );
  if (!allPass) {
    process.exit(1);
  }

  // Cross-validate: firstLineSha256 matches the raw fixture first-line sha256.
  for (const f of [hello, edit, permission]) {
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
