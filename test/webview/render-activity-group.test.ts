import { describe, it, expect } from "vitest";
import { Window } from "happy-dom";
import {
  createActivityGroupState,
  ensureActivityGroup,
  closeActivityGroup,
  registerToolUseLine,
  findToolLine,
  setLinePending,
  setLineError,
} from "../../src/webview/renderers/activity-group";

function setupDom() {
  const window = new Window();
  const doc = window.document;
  const parent = doc.createElement("div");
  doc.body.appendChild(parent);
  return { doc, parent };
}

function makeLine(doc: Document, toolUseId: string, name: string): HTMLElement {
  const line = doc.createElement("div");
  line.classList.add("claude-wv-tool-line");
  line.setAttribute("data-tool-use-id", toolUseId);
  line.setAttribute("data-tool-name", name);
  line.setAttribute("data-pending", "true");
  return line as unknown as HTMLElement;
}

describe("activity-group lifecycle", () => {
  it("ensureActivityGroup creates a container with header + body and appends to parent", () => {
    const { doc, parent } = setupDom();
    const state = createActivityGroupState();

    const body = ensureActivityGroup(
      state,
      parent as unknown as HTMLElement,
      doc as unknown as Document,
    );

    expect(parent.children.length).toBe(1);
    const group = parent.children[0] as HTMLElement;
    expect(group.classList.contains("claude-wv-card")).toBe(true);
    expect(group.classList.contains("claude-wv-card--activity-group")).toBe(true);

    // <details>-based collapsed-by-default container
    const details = group.querySelector("details.claude-wv-activity-group-details") as HTMLDetailsElement | null;
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);

    // Header summary text shows "Activity" with no tools yet → "0 tools"
    const summary = details?.querySelector("summary.claude-wv-activity-group-header");
    expect(summary).not.toBeNull();
    expect(summary?.textContent ?? "").toContain("Activity");

    // Body element returned matches the group body inside details
    expect(body.classList.contains("claude-wv-activity-group-body")).toBe(true);
    expect(group.contains(body)).toBe(true);
  });

  it("ensureActivityGroup is idempotent — repeated calls reuse the same group/body", () => {
    const { doc, parent } = setupDom();
    const state = createActivityGroupState();

    const body1 = ensureActivityGroup(state, parent as unknown as HTMLElement, doc as unknown as Document);
    const body2 = ensureActivityGroup(state, parent as unknown as HTMLElement, doc as unknown as Document);

    expect(body1).toBe(body2);
    expect(parent.children.length).toBe(1);
  });

  it("closeActivityGroup ends the active group; a subsequent ensure creates a NEW group", () => {
    const { doc, parent } = setupDom();
    const state = createActivityGroupState();

    const body1 = ensureActivityGroup(state, parent as unknown as HTMLElement, doc as unknown as Document);
    closeActivityGroup(state);
    const body2 = ensureActivityGroup(state, parent as unknown as HTMLElement, doc as unknown as Document);

    expect(body1).not.toBe(body2);
    expect(parent.children.length).toBe(2);
  });

  it("registerToolUseLine appends the line to the group body and updates the header count", () => {
    const { doc, parent } = setupDom();
    const state = createActivityGroupState();
    const body = ensureActivityGroup(state, parent as unknown as HTMLElement, doc as unknown as Document);

    const lineA = makeLine(doc as unknown as Document, "toolu_a", "Read");
    const lineB = makeLine(doc as unknown as Document, "toolu_b", "Bash");
    registerToolUseLine(state, "toolu_a", lineA);
    registerToolUseLine(state, "toolu_b", lineB);

    expect(body.children.length).toBe(2);
    expect(body.contains(lineA)).toBe(true);
    expect(body.contains(lineB)).toBe(true);

    const group = parent.children[0] as HTMLElement;
    const header = group.querySelector("summary.claude-wv-activity-group-header");
    const headerText = header?.textContent ?? "";
    expect(headerText).toContain("2");
    // While any line is pending, the header surfaces a running indicator.
    expect(group.getAttribute("data-pending")).toBe("true");
  });

  it("registerToolUseLine with the same id is idempotent (no duplicate, no extra count)", () => {
    const { doc, parent } = setupDom();
    const state = createActivityGroupState();
    const body = ensureActivityGroup(state, parent as unknown as HTMLElement, doc as unknown as Document);

    const lineA = makeLine(doc as unknown as Document, "toolu_a", "Read");
    registerToolUseLine(state, "toolu_a", lineA);
    registerToolUseLine(state, "toolu_a", lineA);

    expect(body.children.length).toBe(1);
    const group = parent.children[0] as HTMLElement;
    const headerText = group.querySelector("summary.claude-wv-activity-group-header")?.textContent ?? "";
    expect(headerText).toContain("1");
  });

  it("findToolLine returns the registered line by tool_use_id; null for unknown ids", () => {
    const { doc, parent } = setupDom();
    const state = createActivityGroupState();
    ensureActivityGroup(state, parent as unknown as HTMLElement, doc as unknown as Document);

    const lineA = makeLine(doc as unknown as Document, "toolu_a", "Read");
    registerToolUseLine(state, "toolu_a", lineA);

    expect(findToolLine(state, "toolu_a")).toBe(lineA);
    expect(findToolLine(state, "toolu_unknown")).toBeNull();
  });

  it("setLinePending(false) clears the running indicator from the header", () => {
    const { doc, parent } = setupDom();
    const state = createActivityGroupState();
    ensureActivityGroup(state, parent as unknown as HTMLElement, doc as unknown as Document);

    const lineA = makeLine(doc as unknown as Document, "toolu_a", "Read");
    registerToolUseLine(state, "toolu_a", lineA);
    setLinePending(state, "toolu_a", false);

    const group = parent.children[0] as HTMLElement;
    expect(group.getAttribute("data-pending")).toBe("false");
    expect(lineA.getAttribute("data-pending")).toBe("false");
  });

  it("setLineError(true) marks the line but does NOT auto-open the group container", () => {
    // 2026-05-01 dogfood pass 2: auto-opening the group on error defeats
    // the compaction. Errors stay visible via a header chip + the line's
    // own auto-opened details once the user clicks to expand.
    const { doc, parent } = setupDom();
    const state = createActivityGroupState();
    ensureActivityGroup(state, parent as unknown as HTMLElement, doc as unknown as Document);

    const lineA = makeLine(doc as unknown as Document, "toolu_a", "Read");
    registerToolUseLine(state, "toolu_a", lineA);
    setLineError(state, "toolu_a", true);

    const group = parent.children[0] as HTMLElement;
    const details = group.querySelector("details.claude-wv-activity-group-details") as HTMLDetailsElement | null;
    expect(details?.open).toBe(false);
    expect(lineA.getAttribute("data-is-error")).toBe("true");
  });

  it("header surfaces an error chip with the running error count", () => {
    const { doc, parent } = setupDom();
    const state = createActivityGroupState();
    ensureActivityGroup(state, parent as unknown as HTMLElement, doc as unknown as Document);

    const lineA = makeLine(doc as unknown as Document, "toolu_a", "Read");
    const lineB = makeLine(doc as unknown as Document, "toolu_b", "Bash");
    const lineC = makeLine(doc as unknown as Document, "toolu_c", "Grep");
    registerToolUseLine(state, "toolu_a", lineA);
    registerToolUseLine(state, "toolu_b", lineB);
    registerToolUseLine(state, "toolu_c", lineC);

    setLineError(state, "toolu_a", true);
    setLineError(state, "toolu_b", true);

    const group = parent.children[0] as HTMLElement;
    const chip = group.querySelector(".claude-wv-activity-group-error-chip");
    expect(chip).not.toBeNull();
    expect((chip?.textContent ?? "").trim()).toContain("2");

    // Single error → singular noun
    setLineError(state, "toolu_a", false);
    const chipAfter = group.querySelector(".claude-wv-activity-group-error-chip");
    expect((chipAfter?.textContent ?? "").trim()).toContain("1");

    // Zero errors → chip disappears
    setLineError(state, "toolu_b", false);
    expect(group.querySelector(".claude-wv-activity-group-error-chip")).toBeNull();
  });

  it("setLinePending / setLineError on unknown tool_use_id is a no-op (no throw)", () => {
    const { doc, parent } = setupDom();
    const state = createActivityGroupState();
    ensureActivityGroup(state, parent as unknown as HTMLElement, doc as unknown as Document);

    expect(() => setLinePending(state, "missing", false)).not.toThrow();
    expect(() => setLineError(state, "missing", true)).not.toThrow();
  });

  it("after close, registerToolUseLine without ensure is a no-op (no throw, no side effects)", () => {
    const { doc, parent } = setupDom();
    const state = createActivityGroupState();
    ensureActivityGroup(state, parent as unknown as HTMLElement, doc as unknown as Document);
    closeActivityGroup(state);

    const orphanLine = makeLine(doc as unknown as Document, "toolu_orphan", "Read");
    expect(() => registerToolUseLine(state, "toolu_orphan", orphanLine)).not.toThrow();

    // Still only the closed (now-inert) group from before; no new content added inside it.
    expect(parent.children.length).toBe(1);
    const group = parent.children[0] as HTMLElement;
    const body = group.querySelector(".claude-wv-activity-group-body");
    expect(body?.children.length ?? 0).toBe(0);
  });
});
