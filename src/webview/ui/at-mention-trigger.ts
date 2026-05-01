export interface AtMentionDeps {
  readonly textarea: HTMLTextAreaElement;
  readonly openModal: (
    onSelect: (path: string) => void,
    onDismiss: () => void,
  ) => void;
}

/**
 * Decides whether the current `input` event corresponds to a fresh `@`
 * keystroke that should open the file picker.
 *
 * Returns `{ atPos }` (the position of the `@` in the textarea) when the
 * trigger condition matches, `null` otherwise. Trigger requires:
 *   - the just-inserted data is exactly "@" (rules out paste of "@foo",
 *     IME composition end, autocomplete, etc.)
 *   - the @ is at the start of the textarea OR is preceded by whitespace
 *     (so a mid-word `email@example` does not open the modal)
 */
export function shouldTriggerOnInput(
  textarea: HTMLTextAreaElement,
  e: Event,
): { atPos: number } | null {
  // happy-dom may not give us an InputEvent — feature-detect.
  const ie = e as InputEvent;
  if ("isComposing" in ie && ie.isComposing === true) return null;
  if ("inputType" in ie && ie.inputType !== undefined && ie.inputType !== "insertText") {
    return null;
  }
  if ("data" in ie && ie.data !== undefined && ie.data !== "@") return null;

  const pos = textarea.selectionStart ?? 0;
  if (pos === 0) return null;
  if (textarea.value[pos - 1] !== "@") return null;

  if (pos === 1) return { atPos: 0 };
  const charBefore = textarea.value[pos - 2];
  if (/\s/.test(charBefore)) return { atPos: pos - 1 };

  return null;
}

/**
 * Hook this into the textarea's `input` event. Opens the file picker
 * whenever the user just typed an `@` in a position that warrants it.
 *
 * On select: replaces the typed `@` (and any query characters) with
 * `@<path> ` via `replaceAtToken`.
 * On dismiss: leaves the typed `@` in place (the user can keep typing
 * normally).
 *
 * Returns `true` if the modal was opened, `false` otherwise.
 */
export function handleAtInput(deps: AtMentionDeps, e: Event): boolean {
  const trigger = shouldTriggerOnInput(deps.textarea, e);
  if (!trigger) return false;

  const { atPos } = trigger;
  deps.openModal(
    (path: string) => {
      replaceAtToken(deps.textarea, atPos, `@${path} `);
    },
    () => {
      // Modal dismissed — the typed @ stays in the textarea so the user
      // can continue editing it manually.
    },
  );
  return true;
}

/**
 * Replaces the `@` token (from `atPos` up to the current cursor position)
 * with `replacement`. Used after the file picker resolves.
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
 * Inserts `text` at the current cursor / selection. Kept for callers that
 * need a raw insertion (e.g. tests). Most production callers should prefer
 * `replaceAtToken` so the typed `@` is consumed cleanly.
 */
export function insertAtCursor(
  textarea: HTMLTextAreaElement,
  text: string,
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
