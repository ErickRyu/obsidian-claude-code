import { describe, it, expect } from "vitest";
import { Window } from "happy-dom";
import {
  createUserToolResultState,
  renderUserToolResult,
} from "../../src/webview/renderers/user-tool-result";
import {
  createAssistantToolUseState,
  renderAssistantToolUse,
} from "../../src/webview/renderers/assistant-tool-use";
import { createActivityGroupState } from "../../src/webview/renderers/activity-group";
import type {
  AssistantEvent,
  UserEvent,
  ToolResultBlock,
} from "../../src/webview/parser/types";

function toolResultEvent(
  toolUseId: string,
  content: string | ToolResultBlock["content"],
  isError = false,
): UserEvent {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content,
          ...(isError ? { is_error: true } : {}),
        },
      ],
    },
    parent_tool_use_id: null,
    session_id: "test-session",
    uuid: "u-" + toolUseId,
  };
}

function toolUseEvent(
  toolId: string,
  name: string,
  input: Record<string, unknown> = {},
): AssistantEvent {
  return {
    type: "assistant",
    message: {
      id: "msg_" + toolId,
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
  const useState = createAssistantToolUseState();
  const resultState = createUserToolResultState();
  const groupState = createActivityGroupState();
  return { doc, parent, useState, resultState, groupState };
}

describe("render-user-tool-result (MH-04 / activity-group line mode)", () => {
  it("attaches result body into the matching tool-line of the active group", () => {
    const { doc, parent, useState, resultState, groupState } = setup();

    // Stage a tool_use line first (real flow: assistant emits tool_use, user
    // returns tool_result). Both share the activity group.
    renderAssistantToolUse(
      useState,
      groupState,
      parent as unknown as HTMLElement,
      toolUseEvent("toolu_01", "Read", { file_path: "/x" }),
      doc as unknown as Document,
    );
    const line = useState.cards.get("toolu_01");
    expect(line).toBeDefined();
    expect(line?.getAttribute("data-pending")).toBe("true");

    const updated = renderUserToolResult(
      resultState,
      groupState,
      parent as unknown as HTMLElement,
      toolResultEvent("toolu_01", "Hello from Read"),
      doc as unknown as Document,
    );

    expect(updated.length).toBe(1);
    expect(updated[0]).toBe(line); // the same line element is updated in place
    expect(line?.getAttribute("data-pending")).toBe("false");
    expect(line?.hasAttribute("data-is-error")).toBe(false);

    const body = line?.querySelector(".claude-wv-tool-result-body");
    expect(body).not.toBeNull();
    expect(body?.tagName.toLowerCase()).toBe("pre");
    expect(body?.textContent).toBe("Hello from Read");
  });

  it("marks the line with error state and surfaces a header chip; group stays collapsed", () => {
    // 2026-05-01 dogfood pass 2: errors no longer auto-open the group
    // container. The header gains an error chip so the failure is visible
    // while collapsed; the line's own <details> opens so the body is
    // immediately readable once the user expands the group.
    const { doc, parent, useState, resultState, groupState } = setup();

    renderAssistantToolUse(
      useState,
      groupState,
      parent as unknown as HTMLElement,
      toolUseEvent("toolu_err", "Bash", { command: "false" }),
      doc as unknown as Document,
    );
    renderUserToolResult(
      resultState,
      groupState,
      parent as unknown as HTMLElement,
      toolResultEvent("toolu_err", "permission denied", true),
      doc as unknown as Document,
    );

    const line = useState.cards.get("toolu_err");
    expect(line?.getAttribute("data-is-error")).toBe("true");
    // Group container does NOT auto-open on error
    const group = parent.querySelector(".claude-wv-card--activity-group") as HTMLElement | null;
    const details = group?.querySelector("details.claude-wv-activity-group-details") as HTMLDetailsElement | null;
    expect(details?.open).toBe(false);
    // But the header chip surfaces the failure count
    const chip = group?.querySelector(".claude-wv-activity-group-error-chip");
    expect(chip).not.toBeNull();
    // Line's own details auto-opens for error so expanding the group
    // immediately shows the failure body
    const lineDetails = line?.querySelector("details.claude-wv-tool-line-details") as HTMLDetailsElement | null;
    expect(lineDetails?.open).toBe(true);
  });

  it("renders array-form content with one <pre> per text block and placeholder for images", () => {
    const { doc, parent, useState, resultState, groupState } = setup();

    renderAssistantToolUse(
      useState,
      groupState,
      parent as unknown as HTMLElement,
      toolUseEvent("toolu_arr", "Read"),
      doc as unknown as Document,
    );

    const ev: UserEvent = {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_arr",
            content: [
              { type: "text", text: "part A" },
              { type: "image", source: { placeholder: true } },
              { type: "text", text: "part B" },
            ],
          },
        ],
      },
      parent_tool_use_id: null,
      session_id: "s",
      uuid: "u",
    };

    renderUserToolResult(
      resultState,
      groupState,
      parent as unknown as HTMLElement,
      ev,
      doc as unknown as Document,
    );
    const line = useState.cards.get("toolu_arr");
    const bodies = line!.querySelectorAll(".claude-wv-tool-result-body");
    expect(bodies.length).toBe(2);
    expect(bodies[0].textContent).toBe("part A");
    expect(bodies[1].textContent).toBe("part B");
    const images = line!.querySelectorAll(".claude-wv-tool-result-image");
    expect(images.length).toBe(1);
  });

  it("re-emission with the same tool_use_id replaces the result body", () => {
    const { doc, parent, useState, resultState, groupState } = setup();

    renderAssistantToolUse(
      useState,
      groupState,
      parent as unknown as HTMLElement,
      toolUseEvent("toolu_dup", "Read"),
      doc as unknown as Document,
    );
    renderUserToolResult(
      resultState,
      groupState,
      parent as unknown as HTMLElement,
      toolResultEvent("toolu_dup", "first"),
      doc as unknown as Document,
    );
    renderUserToolResult(
      resultState,
      groupState,
      parent as unknown as HTMLElement,
      toolResultEvent("toolu_dup", "second"),
      doc as unknown as Document,
    );

    const line = useState.cards.get("toolu_dup");
    const bodies = line!.querySelectorAll(".claude-wv-tool-result-body");
    expect(bodies.length).toBe(1);
    expect(bodies[0].textContent).toBe("second");
  });

  it("plain-string user turn (no tool_result blocks) returns [] and leaves parent untouched", () => {
    const { doc, parent, resultState, groupState } = setup();

    const ev: UserEvent = {
      type: "user",
      message: { role: "user", content: "plain user input" },
      parent_tool_use_id: null,
      session_id: "s",
      uuid: "u",
    };
    const updated = renderUserToolResult(
      resultState,
      groupState,
      parent as unknown as HTMLElement,
      ev,
      doc as unknown as Document,
    );
    expect(updated).toEqual([]);
    expect(parent.children.length).toBe(0);
  });

  it("suppresses TodoWrite tool_result when matching summary card is present", () => {
    const { doc, parent, resultState, groupState } = setup();

    const summaryCard = doc.createElement("div");
    summaryCard.classList.add("claude-wv-card", "claude-wv-card--todo-summary");
    summaryCard.setAttribute("data-tool-use-id", "toolu_todo_1");
    summaryCard.setAttribute("data-tool-name", "TodoWrite");
    parent.appendChild(summaryCard);

    const ev = toolResultEvent("toolu_todo_1", "Todos have been modified successfully");
    const updated = renderUserToolResult(
      resultState,
      groupState,
      parent as unknown as HTMLElement,
      ev,
      doc as unknown as Document,
    );

    expect(updated).toEqual([]);
    // No tool-line was created for this id; no fallback card either.
    expect(parent.querySelectorAll(".claude-wv-card--user-tool-result").length).toBe(0);
    expect(parent.querySelectorAll(".claude-wv-tool-line").length).toBe(0);
    expect(parent.children.length).toBe(1);
  });

  it("renders TodoWrite tool_result when it is an error (do not hide failures) — fallback card", () => {
    const { doc, parent, resultState, groupState } = setup();

    const summaryCard = doc.createElement("div");
    summaryCard.classList.add("claude-wv-card", "claude-wv-card--todo-summary");
    summaryCard.setAttribute("data-tool-use-id", "toolu_todo_err");
    parent.appendChild(summaryCard);

    const ev = toolResultEvent("toolu_todo_err", "todo write failed", true);
    const updated = renderUserToolResult(
      resultState,
      groupState,
      parent as unknown as HTMLElement,
      ev,
      doc as unknown as Document,
    );
    // No matching tool-line in the (empty) group → fallback card is rendered
    expect(updated.length).toBe(1);
    expect(updated[0].getAttribute("data-is-error")).toBe("true");
    expect(updated[0].classList.contains("claude-wv-card--user-tool-result")).toBe(true);
  });

  it("when no matching tool-line exists, falls back to a standalone result card", () => {
    const { doc, parent, resultState, groupState } = setup();

    // No prior tool_use — result arrives orphaned.
    const updated = renderUserToolResult(
      resultState,
      groupState,
      parent as unknown as HTMLElement,
      toolResultEvent("toolu_orphan", "ghost"),
      doc as unknown as Document,
    );
    expect(updated.length).toBe(1);
    expect(updated[0].classList.contains("claude-wv-card--user-tool-result")).toBe(true);
    expect(updated[0].getAttribute("data-tool-use-id")).toBe("toolu_orphan");
  });

  it("multiple tool_result blocks update their respective lines in place", () => {
    const { doc, parent, useState, resultState, groupState } = setup();

    renderAssistantToolUse(
      useState,
      groupState,
      parent as unknown as HTMLElement,
      {
        type: "assistant",
        message: {
          id: "msg_xy",
          type: "message",
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_x", name: "Read", input: {} },
            { type: "tool_use", id: "toolu_y", name: "Grep", input: {} },
          ],
        },
        session_id: "s",
        uuid: "u",
      },
      doc as unknown as Document,
    );

    const ev: UserEvent = {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_x", content: "x" },
          { type: "tool_result", tool_use_id: "toolu_y", content: "y" },
        ],
      },
      parent_tool_use_id: null,
      session_id: "s",
      uuid: "u",
    };
    const updated = renderUserToolResult(
      resultState,
      groupState,
      parent as unknown as HTMLElement,
      ev,
      doc as unknown as Document,
    );
    expect(updated.length).toBe(2);
    expect(updated[0]).toBe(useState.cards.get("toolu_x"));
    expect(updated[1]).toBe(useState.cards.get("toolu_y"));
  });
});
