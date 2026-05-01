/**
 * Phase 3 — slash command menu (slash-menu.ts) unit tests.
 *
 * Tests cover the pure helpers:
 *   - shouldTriggerSlash
 *   - handleSlashKey
 *   - mergeSlashCommands
 *
 * SlashCommandModal is NOT tested here (requires Obsidian DOM + App).
 * All tests use happy-dom Window for DOM elements and a fake openModal.
 */
import { describe, it, expect, vi } from "vitest";
import { Window } from "happy-dom";
import {
  shouldTriggerSlash,
  handleSlashKey,
  mergeSlashCommands,
  type SlashCommand,
  type SlashMenuDeps,
} from "../../src/webview/ui/slash-menu";

function makeWindow(): Window {
  return new Window();
}

function makeTextarea(
  win: Window,
  value = ""
): HTMLTextAreaElement {
  const doc = win.document;
  const el = doc.createElement("textarea");
  el.value = value;
  doc.body.appendChild(el);
  return el as unknown as HTMLTextAreaElement;
}

function makeKeyboardEvent(
  win: Window,
  init: {
    key: string;
    isComposing?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
  }
): KeyboardEvent {
  const KeyboardEventCtor = (win as unknown as { KeyboardEvent: typeof KeyboardEvent })
    .KeyboardEvent;
  return new KeyboardEventCtor("keydown", {
    key: init.key,
    bubbles: true,
    cancelable: true,
    composed: init.isComposing ?? false,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
  }) as unknown as KeyboardEvent;
}

// ---------------------------------------------------------------------------
// shouldTriggerSlash
// ---------------------------------------------------------------------------

describe("shouldTriggerSlash", () => {
  it("returns true for '/' at empty textarea (no modifiers)", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "");
    const e = makeKeyboardEvent(win, { key: "/" });
    expect(shouldTriggerSlash(ta, e)).toBe(true);
  });

  it("returns false for '/' at non-empty textarea", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "hello");
    const e = makeKeyboardEvent(win, { key: "/" });
    expect(shouldTriggerSlash(ta, e)).toBe(false);
  });

  it("returns false for '/' at textarea with whitespace only (non-empty)", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, " ");
    const e = makeKeyboardEvent(win, { key: "/" });
    expect(shouldTriggerSlash(ta, e)).toBe(false);
  });

  it("returns false during IME composition (isComposing=true)", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "");
    // Create event that simulates composing state
    const KeyboardEventCtor = (win as unknown as { KeyboardEvent: typeof KeyboardEvent })
      .KeyboardEvent;
    const e = new KeyboardEventCtor("keydown", {
      key: "/",
      bubbles: true,
      cancelable: true,
      isComposing: true,
    }) as unknown as KeyboardEvent;
    expect(shouldTriggerSlash(ta, e)).toBe(false);
  });

  it("returns false with metaKey (Cmd+/)", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "");
    const e = makeKeyboardEvent(win, { key: "/", metaKey: true });
    expect(shouldTriggerSlash(ta, e)).toBe(false);
  });

  it("returns false with ctrlKey (Ctrl+/)", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "");
    const e = makeKeyboardEvent(win, { key: "/", ctrlKey: true });
    expect(shouldTriggerSlash(ta, e)).toBe(false);
  });

  it("returns false with altKey (Alt+/)", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "");
    const e = makeKeyboardEvent(win, { key: "/", altKey: true });
    expect(shouldTriggerSlash(ta, e)).toBe(false);
  });

  it("returns false for non-slash keys at empty textarea", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "");
    const e = makeKeyboardEvent(win, { key: "a" });
    expect(shouldTriggerSlash(ta, e)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleSlashKey
// ---------------------------------------------------------------------------

describe("handleSlashKey", () => {
  it("calls openModal with source.list() result and preventDefault on trigger", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "");
    const e = makeKeyboardEvent(win, { key: "/" });
    // Spy on preventDefault
    let preventDefaultCalled = false;
    Object.defineProperty(e, "preventDefault", {
      value: () => { preventDefaultCalled = true; },
    });

    const commands: SlashCommand[] = [
      { name: "compact", source: "cli" },
      { name: "clear", source: "cli" },
    ];

    let capturedItems: readonly SlashCommand[] | null = null;
    const openModal = vi.fn((items, _onSelect, _onDismiss) => {
      capturedItems = items;
    });

    const deps: SlashMenuDeps = {
      textarea: ta,
      source: { list: () => commands },
      openModal,
    };

    const intercepted = handleSlashKey(deps, e);

    expect(intercepted).toBe(true);
    expect(preventDefaultCalled).toBe(true);
    expect(openModal).toHaveBeenCalledOnce();
    expect(capturedItems).toEqual(commands);
  });

  it("returns false and does NOT call openModal when key is not '/'", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "");
    const e = makeKeyboardEvent(win, { key: "a" });

    const openModal = vi.fn();
    const deps: SlashMenuDeps = {
      textarea: ta,
      source: { list: () => [] },
      openModal,
    };

    const intercepted = handleSlashKey(deps, e);
    expect(intercepted).toBe(false);
    expect(openModal).not.toHaveBeenCalled();
  });

  it("onSelect callback writes '/<name> ' to textarea and dispatches input event", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "");
    const e = makeKeyboardEvent(win, { key: "/" });
    Object.defineProperty(e, "preventDefault", { value: () => {} });

    const cmd: SlashCommand = { name: "compact", source: "cli" };
    let capturedOnSelect: ((cmd: SlashCommand) => void) | null = null;
    const openModal = vi.fn((_items, onSelect, _onDismiss) => {
      capturedOnSelect = onSelect;
    });

    const inputEvents: string[] = [];
    ta.addEventListener("input", () => {
      inputEvents.push(ta.value);
    });

    const deps: SlashMenuDeps = {
      textarea: ta,
      source: { list: () => [cmd] },
      openModal,
    };

    handleSlashKey(deps, e);
    expect(capturedOnSelect).not.toBeNull();

    capturedOnSelect!(cmd);

    expect(ta.value).toBe("/compact ");
    expect(inputEvents).toHaveLength(1);
    expect(inputEvents[0]).toBe("/compact ");
  });

  it("onDismiss callback writes '/' to textarea and dispatches input event", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "");
    const e = makeKeyboardEvent(win, { key: "/" });
    Object.defineProperty(e, "preventDefault", { value: () => {} });

    let capturedOnDismiss: (() => void) | null = null;
    let selectCalled = false;
    const openModal = vi.fn((_items, _onSelect, onDismiss) => {
      capturedOnDismiss = onDismiss;
    });

    const inputEvents: string[] = [];
    ta.addEventListener("input", () => {
      inputEvents.push(ta.value);
    });

    const deps: SlashMenuDeps = {
      textarea: ta,
      source: { list: () => [] },
      openModal,
    };

    handleSlashKey(deps, e);
    expect(capturedOnDismiss).not.toBeNull();

    // Simulate that user dismissed without selecting
    capturedOnDismiss!();

    expect(ta.value).toBe("/");
    expect(inputEvents).toHaveLength(1);
    expect(selectCalled).toBe(false);
  });

  it("does not intercept when non-trigger conditions (non-empty textarea)", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "some text");
    const e = makeKeyboardEvent(win, { key: "/" });

    const openModal = vi.fn();
    const deps: SlashMenuDeps = {
      textarea: ta,
      source: { list: () => [] },
      openModal,
    };

    const intercepted = handleSlashKey(deps, e);
    expect(intercepted).toBe(false);
    expect(openModal).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// mergeSlashCommands
// ---------------------------------------------------------------------------

describe("mergeSlashCommands", () => {
  it("pure CLI list → all source:'cli', sorted alphabetically", () => {
    const result = mergeSlashCommands(["compact", "clear", "mcp"], []);
    expect(result).toEqual([
      { name: "clear", source: "cli" },
      { name: "compact", source: "cli" },
      { name: "mcp", source: "cli" },
    ]);
  });

  it("pure user list → preserved with source:'user'", () => {
    const userCmds: SlashCommand[] = [
      { name: "my-cmd", source: "user", description: "My custom command" },
      { name: "another", source: "user", description: "Another one" },
    ];
    const result = mergeSlashCommands([], userCmds);
    expect(result).toEqual([
      { name: "another", source: "user", description: "Another one" },
      { name: "my-cmd", source: "user", description: "My custom command" },
    ]);
  });

  it("name conflict → CLI wins, single entry result", () => {
    const userCmds: SlashCommand[] = [
      { name: "compact", source: "user", description: "User compact override" },
    ];
    const result = mergeSlashCommands(["compact", "clear"], userCmds);
    const compactEntries = result.filter((c) => c.name === "compact");
    expect(compactEntries).toHaveLength(1);
    expect(compactEntries[0].source).toBe("cli");
  });

  it("empty inputs → empty output", () => {
    expect(mergeSlashCommands([], [])).toEqual([]);
  });

  it("mixed CLI and user commands are sorted alphabetically by name", () => {
    const userCmds: SlashCommand[] = [
      { name: "zebra", source: "user" },
      { name: "alpha", source: "user" },
    ];
    const result = mergeSlashCommands(["mcp", "clear"], userCmds);
    const names = result.map((c) => c.name);
    expect(names).toEqual([...names].sort());
  });

  it("CLI list deduplication — duplicate CLI names produce single entry", () => {
    const result = mergeSlashCommands(["compact", "compact", "clear"], []);
    const compactEntries = result.filter((c) => c.name === "compact");
    expect(compactEntries).toHaveLength(1);
  });

  it("CLI command description is undefined by default", () => {
    const result = mergeSlashCommands(["compact"], []);
    expect(result[0].description).toBeUndefined();
  });

  it("user command description is preserved", () => {
    const userCmds: SlashCommand[] = [
      { name: "my-cmd", source: "user", description: "First non-empty line" },
    ];
    const result = mergeSlashCommands([], userCmds);
    expect(result[0].description).toBe("First non-empty line");
  });
});
