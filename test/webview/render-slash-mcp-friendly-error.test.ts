/**
 * Phase 5a Task 7 — slash-mcp friendly-error surface (5a-2).
 *
 * The `/mcp` slash command is not supported in the Beta; the CLI returns
 * `result.subtype: "success"` + `result.result: "Unknown command: /mcp"`.
 * The Phase 5a renderer must surface that human string on the result card
 * (a "result-message" row) so the user sees a friendly error instead of
 * falling back to the collapsed UnknownEvent JSON dump.
 *
 * Contract:
 *   - When `ResultEvent.result` is a non-empty string, the result card
 *     includes a row with key `message` and value equal to the string.
 *   - When `ResultEvent.result` is absent / empty, the message row is
 *     NOT emitted (backwards compat — hello.jsonl result has no message).
 *   - No `.claude-wv-card--unknown` appears for slash-mcp replay (raw JSON
 *     dump must be avoided — evidence field `rawJsonDumpShown` stays
 *     false).
 */
import { describe, it, expect } from "vitest";
import { Window } from "happy-dom";
import path from "node:path";
import { replayFixture } from "./helpers/fixture-replay";
import {
  createResultState,
  renderResult,
} from "../../src/webview/renderers/result";
import type { ResultEvent, StreamEvent } from "../../src/webview/parser/types";

const FIXTURE_DIR = path.resolve(__dirname, "..", "fixtures", "stream-json");

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

describe("slash-mcp friendly error surface (Phase 5a)", () => {
  it("result.result non-empty → card includes a 'message' row with the string", () => {
    const replay = replayFixture(
      path.join(FIXTURE_DIR, "slash-mcp.jsonl"),
    );
    const ev = replay.events.filter(isResult)[0];
    expect(ev.result).toBe("Unknown command: /mcp");

    const { document } = new Window();
    const doc = document as unknown as Document;
    const parent = doc.createElement("div");
    (doc.body as unknown as HTMLElement).replaceChildren(parent);
    const state = createResultState();
    const card = renderResult(state, parent, ev, doc);

    expect(rowValue(card, "message")).toBe("Unknown command: /mcp");
    // Full textContent must include the friendly error so CMD 5a-2
    // evidence `friendlyErrorShown === true` passes.
    expect((card.textContent ?? "")).toContain("Unknown command: /mcp");
  });

  it("result.result empty → message row is omitted (backwards compat)", () => {
    const replay = replayFixture(
      path.join(FIXTURE_DIR, "slash-compact.jsonl"),
    );
    const ev = replay.events.filter(isResult)[0];
    expect(ev.result).toBe("");

    const { document } = new Window();
    const doc = document as unknown as Document;
    const parent = doc.createElement("div");
    (doc.body as unknown as HTMLElement).replaceChildren(parent);
    const state = createResultState();
    const card = renderResult(state, parent, ev, doc);
    expect(rowValue(card, "message")).toBeNull();
  });

  it("resume.jsonl (error_during_execution): no `result` string so the message row is absent", () => {
    const replay = replayFixture(path.join(FIXTURE_DIR, "resume.jsonl"));
    const ev = replay.events.filter(isResult)[0];
    const { document } = new Window();
    const doc = document as unknown as Document;
    const parent = doc.createElement("div");
    (doc.body as unknown as HTMLElement).replaceChildren(parent);
    const state = createResultState();
    const card = renderResult(state, parent, ev, doc);
    // resume fixture has no `result` string on the result event — row absent.
    if (typeof ev.result === "string" && ev.result.length > 0) {
      expect(rowValue(card, "message")).toBe(ev.result);
    } else {
      expect(rowValue(card, "message")).toBeNull();
    }
  });
});
