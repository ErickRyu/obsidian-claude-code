import { describe, it, expect } from "vitest";
import { Window } from "happy-dom";
import {
  createSystemInitState,
  renderSystemInit,
} from "../../src/webview/renderers/system-init";
import type { SystemInitEvent } from "../../src/webview/parser/types";

function baseInit(overrides: Partial<SystemInitEvent> = {}): SystemInitEvent {
  return {
    type: "system",
    subtype: "init",
    session_id: "sess-abcdefgh-1234",
    uuid: "u-1",
    cwd: "/tmp/project",
    model: "claude-opus-4-6",
    permissionMode: "acceptEdits",
    mcp_servers: [
      { name: "ouroboros", status: "connected" },
      { name: "notion", status: "connected" },
      { name: "broken", status: "failed" },
    ],
    ...overrides,
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

describe("render-system-init (MH-06)", () => {
  it("renders a header card with model, permission, mcp_servers, cwd, session rows", () => {
    const window = new Window();
    const doc = window.document;
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);
    const state = createSystemInitState();

    const ev = baseInit();
    const card = renderSystemInit(
      state,
      parent as unknown as HTMLElement,
      ev,
      doc as unknown as Document,
    );

    expect(card.classList.contains("claude-wv-card")).toBe(true);
    expect(card.classList.contains("claude-wv-card--system-init")).toBe(true);
    expect(card.getAttribute("data-session-id")).toBe("sess-abcdefgh-1234");

    expect(kvValue(card, "model")).toBe("claude-opus-4-6");
    expect(kvValue(card, "permission")).toBe("acceptEdits");
    expect(kvValue(card, "mcp_servers")).toBe("2 connected / 3 total");
    expect(kvValue(card, "cwd")).toBe("/tmp/project");
    // Truncated session id (first 8 chars + ellipsis).
    expect(kvValue(card, "session")).toBe("sess-abc…");
  });

  it("falls back to \"-\" when optional fields are absent", () => {
    const window = new Window();
    const doc = window.document;
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);
    const state = createSystemInitState();

    const ev: SystemInitEvent = {
      type: "system",
      subtype: "init",
      session_id: "short",
      uuid: "u",
    };
    const card = renderSystemInit(
      state,
      parent as unknown as HTMLElement,
      ev,
      doc as unknown as Document,
    );
    expect(kvValue(card, "model")).toBe("-");
    expect(kvValue(card, "permission")).toBe("-");
    expect(kvValue(card, "mcp_servers")).toBe("0");
    expect(kvValue(card, "cwd")).toBe("-");
    // Short session id passes through without truncation.
    expect(kvValue(card, "session")).toBe("short");
  });

  it("upserts by session_id — re-emit keeps one card and refreshes values", () => {
    const window = new Window();
    const doc = window.document;
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);
    const state = createSystemInitState();

    renderSystemInit(
      state,
      parent as unknown as HTMLElement,
      baseInit({ model: "claude-sonnet-3-5" }),
      doc as unknown as Document,
    );
    renderSystemInit(
      state,
      parent as unknown as HTMLElement,
      baseInit({ model: "claude-opus-4-6" }),
      doc as unknown as Document,
    );
    expect(state.cards.size).toBe(1);
    expect(parent.children.length).toBe(1);
    const card = parent.children[0] as unknown as HTMLElement;
    expect(kvValue(card, "model")).toBe("claude-opus-4-6");
  });

  it("distinct session_ids produce distinct cards in parent", () => {
    const window = new Window();
    const doc = window.document;
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);
    const state = createSystemInitState();

    renderSystemInit(
      state,
      parent as unknown as HTMLElement,
      baseInit({ session_id: "one-abcdefgh" }),
      doc as unknown as Document,
    );
    renderSystemInit(
      state,
      parent as unknown as HTMLElement,
      baseInit({ session_id: "two-abcdefgh" }),
      doc as unknown as Document,
    );
    expect(state.cards.size).toBe(2);
    expect(parent.children.length).toBe(2);
  });
});
