/**
 * Tests for the @ mention trigger module.
 *
 * Trigger fires on the textarea's `input` event (after the browser inserts
 * the @ character) — not on `keydown`. This sidesteps a race where opening
 * a modal during the keydown handler shifts focus before the default key
 * action runs, which would route the @ into the modal's search input
 * instead of the textarea.
 */
import { describe, it, expect, vi } from "vitest";
import { Window } from "happy-dom";
import {
  shouldTriggerOnInput,
  handleAtInput,
  insertAtCursor,
  replaceAtToken,
  type AtMentionDeps,
} from "../../src/webview/ui/at-mention-trigger";

function makeWindow(): Window {
  return new Window();
}

function makeTextarea(win: Window, initialValue = ""): HTMLTextAreaElement {
  const doc = win.document;
  const ta = doc.createElement("textarea") as unknown as HTMLTextAreaElement;
  ta.value = initialValue;
  doc.body.appendChild(ta);
  return ta;
}

/**
 * Build a synthetic InputEvent-shaped object. happy-dom may not implement
 * the full InputEvent constructor, so we construct a plain Event and
 * decorate the relevant fields.
 */
function makeInputEvent(
  win: Window,
  fields: { data?: string; inputType?: string; isComposing?: boolean },
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
    Object.defineProperty(e, "isComposing", {
      value: fields.isComposing,
      configurable: true,
    });
  }
  return e;
}

function makeAtDeps(
  ta: HTMLTextAreaElement,
  openModalFn: AtMentionDeps["openModal"],
): AtMentionDeps {
  return { textarea: ta, openModal: openModalFn };
}

// ─── shouldTriggerOnInput ─────────────────────────────────────────────────────

describe("shouldTriggerOnInput", () => {
  it("returns { atPos: 0 } when @ was just typed at start of empty textarea", () => {
    const win = makeWindow();
    // Reflect post-insertion textarea state.
    const ta = makeTextarea(win, "@");
    ta.selectionStart = 1;
    ta.selectionEnd = 1;
    const e = makeInputEvent(win, { data: "@", inputType: "insertText" });
    expect(shouldTriggerOnInput(ta, e)).toEqual({ atPos: 0 });
  });

  it("returns { atPos: 6 } when @ was typed after a space", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "hello @");
    ta.selectionStart = 7;
    ta.selectionEnd = 7;
    const e = makeInputEvent(win, { data: "@", inputType: "insertText" });
    expect(shouldTriggerOnInput(ta, e)).toEqual({ atPos: 6 });
  });

  it("returns null for @ in the middle of a word (e.g. 'foo@')", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "foo@");
    ta.selectionStart = 4;
    ta.selectionEnd = 4;
    const e = makeInputEvent(win, { data: "@", inputType: "insertText" });
    expect(shouldTriggerOnInput(ta, e)).toBeNull();
  });

  it("returns null when the inserted data is not @", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "a");
    ta.selectionStart = 1;
    ta.selectionEnd = 1;
    const e = makeInputEvent(win, { data: "a", inputType: "insertText" });
    expect(shouldTriggerOnInput(ta, e)).toBeNull();
  });

  it("returns null during IME composition (isComposing === true)", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "@");
    ta.selectionStart = 1;
    ta.selectionEnd = 1;
    const e = makeInputEvent(win, {
      data: "@",
      inputType: "insertText",
      isComposing: true,
    });
    expect(shouldTriggerOnInput(ta, e)).toBeNull();
  });

  it("returns null for non-insertText inputTypes (e.g. paste)", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "@");
    ta.selectionStart = 1;
    ta.selectionEnd = 1;
    const e = makeInputEvent(win, { data: "@", inputType: "insertFromPaste" });
    expect(shouldTriggerOnInput(ta, e)).toBeNull();
  });

  it("returns null when textarea last char is not @ (defensive)", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "hi");
    ta.selectionStart = 2;
    ta.selectionEnd = 2;
    const e = makeInputEvent(win, { data: "@", inputType: "insertText" });
    expect(shouldTriggerOnInput(ta, e)).toBeNull();
  });
});

// ─── handleAtInput ────────────────────────────────────────────────────────────

describe("handleAtInput", () => {
  it("opens modal when @ was just typed at start of empty textarea", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "@");
    ta.selectionStart = 1;
    ta.selectionEnd = 1;

    const openModal = vi.fn();
    const result = handleAtInput(
      makeAtDeps(ta, openModal),
      makeInputEvent(win, { data: "@", inputType: "insertText" }),
    );
    expect(result).toBe(true);
    expect(openModal).toHaveBeenCalledOnce();
  });

  it("does NOT open modal mid-word", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "foo@");
    ta.selectionStart = 4;
    ta.selectionEnd = 4;

    const openModal = vi.fn();
    const result = handleAtInput(
      makeAtDeps(ta, openModal),
      makeInputEvent(win, { data: "@", inputType: "insertText" }),
    );
    expect(result).toBe(false);
    expect(openModal).not.toHaveBeenCalled();
  });

  it("on select: replaces the typed @ with @<path> at the captured position", () => {
    const win = makeWindow();
    // Production: user typed @ at end of "hello ". Browser inserted it.
    const ta = makeTextarea(win, "hello @");
    ta.selectionStart = 7;
    ta.selectionEnd = 7;

    let capturedOnSelect: ((path: string) => void) | null = null;
    const openModal = vi.fn((onSelect) => {
      capturedOnSelect = onSelect;
    });

    handleAtInput(
      makeAtDeps(ta, openModal),
      makeInputEvent(win, { data: "@", inputType: "insertText" }),
    );
    expect(capturedOnSelect).not.toBeNull();

    capturedOnSelect!("notes/my-note.md");
    expect(ta.value).toBe("hello @notes/my-note.md ");
    expect(ta.selectionStart).toBe("hello @notes/my-note.md ".length);
  });

  it("on select at start of textarea: replaces @ cleanly (no @@ duplication)", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "@");
    ta.selectionStart = 1;
    ta.selectionEnd = 1;

    let capturedOnSelect: ((path: string) => void) | null = null;
    const openModal = vi.fn((onSelect) => {
      capturedOnSelect = onSelect;
    });

    handleAtInput(
      makeAtDeps(ta, openModal),
      makeInputEvent(win, { data: "@", inputType: "insertText" }),
    );

    capturedOnSelect!("Bins/test.md");
    expect(ta.value).toBe("@Bins/test.md ");
    // Critically: must NOT be "@@Bins/test.md " (the bug we fixed).
    expect(ta.value).not.toContain("@@");
  });

  it("on dismiss: textarea is unchanged (the typed @ remains)", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "@");
    ta.selectionStart = 1;
    ta.selectionEnd = 1;

    let capturedOnDismiss: (() => void) | null = null;
    const openModal = vi.fn((_onSelect, onDismiss) => {
      capturedOnDismiss = onDismiss;
    });

    handleAtInput(
      makeAtDeps(ta, openModal),
      makeInputEvent(win, { data: "@", inputType: "insertText" }),
    );

    capturedOnDismiss!();
    expect(ta.value).toBe("@");
  });
});

// ─── replaceAtToken ───────────────────────────────────────────────────────────

describe("replaceAtToken", () => {
  it("replaces a single @ at start with @<path>", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "@");
    ta.selectionStart = 1;
    ta.selectionEnd = 1;

    replaceAtToken(ta, 0, "@notes/foo.md ");
    expect(ta.value).toBe("@notes/foo.md ");
    expect(ta.selectionStart).toBe("@notes/foo.md ".length);
  });

  it("replaces @ followed by query characters typed before modal stole focus", () => {
    const win = makeWindow();
    // Edge case: keypress race where modal wasn't ready yet — user typed @we.
    const ta = makeTextarea(win, "@we");
    ta.selectionStart = 3;
    ta.selectionEnd = 3;

    replaceAtToken(ta, 0, "@weekly-review.md ");
    expect(ta.value).toBe("@weekly-review.md ");
  });

  it("preserves text after the cursor when replacing", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "hello @ tail");
    ta.selectionStart = 7; // just past @
    ta.selectionEnd = 7;

    replaceAtToken(ta, 6, "@x.md ");
    expect(ta.value).toBe("hello @x.md  tail");
  });

  it("dispatches an input event so auto-resize listeners fire", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "@");
    ta.selectionStart = 1;
    ta.selectionEnd = 1;

    let inputFired = false;
    ta.addEventListener("input", () => {
      inputFired = true;
    });

    replaceAtToken(ta, 0, "@x ");
    expect(inputFired).toBe(true);
  });
});

// ─── insertAtCursor (kept for backwards compat, used by callers that need raw
//     insertion separate from the @ trigger logic) ─────────────────────────────

describe("insertAtCursor", () => {
  it("inserts text at the cursor when textarea is empty", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "");
    ta.selectionStart = 0;
    ta.selectionEnd = 0;

    insertAtCursor(ta, "hello");
    expect(ta.value).toBe("hello");
    expect(ta.selectionStart).toBe(5);
  });

  it("inserts mid-text and preserves text after the cursor", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "abcdef");
    ta.selectionStart = 3;
    ta.selectionEnd = 3;

    insertAtCursor(ta, "XYZ");
    expect(ta.value).toBe("abcXYZdef");
  });

  it("replaces selected text with the inserted text", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "hello world");
    ta.selectionStart = 6;
    ta.selectionEnd = 11;

    insertAtCursor(ta, "earth");
    expect(ta.value).toBe("hello earth");
  });
});
