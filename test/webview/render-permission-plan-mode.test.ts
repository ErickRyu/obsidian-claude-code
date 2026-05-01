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
  createAssistantToolUseState,
  renderAssistantToolUse,
} from "../../src/webview/renderers/assistant-tool-use";
import {
  createUserToolResultState,
  renderUserToolResult,
} from "../../src/webview/renderers/user-tool-result";
import { createActivityGroupState } from "../../src/webview/renderers/activity-group";
import {
  createResultState,
  renderResult,
} from "../../src/webview/renderers/result";
import {
  createEditDiffState,
  renderEditDiff,
} from "../../src/webview/renderers/edit-diff";
import type {
  AssistantEvent,
  ResultEvent,
  StreamEvent,
  SystemInitEvent,
  UserEvent,
} from "../../src/webview/parser/types";

/**
 * AC 3 Sub-AC 3 — verify `permission.jsonl` and `plan-mode.jsonl` fixtures
 * render interactive / mode-specific events (system init with permissionMode,
 * tool_use, user tool_result, result) with `rawSkipped === 0`.
 *
 * These two fixtures exercise code paths the other AC 3 fixtures do not:
 * - `permission.jsonl` — a session run with the default permission mode that
 *   uses a permission-requiring `Write` tool_use.
 * - `plan-mode.jsonl` — a session run with `permissionMode === "plan"` that
 *   includes a `thinking` block plus interactive `ToolSearch` +
 *   `AskUserQuestion` tool calls, one of whose tool_result is an error.
 *
 * Assertion style is key-field only (no HTML snapshots) per the coding
 * constraints. Cards are routed through the production renderers exactly as
 * Phase 2 layout.ts would dispatch them.
 */

const FIXTURE_DIR = path.resolve(
  __dirname,
  "..",
  "fixtures",
  "stream-json",
);

interface RenderedScene {
  parent: HTMLElement;
  systemInitCards: Map<string, HTMLElement>;
  toolUseCards: Map<string, HTMLElement>;
  editDiffCards: Map<string, HTMLElement>;
  toolResultCards: Map<string, HTMLElement>;
  resultCards: Map<string, HTMLElement>;
}

function renderFixture(fixtureFile: string): {
  events: StreamEvent[];
  rawSkipped: number;
  unknownEventCount: number;
  scene: RenderedScene;
} {
  const { events, rawSkipped, unknownEventCount } = replayFixture(
    path.join(FIXTURE_DIR, fixtureFile),
  );

  const window = new Window();
  const doc = window.document as unknown as Document;
  const parent = doc.createElement("div");
  parent.classList.add("claude-wv-cards");
  (doc.body as unknown as HTMLElement).appendChild(
    parent as unknown as HTMLElement,
  );

  const systemInitState = createSystemInitState();
  const toolUseState = createAssistantToolUseState();
  const editDiffState = createEditDiffState();
  const toolResultState = createUserToolResultState();
  const resultState = createResultState();
  const groupState = createActivityGroupState();

  for (const ev of events) {
    if (ev.type === "system" && ev.subtype === "init") {
      renderSystemInit(systemInitState, parent, ev as SystemInitEvent, doc);
    } else if (ev.type === "assistant") {
      renderAssistantToolUse(toolUseState, groupState, parent, ev as AssistantEvent, doc);
      renderEditDiff(editDiffState, parent, ev as AssistantEvent, doc);
    } else if (ev.type === "user") {
      renderUserToolResult(toolResultState, groupState, parent, ev as UserEvent, doc);
    } else if (ev.type === "result") {
      renderResult(resultState, parent, ev as ResultEvent, doc);
    }
    // Other system subtypes (hook_started, hook_response) and rate_limit_event
    // are routed to the default UnknownEvent handler in the real registry; we
    // intentionally skip them here since they're not the subject of this
    // Sub-AC — the parser-level assertions below cover their presence.
  }

  return {
    events,
    rawSkipped,
    unknownEventCount,
    scene: {
      parent,
      systemInitCards: systemInitState.cards,
      toolUseCards: toolUseState.cards,
      editDiffCards: editDiffState.cards,
      toolResultCards: toolResultState.cards,
      resultCards: resultState.cards,
    },
  };
}

function kvValue(card: HTMLElement, key: string): string | null {
  const rows = card.querySelectorAll(".claude-wv-kv-row");
  for (const row of Array.from(rows)) {
    const k = row.querySelector(".claude-wv-kv-key")?.textContent ?? "";
    if (k === key) {
      return row.querySelector(".claude-wv-kv-value")?.textContent ?? "";
    }
  }
  return null;
}

describe("permission.jsonl rendering (AC 3 Sub-AC 3)", () => {
  const FIXTURE = "permission.jsonl";

  it("parses with rawSkipped === 0 and unknownEventCount === 0", () => {
    const { rawSkipped, unknownEventCount, events } = renderFixture(FIXTURE);
    expect(rawSkipped).toBe(0);
    expect(unknownEventCount).toBe(0);
    expect(events.length).toBeGreaterThan(0);
  });

  it("contains the expected event-type histogram (system/assistant/user/result/rate_limit)", () => {
    const { events } = renderFixture(FIXTURE);
    const counts = eventCountByType(events);
    // system includes 1 init + 3 hook_started + 3 hook_response
    expect(counts.system).toBe(7);
    expect(counts.assistant).toBe(3);
    expect(counts.user).toBe(1);
    expect(counts.result).toBe(1);
    expect(counts.rate_limit_event).toBe(1);
  });

  it("renders a system-init card whose permission row shows 'default'", () => {
    const { scene } = renderFixture(FIXTURE);
    expect(scene.systemInitCards.size).toBe(1);
    const card = Array.from(scene.systemInitCards.values())[0];
    expect(card.classList.contains("claude-wv-card--system-init")).toBe(true);
    expect(kvValue(card, "permission")).toBe("default");
    // Session id from fixture — differential with plan-mode below.
    expect(card.getAttribute("data-session-id")).toBe(
      "7021ed06-96b0-4b1c-9254-ccb148da69bb",
    );
  });

  it("renders an edit-diff card for the Write tool with the fixture's id", () => {
    // 2026-04-29 dogfood: Write/Edit are now exclusively rendered by
    // edit-diff (assistant-tool-use skips them). The card carries the
    // same `data-tool-use-id` and `data-tool-name` so existing
    // correlation invariants remain intact.
    const { scene } = renderFixture(FIXTURE);
    const writeId = "toolu_01T3eLXYZkr9BYHGUQFeKQPw";
    expect(scene.toolUseCards.has(writeId)).toBe(false);
    expect(scene.editDiffCards.has(writeId)).toBe(true);
    const card = scene.editDiffCards.get(writeId);
    expect(card).toBeDefined();
    if (!card) return;
    expect(card.getAttribute("data-tool-name")).toBe("Write");
    expect(card.classList.contains("claude-wv-card--edit-diff")).toBe(true);
    const path = card.querySelector(".claude-wv-edit-diff-path");
    expect((path?.textContent ?? "").length).toBeGreaterThan(0);
  });

  it("renders a user-tool-result card correlated to the Write tool_use_id", () => {
    const { scene } = renderFixture(FIXTURE);
    const writeId = "toolu_01T3eLXYZkr9BYHGUQFeKQPw";
    expect(scene.toolResultCards.has(writeId)).toBe(true);
    const card = scene.toolResultCards.get(writeId);
    expect(card).toBeDefined();
    if (!card) return;
    expect(card.getAttribute("data-tool-use-id")).toBe(writeId);
    expect(card.hasAttribute("data-is-error")).toBe(false);
  });

  it("renders a result card with subtype='success'", () => {
    const { scene } = renderFixture(FIXTURE);
    expect(scene.resultCards.size).toBe(1);
    const card = Array.from(scene.resultCards.values())[0];
    expect(card.classList.contains("claude-wv-card--result")).toBe(true);
    expect(card.getAttribute("data-subtype")).toBe("success");
    expect(card.hasAttribute("data-is-error")).toBe(false);
  });
});

describe("plan-mode.jsonl rendering (AC 3 Sub-AC 3)", () => {
  const FIXTURE = "plan-mode.jsonl";

  it("parses with rawSkipped === 0 and unknownEventCount === 0", () => {
    const { rawSkipped, unknownEventCount, events } = renderFixture(FIXTURE);
    expect(rawSkipped).toBe(0);
    expect(unknownEventCount).toBe(0);
    expect(events.length).toBeGreaterThan(0);
  });

  it("contains the expected event-type histogram — differential vs permission.jsonl (4 assistant, 2 user)", () => {
    const { events } = renderFixture(FIXTURE);
    const counts = eventCountByType(events);
    expect(counts.system).toBe(7);
    // differential: plan-mode has thinking + 2 tool_use turns (4 assistant
    // events) vs permission's 3.
    expect(counts.assistant).toBe(4);
    // differential: plan-mode has 2 user tool_result turns vs permission's 1.
    expect(counts.user).toBe(2);
    expect(counts.result).toBe(1);
    expect(counts.rate_limit_event).toBe(1);
  });

  it("renders a system-init card whose permission row shows 'plan'", () => {
    const { scene } = renderFixture(FIXTURE);
    expect(scene.systemInitCards.size).toBe(1);
    const card = Array.from(scene.systemInitCards.values())[0];
    expect(kvValue(card, "permission")).toBe("plan");
    expect(card.getAttribute("data-session-id")).toBe(
      "d479141a-a179-4f6b-96a8-f7e4ff849fcf",
    );
  });

  it("renders both ToolSearch and AskUserQuestion tool_use cards", () => {
    const { scene } = renderFixture(FIXTURE);
    const toolSearchId = "toolu_0135LphYuBXgwLbWAHiwjeVT";
    const askUserQuestionId = "toolu_01Nq9d8dWoF8BMKyDLSux1Es";
    expect(scene.toolUseCards.has(toolSearchId)).toBe(true);
    expect(scene.toolUseCards.has(askUserQuestionId)).toBe(true);
    const toolSearchCard = scene.toolUseCards.get(toolSearchId);
    const askUserQuestionCard = scene.toolUseCards.get(askUserQuestionId);
    expect(toolSearchCard?.getAttribute("data-tool-name")).toBe("ToolSearch");
    expect(askUserQuestionCard?.getAttribute("data-tool-name")).toBe(
      "AskUserQuestion",
    );
  });

  it("marks the AskUserQuestion tool-line with data-is-error='true' on its tool_result", () => {
    // 2026-05-01 dogfood: tool_result no longer renders a separate card —
    // it stamps `data-is-error` onto the matching tool-line instead. The
    // tool-line element is the one created by assistant-tool-use, so look
    // it up in `toolUseCards`.
    const { scene } = renderFixture(FIXTURE);
    const askUserQuestionId = "toolu_01Nq9d8dWoF8BMKyDLSux1Es";
    const toolSearchId = "toolu_0135LphYuBXgwLbWAHiwjeVT";
    const askErrorLine = scene.toolUseCards.get(askUserQuestionId);
    expect(askErrorLine).toBeDefined();
    if (!askErrorLine) return;
    // Differential: plan-mode's AskUserQuestion result has is_error=true
    // in the fixture, but the ToolSearch result does not.
    expect(askErrorLine.getAttribute("data-is-error")).toBe("true");
    const toolSearchLine = scene.toolUseCards.get(toolSearchId);
    expect(toolSearchLine).toBeDefined();
    expect(toolSearchLine?.hasAttribute("data-is-error")).toBe(false);
  });

  it("thinking block is present in the parsed assistant events (plan-mode signal)", () => {
    const { events } = renderFixture(FIXTURE);
    let thinkingBlocks = 0;
    for (const ev of events) {
      if (ev.type !== "assistant") continue;
      for (const block of ev.message.content) {
        if (block.type === "thinking") thinkingBlocks++;
      }
    }
    // Differential: permission.jsonl has 0 thinking blocks; plan-mode has >= 1.
    expect(thinkingBlocks).toBeGreaterThanOrEqual(1);
  });

  it("renders a result card with subtype='success' (distinct session from permission.jsonl)", () => {
    const { scene } = renderFixture(FIXTURE);
    expect(scene.resultCards.size).toBe(1);
    const card = Array.from(scene.resultCards.values())[0];
    expect(card.getAttribute("data-subtype")).toBe("success");
    expect(card.getAttribute("data-session-id")).toBe(
      "d479141a-a179-4f6b-96a8-f7e4ff849fcf",
    );
  });
});
