/**
 * @ mention trigger tests — driver + helpers.
 *
 * The driver is hooked to the textarea's `input` event. It opens a popover
 * on a fresh `@`, updates the popover as the user types the query, and
 * tears down on Esc / Escape / token deletion / item selection.
 */
import { describe, it, expect, vi } from "vitest";
import { Window } from "happy-dom";
import {
  findActiveAtToken,
  isFreshAtTrigger,
  replaceAtToken,
  createAtMentionDriver,
} from "../../src/webview/ui/at-mention-trigger";
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
  let disposed = false;
  const updates: PopoverItem[][] = [];
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

// ─── findActiveAtToken ────────────────────────────────────────────────────────

describe("findActiveAtToken", () => {
  it("returns null on empty textarea", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "");
    expect(findActiveAtToken(ta)).toBeNull();
  });

  it("finds @ at start of textarea", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "@");
    ta.selectionStart = 1;
    expect(findActiveAtToken(ta)).toEqual({ atPos: 0, query: "" });
  });

  it("finds @ with running query", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "@notes/foo");
    ta.selectionStart = 10;
    expect(findActiveAtToken(ta)).toEqual({ atPos: 0, query: "notes/foo" });
  });

  it("finds @ after whitespace", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "hello @bar");
    ta.selectionStart = 10;
    expect(findActiveAtToken(ta)).toEqual({ atPos: 6, query: "bar" });
  });

  it("returns null when cursor is past whitespace following @", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "@foo bar");
    ta.selectionStart = 8;
    expect(findActiveAtToken(ta)).toBeNull();
  });

  it("returns null when token does not start with @", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "hello world");
    ta.selectionStart = 11;
    expect(findActiveAtToken(ta)).toBeNull();
  });
});

// ─── isFreshAtTrigger ─────────────────────────────────────────────────────────

describe("isFreshAtTrigger", () => {
  it("true for @ just typed at start of empty textarea", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "@");
    ta.selectionStart = 1;
    expect(isFreshAtTrigger(ta, makeInputEvent(win, { data: "@", inputType: "insertText" }))).toBe(true);
  });

  it("false during IME composition", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "@");
    ta.selectionStart = 1;
    expect(
      isFreshAtTrigger(ta, makeInputEvent(win, { data: "@", inputType: "insertText", isComposing: true })),
    ).toBe(false);
  });

  it("false on paste (inputType insertFromPaste)", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "@");
    ta.selectionStart = 1;
    expect(
      isFreshAtTrigger(ta, makeInputEvent(win, { data: "@", inputType: "insertFromPaste" })),
    ).toBe(false);
  });

  it("false mid-word (preceded by letter)", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "foo@");
    ta.selectionStart = 4;
    expect(isFreshAtTrigger(ta, makeInputEvent(win, { data: "@", inputType: "insertText" }))).toBe(false);
  });
});

// ─── replaceAtToken ───────────────────────────────────────────────────────────

describe("replaceAtToken", () => {
  it("replaces @ at start with @<path>", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "@");
    ta.selectionStart = 1;
    replaceAtToken(ta, 0, "@notes/foo.md ");
    expect(ta.value).toBe("@notes/foo.md ");
    expect(ta.selectionStart).toBe("@notes/foo.md ".length);
  });

  it("replaces @we (typed query) cleanly with full path", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "@we");
    ta.selectionStart = 3;
    replaceAtToken(ta, 0, "@weekly-review.md ");
    expect(ta.value).toBe("@weekly-review.md ");
    expect(ta.value).not.toContain("@@");
  });

  it("preserves text after the cursor", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "hello @ tail");
    ta.selectionStart = 7;
    replaceAtToken(ta, 6, "@x.md ");
    expect(ta.value).toBe("hello @x.md  tail");
  });
});

// ─── createAtMentionDriver ────────────────────────────────────────────────────

describe("createAtMentionDriver", () => {
  it("opens popover on fresh @ at start of empty textarea", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "@");
    ta.selectionStart = 1;

    const handle = fakePopoverHandle();
    const openPopover = vi.fn().mockReturnValue(handle);
    const searchFiles = vi.fn().mockReturnValue([
      { id: "a.md", label: "a", metadata: "a.md" },
    ] satisfies PopoverItem[]);

    const driver = createAtMentionDriver({
      textarea: ta,
      searchFiles,
      openPopover,
    });
    driver.onInput(makeInputEvent(win, { data: "@", inputType: "insertText" }));

    expect(openPopover).toHaveBeenCalledOnce();
    expect(searchFiles).toHaveBeenCalledWith("");
  });

  it("does NOT open popover mid-word", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "foo@");
    ta.selectionStart = 4;

    const openPopover = vi.fn();
    const driver = createAtMentionDriver({
      textarea: ta,
      searchFiles: () => [],
      openPopover: openPopover as never,
    });
    driver.onInput(makeInputEvent(win, { data: "@", inputType: "insertText" }));

    expect(openPopover).not.toHaveBeenCalled();
  });

  it("updates popover items as user types after the @", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "@");
    ta.selectionStart = 1;

    const handle = fakePopoverHandle() as InlinePopoverHandle & {
      updates: PopoverItem[][];
      disposed: boolean;
    };
    const searchFiles = vi.fn((q: string): PopoverItem[] => [
      { id: q || "*", label: q || "*", metadata: q },
    ]);

    const driver = createAtMentionDriver({
      textarea: ta,
      searchFiles,
      openPopover: vi.fn().mockReturnValue(handle),
    });
    driver.onInput(makeInputEvent(win, { data: "@", inputType: "insertText" }));

    // User types "no" after @
    ta.value = "@no";
    ta.selectionStart = 3;
    driver.onInput(makeInputEvent(win, { data: "n", inputType: "insertText" }));
    driver.onInput(makeInputEvent(win, { data: "o", inputType: "insertText" }));

    expect(searchFiles).toHaveBeenCalledWith("no");
    expect(handle.updates.length).toBeGreaterThan(0);
  });

  it("on select: replaces typed @<query> with @<path> and disposes popover", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "@no");
    ta.selectionStart = 3;

    const handle = fakePopoverHandle() as InlinePopoverHandle & {
      disposed: boolean;
    };
    let capturedSelect: ((item: PopoverItem) => void) | null = null;
    const openPopover = vi.fn((items, onSelect) => {
      capturedSelect = onSelect;
      return handle;
    });

    const driver = createAtMentionDriver({
      textarea: ta,
      searchFiles: (q): PopoverItem[] => [
        { id: "notes/foo.md", label: "foo", metadata: "notes/foo.md" },
      ],
      openPopover: openPopover as never,
    });

    // Simulate the @ being freshly typed (cursor at 1 → grew to 3 with 'n', 'o')
    ta.value = "@";
    ta.selectionStart = 1;
    driver.onInput(makeInputEvent(win, { data: "@", inputType: "insertText" }));

    ta.value = "@no";
    ta.selectionStart = 3;
    driver.onInput(makeInputEvent(win, { data: "o", inputType: "insertText" }));

    capturedSelect!({ id: "notes/foo.md", label: "foo", metadata: "notes/foo.md" });
    expect(ta.value).toBe("@notes/foo.md ");
    expect(ta.value).not.toContain("@@");
    expect(handle.disposed).toBe(true);
  });

  it("dismisses popover when user deletes the @", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "@");
    ta.selectionStart = 1;

    const handle = fakePopoverHandle() as InlinePopoverHandle & {
      disposed: boolean;
    };
    const driver = createAtMentionDriver({
      textarea: ta,
      searchFiles: () => [],
      openPopover: vi.fn().mockReturnValue(handle),
    });
    driver.onInput(makeInputEvent(win, { data: "@", inputType: "insertText" }));

    // User backspaces — textarea is empty.
    ta.value = "";
    ta.selectionStart = 0;
    driver.onInput(makeInputEvent(win, { inputType: "deleteContentBackward" }));

    expect(handle.disposed).toBe(true);
  });

  it("driver.dispose tears down active popover", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "@");
    ta.selectionStart = 1;

    const handle = fakePopoverHandle() as InlinePopoverHandle & {
      disposed: boolean;
    };
    const driver = createAtMentionDriver({
      textarea: ta,
      searchFiles: () => [],
      openPopover: vi.fn().mockReturnValue(handle),
    });
    driver.onInput(makeInputEvent(win, { data: "@", inputType: "insertText" }));

    driver.dispose();
    expect(handle.disposed).toBe(true);
  });
});
