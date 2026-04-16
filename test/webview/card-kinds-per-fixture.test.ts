/**
 * AC 5 — Per-fixture cardKinds Set membership + cardCountByKind expectations.
 *
 * For each of the 8 `claude -p --output-format=stream-json` fixtures, replay
 * events through the Phase 2 production renderers (system-init, assistant-
 * text, assistant-tool-use, user-tool-result, result) and assert that the set
 * of card kinds emitted to the DOM and the count per kind match locked
 * expectations. This protects AC 5 against two regression classes:
 *
 *   1. Card-kind vocabulary drift — e.g. renaming `assistant-text` to
 *      `assistant-message` would silently break downstream CSS / tests; this
 *      suite fails loudly on the Set membership check.
 *   2. Upsert-discipline drift — re-emitted assistant events with the same
 *      `message.id` (partial → final in stream-json) or re-emitted
 *      `tool_use.id` / `tool_use_id` must collapse to the same card. The
 *      `cardCountByKind` expectations are pinned to the *deduplicated*
 *      keyed-upsert count, not to raw event counts.
 *
 * The expected values below are derived from the fixtures' actual content
 * (see scripts/evidence-sub-ac-6-ac-5.ts for the machine-verified evidence
 * artifact). They are **NOT** hardcoded against event-count histograms — in
 * particular:
 *
 *   - `edit.jsonl` has 4 assistant events but only 2 distinct `message.id`s
 *     that carry text blocks + 2 distinct `tool_use.id`s. cardCountByKind
 *     therefore reports `assistant-text: 2` and `assistant-tool-use: 2`, not
 *     4 / 4.
 *   - `resume.jsonl` is the "resume-failure" fixture — zero assistant / user
 *     turns, one result card, no init card.
 *   - `slash-compact.jsonl` has 2 user events but 0 tool_result blocks (they
 *     are the replay-synthetic user turns emitted by /compact); no
 *     user-tool-result cards render.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { Window } from "happy-dom";
import { replayFixture } from "./helpers/fixture-replay";
import {
  createSystemInitState,
  renderSystemInit,
} from "../../src/webview/renderers/system-init";
import {
  createAssistantTextState,
  renderAssistantText,
} from "../../src/webview/renderers/assistant-text";
import {
  createAssistantToolUseState,
  renderAssistantToolUse,
} from "../../src/webview/renderers/assistant-tool-use";
import {
  createUserToolResultState,
  renderUserToolResult,
} from "../../src/webview/renderers/user-tool-result";
import {
  createResultState,
  renderResult,
} from "../../src/webview/renderers/result";
import type {
  AssistantEvent,
  ResultEvent,
  StreamEvent,
  SystemInitEvent,
  UserEvent,
} from "../../src/webview/parser/types";

const FIXTURE_DIR = path.resolve(
  __dirname,
  "..",
  "fixtures",
  "stream-json",
);

/** The five card kinds Phase 2 renderers emit — CSS modifier suffix form. */
const CARD_KIND_UNIVERSE: ReadonlySet<string> = new Set([
  "system-init",
  "assistant-text",
  "assistant-tool-use",
  "user-tool-result",
  "result",
]);

interface FixtureExpectation {
  readonly fixture: string;
  readonly cardKinds: ReadonlySet<string>;
  readonly cardCountByKind: Readonly<Record<string, number>>;
}

/**
 * Expected cardKinds Set membership + cardCountByKind counts.
 *
 * Counts are the **keyed-upsert cardinality** — one card per distinct
 * `session_id` / `message.id` / `tool_use.id` / `tool_use_id` / `(session_id,
 * uuid)` compound key. They do NOT equal raw event counts when partial-
 * messages mode or multi-turn tool loops re-emit the same id.
 */
const EXPECTED: ReadonlyArray<FixtureExpectation> = [
  {
    fixture: "hello.jsonl",
    cardKinds: new Set(["system-init", "assistant-text", "result"]),
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
    cardKinds: new Set([
      "system-init",
      "assistant-text",
      "assistant-tool-use",
      "user-tool-result",
      "result",
    ]),
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
    cardKinds: new Set([
      "system-init",
      "assistant-text",
      "assistant-tool-use",
      "user-tool-result",
      "result",
    ]),
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
    cardKinds: new Set([
      "system-init",
      "assistant-text",
      "assistant-tool-use",
      "user-tool-result",
      "result",
    ]),
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
    // resume-failure fixture — no init, no turns, just a single result card.
    cardKinds: new Set(["result"]),
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
    // /compact emits system status + compact_boundary around a reset; the
    // two user events carry no tool_result blocks, so no user-tool-result
    // cards render. Assistant-text / tool-use are also absent.
    cardKinds: new Set(["system-init", "result"]),
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
    // /mcp is rejected at the slash-command parser; only init + result.
    cardKinds: new Set(["system-init", "result"]),
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
    // Phase 4b: TodoWrite is hoisted by the dedicated todo-panel renderer
    // and no longer produces an `assistant-tool-use` card — only ToolSearch
    // remains in the generic path. The phase-2-scoped dispatcher below does
    // not call the todo-panel renderer, so the todo-summary card is not
    // counted here; the SH-03 / 4b-4 gate verifies the summary card via
    // `scripts/render-fixture.ts` on `artifacts/phase-4b/render-todo.json`.
    cardKinds: new Set([
      "system-init",
      "assistant-text",
      "assistant-tool-use",
      "user-tool-result",
      "result",
    ]),
    cardCountByKind: {
      "system-init": 1,
      "assistant-text": 1,
      "assistant-tool-use": 1,
      "user-tool-result": 2,
      result: 1,
    },
  },
];

interface RenderResult {
  readonly cardKinds: Set<string>;
  readonly cardCountByKind: Record<string, number>;
  readonly parent: HTMLElement;
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

/**
 * Drive each event through the matching Phase 2 renderer. Returns a snapshot
 * of the DOM's card-kind distribution so the test can assert Set membership
 * and per-kind counts without reaching into each renderer's private state.
 */
function renderFixtureToCards(fixturePath: string): RenderResult {
  const { events } = replayFixture(fixturePath);
  const window = new Window();
  const doc = window.document as unknown as Document;
  const parent = doc.createElement("div");
  (doc.body as unknown as HTMLElement).replaceChildren(parent);

  const sysInitState = createSystemInitState();
  const assistantTextState = createAssistantTextState();
  const assistantToolUseState = createAssistantToolUseState();
  const userToolResultState = createUserToolResultState();
  const resultState = createResultState();

  for (const ev of events) {
    if (isSystemInit(ev)) {
      renderSystemInit(sysInitState, parent, ev, doc);
    } else if (isAssistant(ev)) {
      // renderAssistantText is a no-op for tool-use-only events (returns
      // null); renderAssistantToolUse is a no-op for text-only events
      // (returns []). Calling both mirrors what the card-registry dispatch
      // does at runtime.
      renderAssistantText(assistantTextState, parent, ev, doc);
      renderAssistantToolUse(assistantToolUseState, parent, ev, doc);
    } else if (isUser(ev)) {
      renderUserToolResult(userToolResultState, parent, ev, doc);
    } else if (isResult(ev)) {
      renderResult(resultState, parent, ev, doc);
    }
    // Other event types (rate_limit_event, system hooks / status / compact
    // boundary) have no Phase 2 renderer — they will land in Phase 5a. They
    // are correctly omitted from `cardKinds` for Phase 2 AC 5.
  }

  const cards = parent.querySelectorAll(".claude-wv-card");
  const cardKinds = new Set<string>();
  const cardCountByKind: Record<string, number> = {};
  // Initialize all known kinds to zero so the test can assert explicit 0
  // entries without tripping on undefined vs 0 ambiguity.
  for (const k of CARD_KIND_UNIVERSE) cardCountByKind[k] = 0;

  for (const card of Array.from(cards)) {
    const modifier = extractKind(card);
    if (modifier !== null) {
      cardKinds.add(modifier);
      cardCountByKind[modifier] = (cardCountByKind[modifier] ?? 0) + 1;
    }
  }

  return { cardKinds, cardCountByKind, parent };
}

/**
 * Pull the `claude-wv-card--<kind>` modifier off a card element. Returns the
 * kind string without the `claude-wv-card--` prefix, or `null` if the card
 * has no recognized modifier class (should never happen — renderers always
 * emit both base + modifier).
 */
function extractKind(el: Element): string | null {
  const classes = Array.from(el.classList);
  for (const c of classes) {
    if (c.startsWith("claude-wv-card--")) {
      return c.slice("claude-wv-card--".length);
    }
  }
  return null;
}

describe("AC 5 — per-fixture cardKinds Set membership and cardCountByKind", () => {
  for (const exp of EXPECTED) {
    describe(exp.fixture, () => {
      it("cardKinds Set membership matches expected", () => {
        const { cardKinds } = renderFixtureToCards(
          path.join(FIXTURE_DIR, exp.fixture),
        );
        const actual = [...cardKinds].sort();
        const expected = [...exp.cardKinds].sort();
        expect(actual).toEqual(expected);

        // Every emitted kind must be in the known Phase 2 vocabulary.
        for (const k of cardKinds) {
          expect(CARD_KIND_UNIVERSE.has(k)).toBe(true);
        }
      });

      it("cardCountByKind counts match expected (keyed-upsert cardinality)", () => {
        const { cardCountByKind } = renderFixtureToCards(
          path.join(FIXTURE_DIR, exp.fixture),
        );
        for (const kind of CARD_KIND_UNIVERSE) {
          expect(
            cardCountByKind[kind],
            `fixture=${exp.fixture}, kind=${kind}`,
          ).toBe(exp.cardCountByKind[kind] ?? 0);
        }
      });

      it("every rendered card carries both base + modifier classes", () => {
        const { parent } = renderFixtureToCards(
          path.join(FIXTURE_DIR, exp.fixture),
        );
        const cards = parent.querySelectorAll(".claude-wv-card");
        for (const card of Array.from(cards)) {
          expect(card.classList.contains("claude-wv-card")).toBe(true);
          const modifier = extractKind(card);
          expect(modifier).not.toBeNull();
        }
      });
    });
  }

  it("cross-fixture differential: hello ⊂ edit for cardKinds (strict subset)", () => {
    const hello = renderFixtureToCards(path.join(FIXTURE_DIR, "hello.jsonl"));
    const edit = renderFixtureToCards(path.join(FIXTURE_DIR, "edit.jsonl"));
    // Every kind hello emits must also appear in edit (system-init, assistant-
    // text, result), but edit additionally emits tool_use + tool_result cards
    // that hello never does — proves renderers are content-driven, not
    // hardcoded per fixture.
    for (const k of hello.cardKinds) {
      expect(edit.cardKinds.has(k)).toBe(true);
    }
    expect(edit.cardKinds.size).toBeGreaterThan(hello.cardKinds.size);
    expect(edit.cardKinds.has("assistant-tool-use")).toBe(true);
    expect(edit.cardKinds.has("user-tool-result")).toBe(true);
    expect(hello.cardKinds.has("assistant-tool-use")).toBe(false);
    expect(hello.cardKinds.has("user-tool-result")).toBe(false);
  });

  it("cross-fixture differential: resume.jsonl has ONLY result card", () => {
    const resume = renderFixtureToCards(
      path.join(FIXTURE_DIR, "resume.jsonl"),
    );
    expect([...resume.cardKinds]).toEqual(["result"]);
    expect(resume.cardCountByKind.result).toBe(1);
    // The resume-failure fixture lacks an init event — no system-init card.
    expect(resume.cardCountByKind["system-init"]).toBe(0);
  });

  it("cross-fixture differential: slash fixtures emit init + result only", () => {
    const compact = renderFixtureToCards(
      path.join(FIXTURE_DIR, "slash-compact.jsonl"),
    );
    const mcp = renderFixtureToCards(
      path.join(FIXTURE_DIR, "slash-mcp.jsonl"),
    );
    expect([...compact.cardKinds].sort()).toEqual(["result", "system-init"]);
    expect([...mcp.cardKinds].sort()).toEqual(["result", "system-init"]);
    // Both slash fixtures share the same cardKinds shape but are distinct
    // sessions → session_ids differ inside their init + result cards.
  });

  it("sum of cardCountByKind values equals total card-DOM count for every fixture", () => {
    for (const exp of EXPECTED) {
      const { parent, cardCountByKind } = renderFixtureToCards(
        path.join(FIXTURE_DIR, exp.fixture),
      );
      const total = Object.values(cardCountByKind).reduce(
        (s, n) => s + n,
        0,
      );
      const domCount = parent.querySelectorAll(".claude-wv-card").length;
      expect(domCount).toBe(total);
    }
  });
});
