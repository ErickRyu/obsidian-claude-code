/**
 * Slash menu tests — driver + helpers.
 */
import { describe, it, expect, vi } from "vitest";
import { Window } from "happy-dom";
import {
  mergeSlashCommands,
  isFreshSlashTrigger,
  findActiveSlashToken,
  applySlashCommand,
  createSlashMenuDriver,
  type SlashCommand,
} from "../../src/webview/ui/slash-menu";
import type { InlinePopoverHandle, PopoverItem } from "../../src/webview/ui/inline-popover";

function makeWindow(): Window {
  return new Window();
}

function makeTextarea(win: Window, value = ""): HTMLTextAreaElement {
  const doc = win.document;
  const ta = doc.createElement("textarea") as unknown as HTMLTextAreaElement;
  ta.value = value;
  doc.body.appendChild(ta);
  return ta;
}

function makeInputEvent(
  win: Window,
  fields: { data?: string; inputType?: string; isComposing?: boolean } = {},
): Event {
  const EventCtor = (win as unknown as { Event: typeof Event }).Event;
  const e = new EventCtor("input", { bubbles: true });
  if (fields.data !== undefined) {
    Object.defineProperty(e, "data", { value: fields.data, configurable: true });
  }
  if (fields.inputType !== undefined) {
    Object.defineProperty(e, "inputType", { value: fields.inputType, configurable: true });
  }
  if (fields.isComposing !== undefined) {
    Object.defineProperty(e, "isComposing", { value: fields.isComposing, configurable: true });
  }
  return e;
}

function fakePopoverHandle(): InlinePopoverHandle & {
  updates: PopoverItem[][];
  disposed: boolean;
} {
  const updates: PopoverItem[][] = [];
  let disposed = false;
  return {
    update(items) {
      updates.push([...items]);
    },
    dispose() {
      disposed = true;
    },
    isOpen() {
      return !disposed;
    },
    get updates() {
      return updates;
    },
    get disposed() {
      return disposed;
    },
  } as unknown as InlinePopoverHandle & { updates: PopoverItem[][]; disposed: boolean };
}

// ─── mergeSlashCommands ───────────────────────────────────────────────────────

describe("mergeSlashCommands", () => {
  it("returns CLI builtins as source: cli, sorted alphabetically", () => {
    const out = mergeSlashCommands(["compact", "clear", "mcp"], [], []);
    expect(out.map((c) => c.name)).toEqual(["clear", "compact", "mcp"]);
    expect(out.every((c) => c.source === "cli")).toBe(true);
  });

  it("merges all three sources", () => {
    const user: SlashCommand[] = [{ name: "review", source: "user" }];
    const global: SlashCommand[] = [{ name: "weekly-review", source: "global" }];
    const out = mergeSlashCommands(["clear"], user, global);
    expect(out.map((c) => c.name).sort()).toEqual(["clear", "review", "weekly-review"]);
  });

  it("dedupes by name with cli > user > global precedence", () => {
    const user: SlashCommand[] = [{ name: "compact", source: "user", description: "user desc" }];
    const global: SlashCommand[] = [{ name: "compact", source: "global", description: "global desc" }];
    const out = mergeSlashCommands(["compact"], user, global);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("cli");
  });

  it("returns empty list when all sources are empty", () => {
    expect(mergeSlashCommands([], [], [])).toEqual([]);
  });
});

// ─── isFreshSlashTrigger ──────────────────────────────────────────────────────

describe("isFreshSlashTrigger", () => {
  it("true for / typed into empty textarea", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "/");
    expect(isFreshSlashTrigger(ta, makeInputEvent(win, { data: "/", inputType: "insertText" }))).toBe(true);
  });

  it("false when textarea has more than just /", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "/c");
    expect(isFreshSlashTrigger(ta, makeInputEvent(win, { data: "c", inputType: "insertText" }))).toBe(false);
  });

  it("false during IME composition", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "/");
    expect(
      isFreshSlashTrigger(ta, makeInputEvent(win, { data: "/", inputType: "insertText", isComposing: true })),
    ).toBe(false);
  });

  it("false on paste", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "/");
    expect(
      isFreshSlashTrigger(ta, makeInputEvent(win, { data: "/", inputType: "insertFromPaste" })),
    ).toBe(false);
  });
});

// ─── findActiveSlashToken ─────────────────────────────────────────────────────

describe("findActiveSlashToken", () => {
  it("returns query for /<chars>", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "/we");
    ta.selectionStart = 3;
    expect(findActiveSlashToken(ta)).toEqual({ query: "we" });
  });

  it("returns null once user types whitespace (now in args)", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "/foo bar");
    ta.selectionStart = 8;
    expect(findActiveSlashToken(ta)).toBeNull();
  });

  it("returns null when value does not start with /", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "hello");
    expect(findActiveSlashToken(ta)).toBeNull();
  });
});

// ─── applySlashCommand ────────────────────────────────────────────────────────

describe("applySlashCommand", () => {
  it("replaces textarea contents with /<name> ", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "/we");
    applySlashCommand(ta, "weekly-review");
    expect(ta.value).toBe("/weekly-review ");
    expect(ta.selectionStart).toBe("/weekly-review ".length);
  });
});

// ─── createSlashMenuDriver ────────────────────────────────────────────────────

describe("createSlashMenuDriver", () => {
  it("opens popover on fresh / in empty textarea", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "/");
    ta.selectionStart = 1;

    const handle = fakePopoverHandle();
    const openPopover = vi.fn().mockReturnValue(handle);
    const searchCommands = vi.fn().mockReturnValue([
      { id: "cli:clear", label: "/clear", metadata: "clear" },
    ] satisfies PopoverItem[]);

    const driver = createSlashMenuDriver({
      textarea: ta,
      searchCommands,
      openPopover,
    });
    driver.onInput(makeInputEvent(win, { data: "/", inputType: "insertText" }));

    expect(openPopover).toHaveBeenCalledOnce();
    expect(searchCommands).toHaveBeenCalledWith("");
  });

  it("does NOT open popover when / is mid-text", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "path/");
    ta.selectionStart = 5;

    const openPopover = vi.fn();
    const driver = createSlashMenuDriver({
      textarea: ta,
      searchCommands: () => [],
      openPopover: openPopover as never,
    });
    driver.onInput(makeInputEvent(win, { data: "/", inputType: "insertText" }));

    expect(openPopover).not.toHaveBeenCalled();
  });

  it("on select: rewrites textarea to /<name> and disposes popover", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "/");
    ta.selectionStart = 1;

    const handle = fakePopoverHandle() as InlinePopoverHandle & { disposed: boolean };
    let capturedSelect: ((item: PopoverItem) => void) | null = null;
    const openPopover = vi.fn((_items, onSelect) => {
      capturedSelect = onSelect;
      return handle;
    });

    const driver = createSlashMenuDriver({
      textarea: ta,
      searchCommands: () => [{ id: "cli:weekly", label: "/weekly", metadata: "weekly" }],
      openPopover: openPopover as never,
    });
    driver.onInput(makeInputEvent(win, { data: "/", inputType: "insertText" }));

    capturedSelect!({ id: "cli:weekly", label: "/weekly", metadata: "weekly" });
    expect(ta.value).toBe("/weekly ");
    expect(handle.disposed).toBe(true);
  });

  it("dismisses popover when user deletes the /", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "/");
    ta.selectionStart = 1;

    const handle = fakePopoverHandle() as InlinePopoverHandle & { disposed: boolean };
    const driver = createSlashMenuDriver({
      textarea: ta,
      searchCommands: () => [],
      openPopover: vi.fn().mockReturnValue(handle),
    });
    driver.onInput(makeInputEvent(win, { data: "/", inputType: "insertText" }));

    ta.value = "";
    ta.selectionStart = 0;
    driver.onInput(makeInputEvent(win, { inputType: "deleteContentBackward" }));

    expect(handle.disposed).toBe(true);
  });
});
