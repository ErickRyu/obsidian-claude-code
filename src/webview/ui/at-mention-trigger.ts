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
 * Note: this does NOT call `preventDefault()`. We let the `@` flow into the
 * textarea (so the user sees what they typed) and capture its position.
 * On select, `replaceAtToken` swaps the `@` (and any query the user typed
 * after) with `@<path> `. On dismiss, the typed `@` simply stays in place.
 *
 * Returns `true` when it intercepts the event (caller should return early
 * so downstream handlers like Enter-to-send don't also fire).
 */
export function handleAtKey(deps: AtMentionDeps, e: KeyboardEvent): boolean {
  if (!shouldTriggerAt(deps.textarea, e)) return false;

  // Capture the cursor position at keydown time — this is the offset where
  // the browser is about to insert `@`. After the default key action runs,
  // `selectionStart` will be `atPos + 1`. We don't preventDefault so the
  // user sees their `@` immediately.
  const atPos = deps.textarea.selectionStart ?? 0;

  deps.openModal(
    (path: string) => {
      replaceAtToken(deps.textarea, atPos, `@${path} `);
    },
    () => {
      // Modal dismissed — the `@` already lives in the textarea, leave it
      // alone so the user can keep typing or delete it manually.
    },
  );

  return true;
}

/**
 * Replaces the `@` token (from `atPos` up to the current cursor position)
 * with `replacement`. Used after the file picker resolves so the typed
 * `@` (and any query characters that landed before the modal stole focus)
 * become `@<path> `. Cursor lands at end of the replacement.
 */
export function replaceAtToken(
  textarea: HTMLTextAreaElement,
  atPos: number,
  replacement: string,
): void {
  const cursorPos = textarea.selectionStart ?? atPos + 1;
  const before = textarea.value.slice(0, atPos);
  const after = textarea.value.slice(cursorPos);
  textarea.value = before + replacement + after;

  const newPos = atPos + replacement.length;
  textarea.selectionStart = newPos;
  textarea.selectionEnd = newPos;

  const EventCtor: typeof Event =
    (textarea.ownerDocument?.defaultView as unknown as { Event: typeof Event } | null)
      ?.Event ?? Event;
  textarea.dispatchEvent(new EventCtor("input", { bubbles: true }));
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
