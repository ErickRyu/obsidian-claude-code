import { describe, it, expect } from "vitest";
import { Window } from "happy-dom";
import path from "node:path";
import { replayFixture, eventCountByType } from "./helpers/fixture-replay";
import {
  createAssistantTextState,
  renderAssistantText,
} from "../../src/webview/renderers/assistant-text";
import type { AssistantEvent } from "../../src/webview/parser/types";

const FIXTURE_PATH = path.resolve(
  __dirname,
  "..",
  "fixtures",
  "stream-json",
  "hello.jsonl",
);

describe("hello.jsonl baseline text rendering (SH-01)", () => {
  it("parses with rawSkipped === 0 (baseline parser contract)", () => {
    const { events, rawSkipped } = replayFixture(FIXTURE_PATH);
    expect(rawSkipped).toBe(0);
    expect(events.length).toBeGreaterThan(0);
  });

  it("contains at least one assistant event and zero unknown events", () => {
    const { events, unknownEventCount } = replayFixture(FIXTURE_PATH);
    const counts = eventCountByType(events);
    expect(counts.assistant ?? 0).toBeGreaterThanOrEqual(1);
    expect(unknownEventCount).toBe(0);
  });

  it("differential check: hello has exactly 1 assistant event and no user events", () => {
    const { events } = replayFixture(FIXTURE_PATH);
    const counts = eventCountByType(events);
    expect(counts.assistant).toBe(1);
    expect(counts.user).toBeUndefined();
  });

  it("renders an assistant-text card containing 'hello'", () => {
    const { events } = replayFixture(FIXTURE_PATH);
    const window = new Window();
    const doc = window.document;
    const parent = doc.createElement("div");
    parent.classList.add("claude-wv-cards");
    doc.body.appendChild(parent);

    const state = createAssistantTextState();
    let renderedCard: HTMLElement | null = null;
    for (const ev of events) {
      if (ev.type === "assistant") {
        renderedCard = renderAssistantText(
          state,
          parent as unknown as HTMLElement,
          ev as AssistantEvent,
          doc as unknown as Document,
        );
      }
    }

    expect(renderedCard).not.toBeNull();
    expect(state.cards.size).toBe(1);
    const card = renderedCard as unknown as HTMLElement;
    expect(card.classList.contains("claude-wv-card")).toBe(true);
    expect(card.classList.contains("claude-wv-card--assistant-text")).toBe(true);
    const text = (card.textContent ?? "").trim();
    expect(text.toLowerCase()).toContain("hello");
    const blocks = card.querySelectorAll(".claude-wv-text-block");
    expect(blocks.length).toBe(1);
  });
});
