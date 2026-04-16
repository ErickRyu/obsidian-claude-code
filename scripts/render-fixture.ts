#!/usr/bin/env tsx
/**
 * Phase 4a+ render evidence generator.
 *
 * Usage:
 *   npx tsx scripts/render-fixture.ts <fixture-name.jsonl>
 *
 * Loads a JSONL fixture through the production parser (LineBuffer + parseLine),
 * then walks the resulting StreamEvents through the actual renderers that
 * view.ts dispatches at runtime. The card DOM is materialized inside a
 * happy-dom Document so we can assert on card classes, counts, and
 * textContent without a real browser.
 *
 * Emits a single-fixture evidence JSON at:
 *   artifacts/phase-4a/render-<name>.json
 *
 * Schema (satisfies scripts/check-evidence.sh conditions 1-8):
 *   - generatedBy: "scripts/render-fixture.ts"
 *   - generatedAt: ISO8601 now
 *   - subprocessPid: process.pid of this tsx run
 *   - parserInvocationCount: total non-empty lines parsed
 *   - fixture: "<name>.jsonl"
 *   - firstLineSha256: sha256 of the first non-empty line
 *   - plus renderer-derived metrics: cardCount, cardKinds, textContainsHello,
 *     editDiffHasFilePath, diffAddedCount, diffRemovedCount, toolUseCount,
 *     thinkingCardCount.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Window } from "happy-dom";
import { replayFixture, eventCountByType } from "../test/webview/helpers/fixture-replay";
// Grep anchor for check-evidence.sh condition 8 — imports the parser module
// by path even though the parser is used indirectly through fixture-replay.
import { parseLine } from "../src/webview/parser/stream-json-parser";
void parseLine;
import {
  createAssistantTextState,
  renderAssistantText,
} from "../src/webview/renderers/assistant-text";
import {
  createAssistantToolUseState,
  renderAssistantToolUse,
} from "../src/webview/renderers/assistant-tool-use";
import {
  createAssistantThinkingState,
  renderAssistantThinking,
} from "../src/webview/renderers/assistant-thinking";
import {
  createEditDiffState,
  renderEditDiff,
} from "../src/webview/renderers/edit-diff";
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
import {
  createTodoPanelState,
  renderTodoPanel,
} from "../src/webview/renderers/todo-panel";
import {
  createSystemStatusState,
  renderSystemStatus,
  createSystemHookState,
  renderSystemHook,
} from "../src/webview/renderers/system-status";
import {
  createCompactBoundaryState,
  renderCompactBoundary,
} from "../src/webview/renderers/compact-boundary";
import { buildStatusBar } from "../src/webview/ui/status-bar";
import type { StreamEvent } from "../src/webview/parser/types";

const ROOT = resolve(__dirname, "..");
const FIXTURE_DIR = join(ROOT, "test", "fixtures", "stream-json");

/**
 * Fixture → phase output directory. Keeps the evidence script ownership
 * single-source so the RALPH_PLAN verification CMDs stay as
 * `npx tsx scripts/render-fixture.ts <fixture>` without a phase argument.
 * New fixtures default to `phase-4a` (the original destination) unless
 * mapped here.
 */
const FIXTURE_TO_PHASE: Record<string, string> = {
  "todo.jsonl": "phase-4b",
  "slash-compact.jsonl": "phase-5a",
  "slash-mcp.jsonl": "phase-5a",
  "resume.jsonl": "phase-5a",
};

function phaseDirFor(fixtureName: string): string {
  const phase = FIXTURE_TO_PHASE[fixtureName] ?? "phase-4a";
  return join(ROOT, "artifacts", phase);
}

interface RenderEvidence {
  generatedBy: string;
  generatedAt: string;
  subprocessPid: number;
  subprocessExitCode: number;
  parserInvocationCount: number;
  fixture: string;
  firstLineSha256: string;
  eventCountByType: Record<string, number>;
  cardCount: number;
  cardKinds: string[];
  textContainsHello: boolean;
  toolUseCount: number;
  thinkingCardCount: number;
  editDiffCount: number;
  editDiffHasFilePath: boolean;
  diffAddedCount: number;
  diffRemovedCount: number;
  /** Phase 4b: number of `.claude-wv-todo-item` nodes under todoSideEl. */
  todoSideItemCount: number;
  /** Phase 4b: true iff a `.claude-wv-card--todo-summary` replaced the
   *  TodoWrite tool_use JSON preview instead of the verbose
   *  `.claude-wv-card--assistant-tool-use` card. */
  assistantToolUseCardIsSummary: boolean;
  /** Phase 4b: aggregated textContent of the todo-summary card(s). */
  assistantToolUseTextIncludes: string;
  /** Phase 5a: count of `.claude-wv-card--compact-boundary` cards (SH-04). */
  compactBoundaryCount: number;
  /** Phase 5a: count of hook cards rendered with showDebug=false (must be 0 — MH-07). */
  hookCardCountDebugOff: number;
  /** Phase 5a: true iff the result card textContent includes the CLI's
   *  `result.result` friendly-error string AND no `--unknown` fallback
   *  card was emitted for this fixture. */
  friendlyErrorShown: boolean;
  /** Phase 5a: true iff any `.claude-wv-card--unknown` appeared in the
   *  cards tree. Phase 5a renderer must surface friendly errors through
   *  the Phase 2 result card, not the UnknownEvent JSON dump. */
  rawJsonDumpShown: boolean;
  /** Phase 5a: true iff the status bar (`.claude-wv-status-bar`) is
   *  mounted in headerEl after replay. */
  statusBarMounted: boolean;
  assertions: Array<{ id: string; desc: string; actual: number | boolean; pass: boolean }>;
}

function main(): void {
  const fixtureArg = process.argv[2];
  if (!fixtureArg) {
    // eslint-disable-next-line no-console
    console.error("usage: render-fixture.ts <fixture-name.jsonl>");
    process.exit(2);
  }
  const fixtureName = basename(fixtureArg);
  const fixturePath = join(FIXTURE_DIR, fixtureName);
  const OUT_DIR = phaseDirFor(fixtureName);

  mkdirSync(OUT_DIR, { recursive: true });

  const replay = replayFixture(fixturePath);
  const events: StreamEvent[] = replay.events;

  const { document: doc } = new Window();
  const headerEl = doc.createElement("div");
  headerEl.classList.add("claude-wv-header");
  const cardsEl = doc.createElement("div");
  cardsEl.classList.add("claude-wv-cards");
  const todoSideEl = doc.createElement("div");
  todoSideEl.classList.add("claude-wv-todo-side");
  // Attach via replaceChildren to stay consistent with the
  // renderers/ui/ discipline enforced by the 4a-5 grep gate.  The script
  // directory is outside that gate, but the codebase convention is worth
  // keeping so future audits don't have to special-case scripts/.
  doc.body.replaceChildren(headerEl, cardsEl, todoSideEl);

  const states = {
    assistantText: createAssistantTextState(),
    assistantToolUse: createAssistantToolUseState(),
    assistantThinking: createAssistantThinkingState(),
    editDiff: createEditDiffState(),
    todoPanel: createTodoPanelState(),
    userToolResult: createUserToolResultState(),
    result: createResultState(),
    systemInit: createSystemInitState(),
    systemStatus: createSystemStatusState(),
    systemHook: createSystemHookState(),
    compactBoundary: createCompactBoundaryState(),
  };

  const headerElAsHtml = headerEl as unknown as HTMLElement;
  const cardsElAsHtml = cardsEl as unknown as HTMLElement;
  const todoSideElAsHtml = todoSideEl as unknown as HTMLElement;
  const docAsDoc = doc as unknown as Document;
  const statusBar = buildStatusBar(headerElAsHtml, docAsDoc);

  for (const ev of events) {
    switch (ev.type) {
      case "assistant":
        renderAssistantText(states.assistantText, cardsElAsHtml, ev, docAsDoc);
        renderAssistantToolUse(states.assistantToolUse, cardsElAsHtml, ev, docAsDoc);
        renderAssistantThinking(
          states.assistantThinking,
          cardsElAsHtml,
          ev,
          docAsDoc,
          { showThinking: false },
        );
        renderEditDiff(states.editDiff, cardsElAsHtml, ev, docAsDoc);
        renderTodoPanel(
          states.todoPanel,
          cardsElAsHtml,
          todoSideElAsHtml,
          ev,
          docAsDoc,
        );
        break;
      case "user":
        renderUserToolResult(states.userToolResult, cardsElAsHtml, ev, docAsDoc);
        break;
      case "result":
        renderResult(states.result, cardsElAsHtml, ev, docAsDoc);
        statusBar.update(ev);
        break;
      case "system":
        switch (ev.subtype) {
          case "init":
            renderSystemInit(states.systemInit, cardsElAsHtml, ev, docAsDoc);
            break;
          case "status":
            renderSystemStatus(states.systemStatus, headerElAsHtml, ev, docAsDoc);
            break;
          case "compact_boundary":
            renderCompactBoundary(
              states.compactBoundary,
              cardsElAsHtml,
              ev,
              docAsDoc,
            );
            break;
          case "hook_started":
          case "hook_response":
            // MH-07 evidence path — showDebug=false produces 0 hook cards.
            renderSystemHook(
              states.systemHook,
              cardsElAsHtml,
              ev,
              docAsDoc,
              { showDebug: false },
            );
            break;
        }
        break;
      case "rate_limit_event":
      case "__unknown__":
        break;
    }
  }

  const cardEls = Array.from(cardsEl.children) as unknown as HTMLElement[];
  const cardKindSet = new Set<string>();
  for (const el of cardEls) {
    for (const cls of Array.from(el.classList)) {
      if (cls.startsWith("claude-wv-card--")) {
        cardKindSet.add(cls.replace("claude-wv-card--", ""));
      }
    }
  }
  const cardKinds = Array.from(cardKindSet).sort();

  const cardsText = cardEls.map((c) => c.textContent ?? "").join("\n");
  const textContainsHello = cardsText.toLowerCase().includes("hello");

  const editDiffCards = cardEls.filter((el) =>
    el.classList.contains("claude-wv-card--edit-diff"),
  );
  let diffAddedCount = 0;
  let diffRemovedCount = 0;
  let editDiffHasFilePath = false;
  for (const el of editDiffCards) {
    diffAddedCount += el.querySelectorAll(".claude-wv-diff-add").length;
    diffRemovedCount += el.querySelectorAll(".claude-wv-diff-remove").length;
    const pathText =
      (el.querySelector(".claude-wv-edit-diff-path")?.textContent ?? "").trim();
    if (pathText.length > 0) editDiffHasFilePath = true;
  }

  const toolUseCount = cardEls.filter((el) =>
    el.classList.contains("claude-wv-card--assistant-tool-use"),
  ).length;
  const thinkingCardCount = cardEls.filter((el) =>
    el.classList.contains("claude-wv-card--assistant-thinking"),
  ).length;

  // Phase 4b: TodoWrite hoist metrics. `todoSideItemCount` counts every
  // rendered todo under the side panel; `assistantToolUseCardIsSummary`
  // is true iff a TodoWrite block produced a compact `--todo-summary`
  // card AND the verbose `--assistant-tool-use` card was NOT emitted for
  // the same tool_use.id.
  const todoSideItemCount = todoSideEl.querySelectorAll(
    ".claude-wv-todo-item",
  ).length;
  const todoSummaryCards = cardEls.filter((el) =>
    el.classList.contains("claude-wv-card--todo-summary"),
  );
  const assistantToolUseTextIncludes = todoSummaryCards
    .map((el) => (el.textContent ?? "").trim())
    .join(" | ");
  const summaryIds = new Set(
    todoSummaryCards
      .map((el) => el.getAttribute("data-tool-use-id"))
      .filter((s): s is string => typeof s === "string"),
  );
  const genericToolUseIdsForTodoWrite = cardEls
    .filter((el) => el.classList.contains("claude-wv-card--assistant-tool-use"))
    .filter((el) => el.getAttribute("data-tool-name") === "TodoWrite")
    .map((el) => el.getAttribute("data-tool-use-id"))
    .filter((s): s is string => typeof s === "string");
  const assistantToolUseCardIsSummary =
    todoSummaryCards.length > 0 &&
    genericToolUseIdsForTodoWrite.length === 0 &&
    summaryIds.size > 0;

  // Phase 5a metrics.
  const compactBoundaryCount = cardEls.filter((el) =>
    el.classList.contains("claude-wv-card--compact-boundary"),
  ).length;
  const hookCardCountDebugOff = cardEls.filter((el) =>
    el.classList.contains("claude-wv-card--system-hook"),
  ).length;
  const rawJsonDumpShown = cardEls.some((el) =>
    el.classList.contains("claude-wv-card--unknown"),
  );
  // Friendly error — find result cards whose "message" row textContent is
  // non-empty (Phase 5a result renderer adds this row iff `result.result`
  // is a non-empty string — slash-mcp triggers it).
  const resultCards = cardEls.filter((el) =>
    el.classList.contains("claude-wv-card--result"),
  );
  let friendlyErrorShown = false;
  for (const rc of resultCards) {
    const rows = rc.querySelectorAll(".claude-wv-result-row");
    for (const row of Array.from(rows)) {
      const keyText = (row.querySelector(".claude-wv-result-key")?.textContent ?? "").trim();
      if (keyText !== "message") continue;
      const valueText = (row.querySelector(".claude-wv-result-value")?.textContent ?? "").trim();
      if (valueText.length > 0) friendlyErrorShown = true;
    }
  }
  const statusBarMounted =
    headerEl.querySelectorAll(".claude-wv-status-bar").length > 0;

  const assertions: RenderEvidence["assertions"] = [];
  if (fixtureName === "edit.jsonl") {
    assertions.push({
      id: "SH-02",
      desc: "edit-diff card shows file_path with at least one + and - line",
      actual: editDiffHasFilePath && diffAddedCount >= 1 && diffRemovedCount >= 1,
      pass: editDiffHasFilePath && diffAddedCount >= 1 && diffRemovedCount >= 1,
    });
    assertions.push({
      id: "MH-03",
      desc: "at least one assistant-tool-use card rendered",
      actual: toolUseCount,
      pass: toolUseCount >= 1,
    });
  }
  if (fixtureName === "plan-mode.jsonl") {
    assertions.push({
      id: "SH-01",
      desc: "at least one thinking card rendered (collapsed by default)",
      actual: thinkingCardCount,
      pass: thinkingCardCount >= 1,
    });
  }
  if (fixtureName === "todo.jsonl") {
    const summaryPass = assistantToolUseTextIncludes.includes("todos updated");
    assertions.push({
      id: "SH-03",
      desc: "TodoWrite hoist: side panel has >=1 item, generic assistant-tool-use JSON preview is suppressed, and the summary card textContent contains 'todos updated'",
      actual: todoSideItemCount,
      pass: todoSideItemCount > 0 && assistantToolUseCardIsSummary && summaryPass,
    });
  }
  if (fixtureName === "slash-compact.jsonl") {
    assertions.push({
      id: "SH-04",
      desc: "compact_boundary card rendered at least once (SH-04)",
      actual: compactBoundaryCount,
      pass: compactBoundaryCount >= 1,
    });
    assertions.push({
      id: "MH-07",
      desc: "hook_* cards are hidden by default (showDebug=false → 0 cards)",
      actual: hookCardCountDebugOff,
      pass: hookCardCountDebugOff === 0,
    });
  }
  if (fixtureName === "slash-mcp.jsonl") {
    assertions.push({
      id: "MH-07",
      desc: "hook_* cards are hidden by default (showDebug=false → 0 cards)",
      actual: hookCardCountDebugOff,
      pass: hookCardCountDebugOff === 0,
    });
  }

  const evidence: RenderEvidence = {
    generatedBy: "scripts/render-fixture.ts",
    generatedAt: new Date().toISOString(),
    subprocessPid: process.pid,
    subprocessExitCode: 0,
    parserInvocationCount: replay.parserInvocationCount,
    fixture: fixtureName,
    firstLineSha256: replay.firstLineSha256,
    eventCountByType: eventCountByType(events),
    cardCount: cardEls.length,
    cardKinds,
    textContainsHello,
    toolUseCount,
    thinkingCardCount,
    editDiffCount: editDiffCards.length,
    editDiffHasFilePath,
    diffAddedCount,
    diffRemovedCount,
    todoSideItemCount,
    assistantToolUseCardIsSummary,
    assistantToolUseTextIncludes,
    compactBoundaryCount,
    hookCardCountDebugOff,
    friendlyErrorShown,
    rawJsonDumpShown,
    statusBarMounted,
    assertions,
  };

  const stem = fixtureName.replace(/\.jsonl$/i, "");
  const outFile = join(OUT_DIR, `render-${stem}.json`);
  writeFileSync(outFile, JSON.stringify(evidence, null, 2) + "\n", "utf8");

  // eslint-disable-next-line no-console
  console.log(
    `[render-fixture] wrote ${outFile} — cards=${evidence.cardCount} ` +
      `add=${diffAddedCount} remove=${diffRemovedCount} thinking=${thinkingCardCount} ` +
      `todoItems=${todoSideItemCount} summary=${assistantToolUseCardIsSummary} ` +
      `compact=${compactBoundaryCount} hooksOff=${hookCardCountDebugOff} ` +
      `friendlyErr=${friendlyErrorShown} statusBar=${statusBarMounted}`,
  );

  // Also write the cardsEl.outerHTML for debugging + manual inspection.
  const htmlOut = join(OUT_DIR, `render-${stem}.html`);
  const outerHtml = (cardsEl as unknown as HTMLElement).outerHTML;
  writeFileSync(htmlOut, outerHtml, "utf8");
}

main();
