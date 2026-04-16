/**
 * Phase 5a Task 4 / 9 — status bar (SH-06).
 *
 * Contract:
 *   - `buildStatusBar(root, doc): { el, update(event) }` factory.
 *   - `update(event)` reads `event.modelUsage[<model>]` where
 *     model is the single key in `modelUsage`. `inputTokens +
 *     outputTokens` feeds the tokens badge; `contextWindow` feeds the
 *     "ctx%" badge; `costUSD` the cost badge. Falls back to
 *     `event.total_cost_usd` if per-model costUSD is missing.
 *   - **Source of truth is `result.modelUsage`, NOT `assistant.usage`.**
 *     If assistant-style `event.usage.input_tokens` disagrees with
 *     `modelUsage.<m>.inputTokens` the status bar MUST surface the
 *     modelUsage value (5a-4 differential).
 *   - Badges carry `data-kind="tokens|ctx|cost|model"` attributes so
 *     assertions don't depend on text position.
 *   - Empty modelUsage (e.g. slash-mcp result) renders "-" placeholders
 *     without throwing.
 */
import { describe, it, expect } from "vitest";
import { Window } from "happy-dom";
import { buildStatusBar } from "../../src/webview/ui/status-bar";
import type { ResultEvent } from "../../src/webview/parser/types";

function makeRoot(): { doc: Document; root: HTMLElement } {
  const { document } = new Window();
  const doc = document as unknown as Document;
  const root = doc.createElement("div");
  (doc.body as unknown as HTMLElement).replaceChildren(root);
  return { doc, root };
}

function getBadgeText(el: HTMLElement, kind: string): string {
  const badge = el.querySelector(`[data-kind="${kind}"]`);
  return (badge?.textContent ?? "").trim();
}

function baseResult(): ResultEvent {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1234,
    num_turns: 2,
    result: "",
    session_id: "00000000-0000-0000-0000-000000000000",
    uuid: "11111111-1111-1111-1111-111111111111",
    total_cost_usd: 0.1,
    usage: { input_tokens: 999, output_tokens: 999 },
    modelUsage: {
      "claude-opus-4-6[1m]": {
        inputTokens: 12017,
        outputTokens: 529,
        contextWindow: 1000000,
        costUSD: 0.17440375,
      },
    },
  };
}

describe("buildStatusBar (SH-06)", () => {
  it("renders tokens / ctx% / cost / model badges from result.modelUsage fields", () => {
    const { doc, root } = makeRoot();
    const bar = buildStatusBar(root, doc);
    bar.update(baseResult());
    expect(getBadgeText(bar.el, "tokens")).toBe("12546");
    expect(getBadgeText(bar.el, "ctx")).toBe("1%");
    expect(getBadgeText(bar.el, "cost")).toMatch(/^\$0\.1744/);
    expect(getBadgeText(bar.el, "model")).toBe("claude-opus-4-6[1m]");
  });

  it("derives from result.modelUsage not assistant.usage (5a-4)", () => {
    // Inject a result where `usage.input_tokens` disagrees with
    // `modelUsage.<m>.inputTokens` — the status bar must surface the
    // modelUsage value, NOT the assistant-style aggregate.
    const { doc, root } = makeRoot();
    const bar = buildStatusBar(root, doc);
    const ev: ResultEvent = {
      ...baseResult(),
      usage: { input_tokens: 1, output_tokens: 1 }, // disagrees on purpose
      modelUsage: {
        "claude-opus-4-6[1m]": {
          inputTokens: 500,
          outputTokens: 100,
          contextWindow: 1000,
          costUSD: 0.5,
        },
      },
    };
    bar.update(ev);
    expect(getBadgeText(bar.el, "tokens")).toBe("600"); // 500+100 from modelUsage
    // assistant-style usage would have yielded "2" — never observed here.
    expect(getBadgeText(bar.el, "tokens")).not.toBe("2");
    expect(getBadgeText(bar.el, "ctx")).toBe("60%"); // 600/1000 = 60%
    expect(getBadgeText(bar.el, "cost")).toMatch(/^\$0\.5/);
  });

  it("different fixtures produce different token badges (differential)", () => {
    const { doc, root } = makeRoot();
    const bar = buildStatusBar(root, doc);
    const a: ResultEvent = {
      ...baseResult(),
      modelUsage: {
        "claude-a": {
          inputTokens: 100,
          outputTokens: 10,
          contextWindow: 2000,
          costUSD: 0.01,
        },
      },
    };
    const b: ResultEvent = {
      ...baseResult(),
      modelUsage: {
        "claude-b": {
          inputTokens: 500,
          outputTokens: 200,
          contextWindow: 2000,
          costUSD: 0.05,
        },
      },
    };
    bar.update(a);
    const tokensA = getBadgeText(bar.el, "tokens");
    const modelA = getBadgeText(bar.el, "model");
    bar.update(b);
    const tokensB = getBadgeText(bar.el, "tokens");
    const modelB = getBadgeText(bar.el, "model");
    expect(tokensA).toBe("110");
    expect(tokensB).toBe("700");
    expect(tokensA).not.toBe(tokensB);
    expect(modelA).not.toBe(modelB);
  });

  it("empty modelUsage (slash-mcp result) renders '-' placeholders without throwing", () => {
    const { doc, root } = makeRoot();
    const bar = buildStatusBar(root, doc);
    const ev: ResultEvent = {
      ...baseResult(),
      total_cost_usd: 0,
      modelUsage: {},
    };
    expect(() => bar.update(ev)).not.toThrow();
    expect(getBadgeText(bar.el, "tokens")).toBe("-");
    expect(getBadgeText(bar.el, "ctx")).toBe("-");
    // cost falls back to total_cost_usd when per-model costUSD is missing.
    expect(getBadgeText(bar.el, "cost")).toMatch(/\$0\.00/);
    expect(getBadgeText(bar.el, "model")).toBe("-");
  });

  it("falls back to total_cost_usd when per-model costUSD is undefined", () => {
    const { doc, root } = makeRoot();
    const bar = buildStatusBar(root, doc);
    const ev: ResultEvent = {
      ...baseResult(),
      total_cost_usd: 0.25,
      modelUsage: {
        "claude-a": {
          inputTokens: 10,
          outputTokens: 10,
          contextWindow: 200,
        }, // no costUSD field
      },
    };
    bar.update(ev);
    expect(getBadgeText(bar.el, "cost")).toMatch(/^\$0\.25/);
    expect(getBadgeText(bar.el, "tokens")).toBe("20");
  });
});
