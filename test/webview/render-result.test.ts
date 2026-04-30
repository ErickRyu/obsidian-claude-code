import { describe, it, expect } from "vitest";
import { Window } from "happy-dom";
import { createResultState, renderResult } from "../../src/webview/renderers/result";
import type { ResultEvent } from "../../src/webview/parser/types";

function baseResult(overrides: Partial<ResultEvent> = {}): ResultEvent {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 3087,
    num_turns: 1,
    result: "hello",
    session_id: "sess-123",
    total_cost_usd: 0.25025875,
    usage: { input_tokens: 3, output_tokens: 4 },
    uuid: "uuid-1",
    ...overrides,
  };
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

describe("render-result (MH-05)", () => {
  it("renders a card with subtype, duration, cost, tokens, turns rows", () => {
    const window = new Window();
    const doc = window.document;
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);
    const state = createResultState();

    const ev = baseResult();
    const card = renderResult(
      state,
      parent as unknown as HTMLElement,
      ev,
      doc as unknown as Document,
    );

    expect(card.classList.contains("claude-wv-card")).toBe(true);
    expect(card.classList.contains("claude-wv-card--result")).toBe(true);
    expect(card.getAttribute("data-session-id")).toBe("sess-123");
    expect(card.getAttribute("data-subtype")).toBe("success");
    expect(card.hasAttribute("data-is-error")).toBe(false);

    expect(rowValue(card, "subtype")).toBe("success");
    expect(rowValue(card, "duration")).toBe("3087ms");
    expect(rowValue(card, "cost")).toBe("$0.2503");
    expect(rowValue(card, "tokens")).toBe("3/4");
    expect(rowValue(card, "turns")).toBe("1");
  });

  it("marks data-is-error=\"true\" on error results", () => {
    const window = new Window();
    const doc = window.document;
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);
    const state = createResultState();

    const ev = baseResult({ subtype: "error", is_error: true });
    const card = renderResult(
      state,
      parent as unknown as HTMLElement,
      ev,
      doc as unknown as Document,
    );
    expect(card.getAttribute("data-is-error")).toBe("true");
    expect(card.getAttribute("data-subtype")).toBe("error");
  });

  it("upserts on (session_id, uuid) — re-emit keeps one card and refreshes values", () => {
    const window = new Window();
    const doc = window.document;
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);
    const state = createResultState();

    renderResult(
      state,
      parent as unknown as HTMLElement,
      baseResult({ duration_ms: 100 }),
      doc as unknown as Document,
    );
    renderResult(
      state,
      parent as unknown as HTMLElement,
      baseResult({ duration_ms: 200 }),
      doc as unknown as Document,
    );

    expect(state.cards.size).toBe(1);
    expect(parent.children.length).toBe(1);
    const card = parent.children[0] as unknown as HTMLElement;
    expect(rowValue(card, "duration")).toBe("200ms");
  });

  it("renders \"-\" placeholders when numeric fields are missing", () => {
    const window = new Window();
    const doc = window.document;
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);
    const state = createResultState();

    const ev: ResultEvent = {
      type: "result",
      subtype: "partial",
      session_id: "s",
      uuid: "u",
    };
    const card = renderResult(
      state,
      parent as unknown as HTMLElement,
      ev,
      doc as unknown as Document,
    );
    expect(rowValue(card, "duration")).toBe("-");
    expect(rowValue(card, "cost")).toBe("-");
    expect(rowValue(card, "tokens")).toBe("-");
    expect(rowValue(card, "turns")).toBe("-");
  });

  it("distinct sessions/uuids produce distinct cards", () => {
    const window = new Window();
    const doc = window.document;
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);
    const state = createResultState();

    renderResult(
      state,
      parent as unknown as HTMLElement,
      baseResult({ session_id: "a", uuid: "u1" }),
      doc as unknown as Document,
    );
    renderResult(
      state,
      parent as unknown as HTMLElement,
      baseResult({ session_id: "b", uuid: "u2" }),
      doc as unknown as Document,
    );
    expect(state.cards.size).toBe(2);
    expect(parent.children.length).toBe(2);
  });
});
