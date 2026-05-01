export interface AtMentionDeps {
  readonly textarea: HTMLTextAreaElement;
  readonly openModal: (
    onSelect: (path: string) => void,
    onDismiss: () => void
  ) => void;
}

/**
 * Returns true when the `@` key should open the file picker modal.
 *
 * Conditions that must ALL be true:
 *   - event.key === "@"
 *   - no modifier keys (metaKey, ctrlKey, altKey)
 *   - not inside an IME composition sequence (isComposing)
 *   - cursor is at position 0, OR the character immediately before the
 *     cursor is whitespace (so mid-word `@` like `email@example` is ignored)
 */
export function shouldTriggerAt(
  textarea: HTMLTextAreaElement,
  e: KeyboardEvent
): boolean {
  if (e.key !== "@") return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.isComposing) return false;

  const pos = textarea.selectionStart ?? 0;
  if (pos === 0) return true;

  const charBefore = textarea.value[pos - 1];
  return /\s/.test(charBefore);
}

/**
 * Intercepts the `@` key when the trigger condition is met.
 *
 * Calls `deps.openModal` with two callbacks:
 *   - `onSelect(path)`: inserts `@<path> ` at the cursor position.
 *   - `onDismiss()`:    inserts literal `@` at the cursor position
 *                       (mirrors the legacy terminal behavior).
 *
 * Returns `true` when it intercepts the event (caller should return early).
 * Returns `false` when the event was not intercepted.
 */
export function handleAtKey(deps: AtMentionDeps, e: KeyboardEvent): boolean {
  if (!shouldTriggerAt(deps.textarea, e)) return false;

  e.preventDefault();

  deps.openModal(
    (path: string) => {
      insertAtCursor(deps.textarea, `@${path} `);
    },
    () => {
      insertAtCursor(deps.textarea, "@");
    }
  );

  return true;
}

/**
 * Inserts `text` at the current selection / cursor position in `textarea`.
 * Any currently selected text is replaced by the insertion.
 * Moves the cursor to the end of the inserted text, then dispatches an
 * "input" event so auto-resize listeners fire.
 */
export function insertAtCursor(
  textarea: HTMLTextAreaElement,
  text: string
): void {
  const start = textarea.selectionStart ?? 0;
  const end = textarea.selectionEnd ?? start;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);

  textarea.value = before + text + after;

  const newPos = start + text.length;
  textarea.selectionStart = newPos;
  textarea.selectionEnd = newPos;

  const EventCtor: typeof Event =
    (textarea.ownerDocument?.defaultView as unknown as { Event: typeof Event } | null)
      ?.Event ?? Event;
  textarea.dispatchEvent(new EventCtor("input", { bubbles: true }));
}
