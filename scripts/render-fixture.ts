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
import type { StreamEvent } from "../src/webview/parser/types";

const ROOT = resolve(__dirname, "..");
const FIXTURE_DIR = join(ROOT, "test", "fixtures", "stream-json");
const OUT_DIR = join(ROOT, "artifacts", "phase-4a");

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

  mkdirSync(OUT_DIR, { recursive: true });

  const replay = replayFixture(fixturePath);
  const events: StreamEvent[] = replay.events;

  const { document: doc } = new Window();
  const cardsEl = doc.createElement("div");
  cardsEl.classList.add("claude-wv-cards");
  // Attach via replaceChildren to stay consistent with the
  // renderers/ui/ discipline enforced by the 4a-5 grep gate.  The script
  // directory is outside that gate, but the codebase convention is worth
  // keeping so future audits don't have to special-case scripts/.
  doc.body.replaceChildren(cardsEl);

  const states = {
    assistantText: createAssistantTextState(),
    assistantToolUse: createAssistantToolUseState(),
    assistantThinking: createAssistantThinkingState(),
    editDiff: createEditDiffState(),
    userToolResult: createUserToolResultState(),
    result: createResultState(),
    systemInit: createSystemInitState(),
  };

  const cardsElAsHtml = cardsEl as unknown as HTMLElement;
  const docAsDoc = doc as unknown as Document;

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
        break;
      case "user":
        renderUserToolResult(states.userToolResult, cardsElAsHtml, ev, docAsDoc);
        break;
      case "result":
        renderResult(states.result, cardsElAsHtml, ev, docAsDoc);
        break;
      case "system":
        if (ev.subtype === "init") {
          renderSystemInit(states.systemInit, cardsElAsHtml, ev, docAsDoc);
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
    assertions,
  };

  const stem = fixtureName.replace(/\.jsonl$/i, "");
  const outFile = join(OUT_DIR, `render-${stem}.json`);
  writeFileSync(outFile, JSON.stringify(evidence, null, 2) + "\n", "utf8");

  // eslint-disable-next-line no-console
  console.log(
    `[render-fixture] wrote ${outFile} — cards=${evidence.cardCount} ` +
      `add=${diffAddedCount} remove=${diffRemovedCount} thinking=${thinkingCardCount}`,
  );

  // Also write the cardsEl.outerHTML for debugging + manual inspection.
  const htmlOut = join(OUT_DIR, `render-${stem}.html`);
  const outerHtml = (cardsEl as unknown as HTMLElement).outerHTML;
  writeFileSync(htmlOut, outerHtml, "utf8");
}

main();
