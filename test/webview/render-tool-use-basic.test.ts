import { describe, it, expect } from "vitest";
import { Window } from "happy-dom";
import {
  createAssistantToolUseState,
  renderAssistantToolUse,
} from "../../src/webview/renderers/assistant-tool-use";
import { createActivityGroupState } from "../../src/webview/renderers/activity-group";
import type { AssistantEvent } from "../../src/webview/parser/types";

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

function setup() {
  const window = new Window();
  const doc = window.document;
  const parent = doc.createElement("div");
  doc.body.appendChild(parent);
  const state = createAssistantToolUseState();
  const groupState = createActivityGroupState();
  return { doc, parent, state, groupState };
}

describe("render-tool-use-basic (SH-02 / activity-group line mode)", () => {
  it("renders a line with data-tool-name=\"Bash\" inside the activity group container", () => {
    const { doc, parent, state, groupState } = setup();

    const ev = toolUseEvent("msg_1", "toolu_bash_1", "Bash", {
      command: "ls -la",
      description: "list files",
    });
    const lines = renderAssistantToolUse(
      state,
      groupState,
      parent as unknown as HTMLElement,
      ev,
      doc as unknown as Document,
    );

    expect(lines.length).toBe(1);
    const line = lines[0];
    expect(line.getAttribute("data-tool-name")).toBe("Bash");
    expect(line.getAttribute("data-tool-use-id")).toBe("toolu_bash_1");
    expect(line.classList.contains("claude-wv-tool-line")).toBe(true);

    // The activity group container is created and the line is inside its body.
    const group = parent.querySelector(".claude-wv-card--activity-group") as HTMLElement | null;
    expect(group).not.toBeNull();
    const body = group!.querySelector(".claude-wv-activity-group-body") as HTMLElement | null;
    expect(body!.contains(line)).toBe(true);

    // Tool name is reflected in the line's summary
    const summaryText = line.querySelector("summary.claude-wv-tool-line-summary")?.textContent ?? "";
    expect(summaryText).toContain("Bash");
    expect(summaryText).toContain("ls -la");

    // Input preview pre is still present inside the collapsed details
    const preview = line.querySelector(".claude-wv-tool-use-input");
    expect(preview).not.toBeNull();
    const previewText = preview?.textContent ?? "";
    expect(previewText).toContain("ls -la");
    expect(previewText).toContain("list files");
  });

  it("renders one line per tool_use block; both share the same activity group", () => {
    const { doc, parent, state, groupState } = setup();

    const ev: AssistantEvent = {
      type: "assistant",
      message: {
        id: "msg_multi",
        type: "message",
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_a", name: "Read", input: { file_path: "/a.md" } },
          { type: "tool_use", id: "toolu_b", name: "Grep", input: { pattern: "foo" } },
        ],
      },
      session_id: "test",
      uuid: "u-multi",
    };

    const lines = renderAssistantToolUse(
      state,
      groupState,
      parent as unknown as HTMLElement,
      ev,
      doc as unknown as Document,
    );
    expect(lines.length).toBe(2);
    expect(lines[0].getAttribute("data-tool-name")).toBe("Read");
    expect(lines[1].getAttribute("data-tool-name")).toBe("Grep");
    expect(state.cards.size).toBe(2);

    // One activity group hosts both lines
    const groups = parent.querySelectorAll(".claude-wv-card--activity-group");
    expect(groups.length).toBe(1);
    const body = groups[0].querySelector(".claude-wv-activity-group-body") as HTMLElement;
    expect(body.children.length).toBe(2);
  });

  it("re-emitted tool_use with the same id upserts (no duplicate line)", () => {
    const { doc, parent, state, groupState } = setup();

    renderAssistantToolUse(
      state,
      groupState,
      parent as unknown as HTMLElement,
      toolUseEvent("m1", "toolu_x", "Bash", { command: "echo 1" }),
      doc as unknown as Document,
    );
    renderAssistantToolUse(
      state,
      groupState,
      parent as unknown as HTMLElement,
      toolUseEvent("m2", "toolu_x", "Bash", { command: "echo 2" }),
      doc as unknown as Document,
    );

    expect(state.cards.size).toBe(1);
    const groups = parent.querySelectorAll(".claude-wv-card--activity-group");
    expect(groups.length).toBe(1);
    const body = groups[0].querySelector(".claude-wv-activity-group-body") as HTMLElement;
    expect(body.children.length).toBe(1);
    const line = state.cards.get("toolu_x");
    const previewText = line?.querySelector(".claude-wv-tool-use-input")?.textContent ?? "";
    expect(previewText).toContain("echo 2");
    expect(previewText).not.toContain("echo 1");
  });

  it("events with no tool_use blocks return an empty array (no group created)", () => {
    const { doc, parent, state, groupState } = setup();

    const textOnly: AssistantEvent = {
      type: "assistant",
      message: {
        id: "msg_text",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "just text" }],
      },
      session_id: "test",
      uuid: "u-text",
    };
    const lines = renderAssistantToolUse(
      state,
      groupState,
      parent as unknown as HTMLElement,
      textOnly,
      doc as unknown as Document,
    );
    expect(lines.length).toBe(0);
    expect(state.cards.size).toBe(0);
    expect(parent.children.length).toBe(0);
  });

  it("each line wraps the input preview in a closed <details> with a one-line summary", () => {
    const { doc, parent, state, groupState } = setup();

    const ev = toolUseEvent("msg_collapse", "toolu_collapse", "Read", {
      file_path: "/Users/x/notes/weekly.md",
    });
    renderAssistantToolUse(
      state,
      groupState,
      parent as unknown as HTMLElement,
      ev,
      doc as unknown as Document,
    );

    const line = state.cards.get("toolu_collapse");
    expect(line).toBeDefined();
    const details = line?.querySelector("details.claude-wv-tool-line-details") as HTMLDetailsElement | null;
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);

    const summary = details?.querySelector("summary.claude-wv-tool-line-summary");
    expect(summary).not.toBeNull();
    const summaryText = summary?.textContent ?? "";
    expect(summaryText).toContain("Read");
    expect(summaryText).toContain("/Users/x/notes/weekly.md");

    const preview = details?.querySelector(".claude-wv-tool-use-input");
    expect(preview).not.toBeNull();
  });

  it("formats deeply-nested input JSON as a readable preview", () => {
    const { doc, parent, state, groupState } = setup();

    const ev = toolUseEvent("msg_nested", "toolu_nested", "Read", {
      file_path: "/tmp/x.md",
      offset: 10,
      limit: 50,
    });
    renderAssistantToolUse(
      state,
      groupState,
      parent as unknown as HTMLElement,
      ev,
      doc as unknown as Document,
    );

    const preview = state.cards
      .get("toolu_nested")
      ?.querySelector(".claude-wv-tool-use-input");
    const text = preview?.textContent ?? "";
    expect(text).toContain("file_path");
    expect(text).toContain("offset");
    expect(text).toContain("limit");
    expect(text).not.toContain("[object Object]");
  });

  it("starts a new line as pending until a tool_result resolves it", () => {
    const { doc, parent, state, groupState } = setup();

    const ev = toolUseEvent("msg_p", "toolu_pending", "Bash", { command: "sleep 1" });
    renderAssistantToolUse(
      state,
      groupState,
      parent as unknown as HTMLElement,
      ev,
      doc as unknown as Document,
    );

    const line = state.cards.get("toolu_pending");
    expect(line?.getAttribute("data-pending")).toBe("true");
  });
});
