/**
 * Phase 5a Task 6 / 9 — SystemStatusEvent spinner renderer (SH-05).
 *
 * Runtime contract:
 *   - `renderSystemStatus(state, headerEl, event, doc)` MUTATES `headerEl`
 *     by upserting a single `<div class="claude-wv-status-spinner">` child.
 *   - When `event.status` is a non-empty string the element is present, its
 *     `data-status` attribute matches the status token, and its textContent
 *     surfaces the status as a human label (NOT a raw JSON dump).
 *   - When `event.status` is `null` the spinner element is removed from
 *     `headerEl` — `querySelector` returns null.
 *   - `role="status"` + `aria-live="polite"` so screen readers pick up
 *     the transient progress signal.
 *   - `data-status` is slugified: lowercase + non-alpha replaced with `_`.
 *
 * Two events in the same `headerEl` replace (not append) — a single spinner
 * per header is the UX invariant.
 */
import { describe, it, expect } from "vitest";
import { Window } from "happy-dom";
import {
  createSystemStatusState,
  renderSystemStatus,
  clearSystemStatus,
} from "../../src/webview/renderers/system-status";
import type { SystemStatusEvent } from "../../src/webview/parser/types";

function makeHeader(): { doc: Document; headerEl: HTMLElement } {
  const { document } = new Window();
  const doc = document as unknown as Document;
  const headerEl = doc.createElement("div");
  headerEl.className = "claude-wv-header";
  (doc.body as unknown as HTMLElement).replaceChildren(headerEl);
  return { doc, headerEl };
}

function statusEvent(status: string | null): SystemStatusEvent {
  return {
    type: "system",
    subtype: "status",
    status,
    session_id: "00000000-0000-0000-0000-000000000000",
    uuid: "11111111-1111-1111-1111-111111111111",
  };
}

describe("renderSystemStatus (SH-05)", () => {
  it("non-null status renders a single spinner with role=status, aria-live=polite and textContent containing the status label", () => {
    const { doc, headerEl } = makeHeader();
    const state = createSystemStatusState();
    renderSystemStatus(state, headerEl, statusEvent("compacting"), doc);

    const spinners = headerEl.querySelectorAll(".claude-wv-status-spinner");
    expect(spinners.length).toBe(1);
    const spinner = spinners[0] as unknown as HTMLElement;
    expect(spinner.getAttribute("role")).toBe("status");
    expect(spinner.getAttribute("aria-live")).toBe("polite");
    expect(spinner.getAttribute("data-status")).toBe("compacting");
    expect(spinner.textContent ?? "").toContain("compacting");
  });

  it("null status removes the spinner — querySelector returns null", () => {
    const { doc, headerEl } = makeHeader();
    const state = createSystemStatusState();
    renderSystemStatus(state, headerEl, statusEvent("compacting"), doc);
    renderSystemStatus(state, headerEl, statusEvent(null), doc);
    expect(headerEl.querySelector(".claude-wv-status-spinner")).toBeNull();
  });

  it("re-entry with a different non-null status updates in place (no duplicate spinner)", () => {
    const { doc, headerEl } = makeHeader();
    const state = createSystemStatusState();
    renderSystemStatus(state, headerEl, statusEvent("compacting"), doc);
    renderSystemStatus(state, headerEl, statusEvent("thinking"), doc);

    const spinners = headerEl.querySelectorAll(".claude-wv-status-spinner");
    expect(spinners.length).toBe(1);
    const spinner = spinners[0] as unknown as HTMLElement;
    expect(spinner.getAttribute("data-status")).toBe("thinking");
    expect(spinner.textContent ?? "").toContain("thinking");
  });

  it("clearSystemStatus removes the spinner regardless of CLI status emission (2026-05-01 dogfood)", () => {
    const { doc, headerEl } = makeHeader();
    const state = createSystemStatusState();
    renderSystemStatus(state, headerEl, statusEvent("requesting"), doc);
    expect(headerEl.querySelector(".claude-wv-status-spinner")).not.toBeNull();

    clearSystemStatus(state);
    expect(headerEl.querySelector(".claude-wv-status-spinner")).toBeNull();
    expect(state.el).toBeNull();

    // Idempotent — calling again on already-cleared state is a no-op.
    expect(() => clearSystemStatus(state)).not.toThrow();
  });

  it("data-status is slugified (lowercase + non-alpha → '_'); display label preserves the human string", () => {
    const { doc, headerEl } = makeHeader();
    const state = createSystemStatusState();
    renderSystemStatus(state, headerEl, statusEvent("Running Hooks"), doc);
    const spinner = headerEl.querySelector(
      ".claude-wv-status-spinner",
    ) as unknown as HTMLElement;
    expect(spinner.getAttribute("data-status")).toBe("running_hooks");
    expect(spinner.textContent ?? "").toContain("Running Hooks");
  });
});
