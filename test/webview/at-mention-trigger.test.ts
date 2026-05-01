/**
 * Tests for the @ mention trigger module.
 *
 * All cases are covered using happy-dom Window + manual KeyboardEvent dispatch
 * to keep the module free of Obsidian imports and testable in isolation.
 */
import { describe, it, expect, vi } from "vitest";
import { Window } from "happy-dom";
import {
  shouldTriggerAt,
  handleAtKey,
  insertAtCursor,
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

function makeKeyEvent(
  win: Window,
  init: {
    key: string;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    isComposing?: boolean;
  }
): KeyboardEvent {
  const KeyboardEventCtor = (
    win as unknown as { KeyboardEvent: typeof KeyboardEvent }
  ).KeyboardEvent;
  return new KeyboardEventCtor("keydown", {
    key: init.key,
    bubbles: true,
    cancelable: true,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
  }) as unknown as KeyboardEvent;
}

function makeAtDeps(
  ta: HTMLTextAreaElement,
  openModalFn: AtMentionDeps["openModal"]
): AtMentionDeps {
  return { textarea: ta, openModal: openModalFn };
}

// ─── Case 1: @ at empty textarea → triggers ───────────────────────────────────

describe("shouldTriggerAt", () => {
  it("returns true for @ at empty textarea", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "");
    ta.selectionStart = 0;
    ta.selectionEnd = 0;
    const e = makeKeyEvent(win, { key: "@" });
    expect(shouldTriggerAt(ta, e)).toBe(true);
  });

  it("returns true for @ after a space", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "hello ");
    ta.selectionStart = 6;
    ta.selectionEnd = 6;
    const e = makeKeyEvent(win, { key: "@" });
    expect(shouldTriggerAt(ta, e)).toBe(true);
  });

  it("returns true for @ after a tab character", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "word\t");
    ta.selectionStart = 5;
    ta.selectionEnd = 5;
    const e = makeKeyEvent(win, { key: "@" });
    expect(shouldTriggerAt(ta, e)).toBe(true);
  });

  it("returns true for @ after a newline", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "line\n");
    ta.selectionStart = 5;
    ta.selectionEnd = 5;
    const e = makeKeyEvent(win, { key: "@" });
    expect(shouldTriggerAt(ta, e)).toBe(true);
  });

  // ─── Case 3: @ after a letter → does NOT trigger ────────────────────────────

  it("returns false for @ after a letter (e.g. 'foo@')", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "foo");
    ta.selectionStart = 3;
    ta.selectionEnd = 3;
    const e = makeKeyEvent(win, { key: "@" });
    expect(shouldTriggerAt(ta, e)).toBe(false);
  });

  it("returns false for @ inside a word (email style)", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "email@example");
    // cursor is right after the '@' position at index 5
    ta.selectionStart = 5;
    ta.selectionEnd = 5;
    const e = makeKeyEvent(win, { key: "@" });
    // char before cursor is 'l' (last char of "email")
    expect(shouldTriggerAt(ta, e)).toBe(false);
  });

  // ─── Case 4: @ during IME composition → does NOT trigger ────────────────────

  it("returns false for @ during IME composition", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "");
    ta.selectionStart = 0;
    ta.selectionEnd = 0;
    const e = makeKeyEvent(win, { key: "@", isComposing: true });
    // isComposing isn't passed through KeyboardEventInit in happy-dom the same
    // way; we override the property to simulate the composing state
    Object.defineProperty(e, "isComposing", { value: true, configurable: true });
    expect(shouldTriggerAt(ta, e)).toBe(false);
  });

  // ─── Case 5 & 6: @ + Cmd or Ctrl → does NOT trigger ────────────────────────

  it("returns false for @ + metaKey", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "");
    ta.selectionStart = 0;
    ta.selectionEnd = 0;
    const e = makeKeyEvent(win, { key: "@", metaKey: true });
    expect(shouldTriggerAt(ta, e)).toBe(false);
  });

  it("returns false for @ + ctrlKey", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "");
    ta.selectionStart = 0;
    ta.selectionEnd = 0;
    const e = makeKeyEvent(win, { key: "@", ctrlKey: true });
    expect(shouldTriggerAt(ta, e)).toBe(false);
  });

  it("returns false for @ + altKey", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "");
    ta.selectionStart = 0;
    ta.selectionEnd = 0;
    const e = makeKeyEvent(win, { key: "@", altKey: true });
    expect(shouldTriggerAt(ta, e)).toBe(false);
  });

  it("returns false for non-@ key", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "");
    ta.selectionStart = 0;
    ta.selectionEnd = 0;
    const e = makeKeyEvent(win, { key: "a" });
    expect(shouldTriggerAt(ta, e)).toBe(false);
  });
});

// ─── handleAtKey integration tests ───────────────────────────────────────────

describe("handleAtKey", () => {
  // ─── Case 1: @ at empty textarea → triggers, openModal called once ──────────

  it("@ at empty textarea → returns true and calls openModal once", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "");
    ta.selectionStart = 0;
    ta.selectionEnd = 0;

    const openModal = vi.fn();
    const deps = makeAtDeps(ta, openModal);
    const e = makeKeyEvent(win, { key: "@" });

    const result = handleAtKey(deps, e);

    expect(result).toBe(true);
    expect(openModal).toHaveBeenCalledOnce();
  });

  it("@ at empty textarea → does NOT preventDefault (lets @ flow into textarea)", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "");
    ta.selectionStart = 0;
    ta.selectionEnd = 0;

    const openModal = vi.fn();
    const deps = makeAtDeps(ta, openModal);
    const e = makeKeyEvent(win, { key: "@" });
    const preventDefaultSpy = vi.spyOn(e, "preventDefault");

    handleAtKey(deps, e);

    // The @ must reach the textarea so the user sees what they typed; the
    // duplication bug came from preventDefault NOT being honored in
    // Obsidian/Electron and then `insertAtCursor` prepending another @.
    expect(preventDefaultSpy).not.toHaveBeenCalled();
  });

  // ─── Case 2: @ after space → triggers ───────────────────────────────────────

  it("@ after a space → returns true and calls openModal", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "hello ");
    ta.selectionStart = 6;
    ta.selectionEnd = 6;

    const openModal = vi.fn();
    const deps = makeAtDeps(ta, openModal);
    const e = makeKeyEvent(win, { key: "@" });

    const result = handleAtKey(deps, e);

    expect(result).toBe(true);
    expect(openModal).toHaveBeenCalledOnce();
  });

  // ─── Case 3: @ after a letter → does NOT trigger ────────────────────────────

  it("@ after a letter → returns false and openModal NOT called", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "foo");
    ta.selectionStart = 3;
    ta.selectionEnd = 3;

    const openModal = vi.fn();
    const deps = makeAtDeps(ta, openModal);
    const e = makeKeyEvent(win, { key: "@" });
    const preventDefaultSpy = vi.spyOn(e, "preventDefault");

    const result = handleAtKey(deps, e);

    expect(result).toBe(false);
    expect(openModal).not.toHaveBeenCalled();
    expect(preventDefaultSpy).not.toHaveBeenCalled();
  });

  // ─── Case 4: @ during IME composition → does NOT trigger ────────────────────

  it("@ during IME composition → returns false and openModal NOT called", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "");
    ta.selectionStart = 0;
    ta.selectionEnd = 0;

    const openModal = vi.fn();
    const deps = makeAtDeps(ta, openModal);
    const e = makeKeyEvent(win, { key: "@" });
    Object.defineProperty(e, "isComposing", { value: true, configurable: true });

    const result = handleAtKey(deps, e);

    expect(result).toBe(false);
    expect(openModal).not.toHaveBeenCalled();
  });

  // ─── Case 5: @ + Cmd → does NOT trigger ─────────────────────────────────────

  it("@ + Cmd → returns false and openModal NOT called", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "");
    ta.selectionStart = 0;
    ta.selectionEnd = 0;

    const openModal = vi.fn();
    const deps = makeAtDeps(ta, openModal);
    const e = makeKeyEvent(win, { key: "@", metaKey: true });

    const result = handleAtKey(deps, e);

    expect(result).toBe(false);
    expect(openModal).not.toHaveBeenCalled();
  });

  // ─── Case 6: @ + Ctrl → does NOT trigger ────────────────────────────────────

  it("@ + Ctrl → returns false and openModal NOT called", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "");
    ta.selectionStart = 0;
    ta.selectionEnd = 0;

    const openModal = vi.fn();
    const deps = makeAtDeps(ta, openModal);
    const e = makeKeyEvent(win, { key: "@", ctrlKey: true });

    const result = handleAtKey(deps, e);

    expect(result).toBe(false);
    expect(openModal).not.toHaveBeenCalled();
  });

  // ─── Case 7: Esc dismiss → no-op (typed @ stays where the browser put it) ───

  it("Esc dismiss callback → no-op (the @ already in the textarea is preserved)", () => {
    const win = makeWindow();
    // handleAtKey is dispatched at keydown — before the @ lands. Pre-insert
    // state: empty textarea, cursor at 0.
    const ta = makeTextarea(win, "");
    ta.selectionStart = 0;
    ta.selectionEnd = 0;

    let capturedOnDismiss: (() => void) | null = null;
    const openModal = vi.fn((onSelect, onDismiss) => {
      capturedOnDismiss = onDismiss;
    });
    const deps = makeAtDeps(ta, openModal);
    const e = makeKeyEvent(win, { key: "@" });

    handleAtKey(deps, e);
    expect(capturedOnDismiss).not.toBeNull();

    // Browser default action inserts @ between keydown and modal opening.
    // (happy-dom doesn't simulate this, so we mirror it manually.)
    ta.value = "@";
    ta.selectionStart = 1;
    ta.selectionEnd = 1;

    capturedOnDismiss!();
    // Dismiss must not mutate the textarea — the @ the user typed remains.
    expect(ta.value).toBe("@");
  });

  it("Esc dismiss callback → no-op when @ is mid-text", () => {
    const win = makeWindow();
    // Mirror production: browser already inserted @ after "hello ".
    const ta = makeTextarea(win, "hello @");
    ta.selectionStart = 7;
    ta.selectionEnd = 7;

    let capturedOnDismiss: (() => void) | null = null;
    const openModal = vi.fn((onSelect, onDismiss) => {
      capturedOnDismiss = onDismiss;
    });
    const deps = makeAtDeps(ta, openModal);
    // handleAtKey is dispatched at keydown, BEFORE the @ lands. Recreate
    // that ordering by setting up the textarea pre-insertion just for the
    // call to handleAtKey, then putting back the post-insertion state for
    // the dismiss callback.
    ta.value = "hello ";
    ta.selectionStart = 6;
    ta.selectionEnd = 6;
    const e = makeKeyEvent(win, { key: "@" });
    handleAtKey(deps, e);

    // Browser inserts @ between handleAtKey and the modal opening.
    ta.value = "hello @";
    ta.selectionStart = 7;
    ta.selectionEnd = 7;

    capturedOnDismiss!();
    expect(ta.value).toBe("hello @");
  });

  // ─── Case 8: Select path → "@<path> " inserted with cursor after space ───────

  it("select path → '@<path> ' inserted at cursor with trailing space", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "");
    ta.selectionStart = 0;
    ta.selectionEnd = 0;

    let capturedOnSelect: ((path: string) => void) | null = null;
    const openModal = vi.fn((onSelect, _onDismiss) => {
      capturedOnSelect = onSelect;
    });
    const deps = makeAtDeps(ta, openModal);
    const e = makeKeyEvent(win, { key: "@" });

    handleAtKey(deps, e);
    expect(capturedOnSelect).not.toBeNull();

    capturedOnSelect!("notes/my-note.md");
    expect(ta.value).toBe("@notes/my-note.md ");
    // Cursor should be placed after the trailing space
    expect(ta.selectionStart).toBe("@notes/my-note.md ".length);
    expect(ta.selectionEnd).toBe("@notes/my-note.md ".length);
  });

  it("select path → '@<path> ' inserted after existing text", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "check out ");
    ta.selectionStart = 10;
    ta.selectionEnd = 10;

    let capturedOnSelect: ((path: string) => void) | null = null;
    const openModal = vi.fn((onSelect, _onDismiss) => {
      capturedOnSelect = onSelect;
    });
    const deps = makeAtDeps(ta, openModal);
    const e = makeKeyEvent(win, { key: "@" });

    handleAtKey(deps, e);
    capturedOnSelect!("folder/file.md");

    expect(ta.value).toBe("check out @folder/file.md ");
    const expectedPos = "check out @folder/file.md ".length;
    expect(ta.selectionStart).toBe(expectedPos);
    expect(ta.selectionEnd).toBe(expectedPos);
  });
});

// ─── Case 9: insertAtCursor preserves text after cursor ──────────────────────

describe("insertAtCursor", () => {
  it("inserts text at the cursor when textarea is empty", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "");
    ta.selectionStart = 0;
    ta.selectionEnd = 0;

    insertAtCursor(ta, "hello");
    expect(ta.value).toBe("hello");
    expect(ta.selectionStart).toBe(5);
    expect(ta.selectionEnd).toBe(5);
  });

  it("inserts text at cursor position in mid-text (preserves text after cursor)", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "abcdef");
    // Cursor between 'abc' and 'def'
    ta.selectionStart = 3;
    ta.selectionEnd = 3;

    insertAtCursor(ta, "XYZ");
    expect(ta.value).toBe("abcXYZdef");
    expect(ta.selectionStart).toBe(6);
    expect(ta.selectionEnd).toBe(6);
  });

  it("inserts text at end of existing content", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "prefix ");
    ta.selectionStart = 7;
    ta.selectionEnd = 7;

    insertAtCursor(ta, "suffix");
    expect(ta.value).toBe("prefix suffix");
    expect(ta.selectionStart).toBe(13);
    expect(ta.selectionEnd).toBe(13);
  });

  it("replaces selected text with the inserted text", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "hello world");
    // Select 'world'
    ta.selectionStart = 6;
    ta.selectionEnd = 11;

    insertAtCursor(ta, "earth");
    expect(ta.value).toBe("hello earth");
    expect(ta.selectionStart).toBe(11);
    expect(ta.selectionEnd).toBe(11);
  });

  it("dispatches an input event so auto-resize listeners fire", () => {
    const win = makeWindow();
    const ta = makeTextarea(win, "");
    ta.selectionStart = 0;
    ta.selectionEnd = 0;

    let inputFired = false;
    ta.addEventListener("input", () => {
      inputFired = true;
    });

    insertAtCursor(ta, "test");
    expect(inputFired).toBe(true);
  });
});
