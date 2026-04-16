import { describe, it, expect } from "vitest";
import { Window } from "happy-dom";
import path from "node:path";
import { replayFixture } from "./helpers/fixture-replay";
import {
  createEditDiffState,
  renderEditDiff,
} from "../../src/webview/renderers/edit-diff";
import type {
  AssistantEvent,
  ToolUseBlock,
} from "../../src/webview/parser/types";

const EDIT_FIXTURE = path.resolve(
  __dirname,
  "..",
  "fixtures",
  "stream-json",
  "edit.jsonl",
);

function toolUseEvent(
  msgId: string,
  toolId: string,
  name: string,
  input: Record<string, unknown>,
): AssistantEvent {
  return {
    type: "assistant",
    message: {
      id: msgId,
      type: "message",
      role: "assistant",
      content: [{ type: "tool_use", id: toolId, name, input }],
    },
    session_id: "test",
    uuid: "u-" + toolId,
  };
}

describe("render-edit-diff (SH-02)", () => {
  it("renders a diff card for an Edit tool_use with file_path + added + removed lines", () => {
    const { document: doc } = new Window();
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);

    const state = createEditDiffState();
    const ev = toolUseEvent("msg_1", "toolu_edit_1", "Edit", {
      file_path: "/tmp/hello.md",
      old_string: "Hello from spike\n",
      new_string: "Hello from spike\nedited by claude\n",
    });
    const cards = renderEditDiff(
      state,
      parent as unknown as HTMLElement,
      ev,
      doc as unknown as Document,
    );

    expect(cards.length).toBe(1);
    const card = cards[0];
    expect(card.classList.contains("claude-wv-card")).toBe(true);
    expect(card.classList.contains("claude-wv-card--edit-diff")).toBe(true);
    expect(card.getAttribute("data-tool-use-id")).toBe("toolu_edit_1");

    const pathEl = card.querySelector(".claude-wv-edit-diff-path");
    expect(pathEl).not.toBeNull();
    expect((pathEl?.textContent ?? "").trim()).toContain("/tmp/hello.md");

    const added = card.querySelectorAll(".claude-wv-diff-add");
    const removed = card.querySelectorAll(".claude-wv-diff-remove");
    expect(added.length).toBeGreaterThanOrEqual(1);
    expect(removed.length).toBeGreaterThanOrEqual(1);
    expect(parent.children.length).toBe(1);
  });

  it("renders a diff card for a Write tool_use (full-file create) with added lines only", () => {
    const { document: doc } = new Window();
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);

    const state = createEditDiffState();
    const ev = toolUseEvent("msg_write", "toolu_write_1", "Write", {
      file_path: "/tmp/new.md",
      content: "line one\nline two\nline three\n",
    });
    const cards = renderEditDiff(
      state,
      parent as unknown as HTMLElement,
      ev,
      doc as unknown as Document,
    );

    expect(cards.length).toBe(1);
    const card = cards[0];
    expect(card.getAttribute("data-tool-name")).toBe("Write");
    const added = card.querySelectorAll(".claude-wv-diff-add");
    expect(added.length).toBeGreaterThanOrEqual(3);
    const removed = card.querySelectorAll(".claude-wv-diff-remove");
    expect(removed.length).toBe(0);
  });

  it("does not render a card for non-Edit/Write tool_use blocks (Bash, Read, Grep)", () => {
    const { document: doc } = new Window();
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);

    const state = createEditDiffState();
    for (const name of ["Bash", "Read", "Grep"]) {
      const ev = toolUseEvent("m-" + name, "toolu-" + name, name, {
        command: "echo " + name,
      });
      const cards = renderEditDiff(
        state,
        parent as unknown as HTMLElement,
        ev,
        doc as unknown as Document,
      );
      expect(cards.length).toBe(0);
    }
    expect(parent.children.length).toBe(0);
  });

  it("upserts a diff card when the same tool_use.id is re-emitted (partial → final)", () => {
    const { document: doc } = new Window();
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);

    const state = createEditDiffState();
    const base = {
      file_path: "/tmp/up.md",
      old_string: "A\n",
      new_string: "A\nB\n",
    };
    renderEditDiff(
      state,
      parent as unknown as HTMLElement,
      toolUseEvent("m1", "toolu_up", "Edit", base),
      doc as unknown as Document,
    );
    // Partial re-emit with updated new_string
    const updated = {
      file_path: "/tmp/up.md",
      old_string: "A\n",
      new_string: "A\nB\nC\n",
    };
    const cards = renderEditDiff(
      state,
      parent as unknown as HTMLElement,
      toolUseEvent("m2", "toolu_up", "Edit", updated),
      doc as unknown as Document,
    );

    expect(cards.length).toBe(1);
    expect(state.cards.size).toBe(1);
    expect(parent.children.length).toBe(1);

    const card = state.cards.get("toolu_up");
    const added = card?.querySelectorAll(".claude-wv-diff-add") ?? [];
    expect(added.length).toBeGreaterThanOrEqual(2);
    const addedText = Array.from(added).map((el) => el.textContent ?? "").join("\n");
    expect(addedText).toContain("C");
  });

  it("does not use dangerous DOM APIs (no innerHTML/appendChild on produced nodes)", () => {
    // Negative anchor: ensures the implementation uses textContent / replaceChildren
    // only. The Phase 2 grep gate (2-5 / 4a-5) enforces this statically too,
    // but this runtime check catches accidental regressions before grep runs.
    const { document: doc } = new Window();
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);

    const state = createEditDiffState();
    const ev = toolUseEvent("m_xss", "toolu_xss", "Edit", {
      file_path: "/tmp/xss.md",
      old_string: "<script>alert(1)</script>",
      new_string: "<img src=x onerror=alert(2)>",
    });
    renderEditDiff(
      state,
      parent as unknown as HTMLElement,
      ev,
      doc as unknown as Document,
    );

    // script/img should appear as literal text, not parsed HTML elements.
    const card = state.cards.get("toolu_xss");
    expect(card).not.toBeUndefined();
    expect(card?.querySelector("script")).toBeNull();
    expect(card?.querySelector("img")).toBeNull();
    const text = card?.textContent ?? "";
    expect(text).toContain("<script>");
    expect(text).toContain("onerror");
  });

  it("integrates with the real edit.jsonl fixture: finds an Edit tool_use and renders diff", () => {
    const { events } = replayFixture(EDIT_FIXTURE);
    // Find the first Edit/Write tool_use block in the fixture
    let found: { ev: AssistantEvent; block: ToolUseBlock } | null = null;
    for (const ev of events) {
      if (ev.type !== "assistant") continue;
      for (const block of ev.message.content) {
        if (
          block.type === "tool_use" &&
          (block.name === "Edit" || block.name === "Write")
        ) {
          found = { ev, block };
          break;
        }
      }
      if (found) break;
    }
    expect(found).not.toBeNull();

    const { document: doc } = new Window();
    const parent = doc.createElement("div");
    doc.body.appendChild(parent);
    const state = createEditDiffState();

    const cards = renderEditDiff(
      state,
      parent as unknown as HTMLElement,
      found!.ev,
      doc as unknown as Document,
    );
    expect(cards.length).toBe(1);
    const card = cards[0];
    expect(card.querySelectorAll(".claude-wv-diff-add").length).toBeGreaterThanOrEqual(1);
    expect(card.querySelectorAll(".claude-wv-diff-remove").length).toBeGreaterThanOrEqual(1);
    const pathText = card.querySelector(".claude-wv-edit-diff-path")?.textContent ?? "";
    const filePath = (found!.block.input as { file_path?: string }).file_path ?? "";
    expect(pathText).toContain(filePath);
  });
});
