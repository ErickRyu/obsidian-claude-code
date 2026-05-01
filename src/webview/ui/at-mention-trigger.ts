/**
 * @ file picker trigger.
 *
 * Listens to the textarea's `input` event. When the user types `@` in a
 * position that warrants a file picker (start of textarea, or after
 * whitespace), it asks the caller to mount an inline popover. As the user
 * keeps typing, the same handler is invoked on every input event and
 * forwards the running query (the substring after `@` up to the cursor).
 *
 * On select, `replaceAtToken` swaps the entire `@<query>` token with
 * `@<path> ` and tears the popover down.
 */

import type { PopoverItem, InlinePopoverHandle } from "./inline-popover";

export interface AtTokenContext {
  /** Position of the `@` in the textarea. */
  readonly atPos: number;
  /** Substring between `@` and the current cursor (the user's query). */
  readonly query: string;
}

/**
 * Returns the `@<query>` token the cursor is currently inside, or `null`
 * if there is no live token. Walks back from the cursor to the nearest
 * whitespace; the character immediately after that whitespace must be `@`.
 */
export function findActiveAtToken(
  textarea: HTMLTextAreaElement,
): AtTokenContext | null {
  const value = textarea.value;
  const cursor = textarea.selectionStart ?? 0;
  if (cursor === 0) return null;

  // Scan back from cursor to the start of the current token.
  let i = cursor;
  while (i > 0 && !/\s/.test(value[i - 1])) {
    i -= 1;
  }
  // i is at the start of the token (either 0 or just after whitespace).
  if (value[i] !== "@") return null;

  return { atPos: i, query: value.slice(i + 1, cursor) };
}

/**
 * Returns true when the input event represents a fresh `@` keystroke
 * worth opening the popover for. Trigger conditions:
 *   - InputEvent.data === "@" (rules out paste, IME composition, etc.)
 *   - InputEvent.inputType === "insertText" or undefined (happy-dom)
 *   - !isComposing
 *   - The `@` is at start of textarea OR preceded by whitespace
 */
export function isFreshAtTrigger(
  textarea: HTMLTextAreaElement,
  e: Event,
): boolean {
  const ie = e as InputEvent;
  if ("isComposing" in ie && ie.isComposing === true) return false;
  if (
    "inputType" in ie &&
    ie.inputType !== undefined &&
    ie.inputType !== "insertText"
  ) {
    return false;
  }
  if ("data" in ie && ie.data !== undefined && ie.data !== "@") return false;

  const cursor = textarea.selectionStart ?? 0;
  if (cursor === 0) return false;
  if (textarea.value[cursor - 1] !== "@") return false;
  if (cursor === 1) return true;
  return /\s/.test(textarea.value[cursor - 2]);
}

/**
 * Replaces the `@` token at `atPos` (up to the current cursor) with
 * `replacement`. Cursor lands at end of the replacement. Dispatches an
 * `input` event so auto-resize listeners fire.
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

export interface AtMentionRuntime {
  readonly textarea: HTMLTextAreaElement;
  /** Returns the popover items to show for the current query. */
  readonly searchFiles: (query: string) => PopoverItem[];
  /** Mounts the popover and returns its handle. */
  readonly openPopover: (
    items: readonly PopoverItem[],
    onSelect: (item: PopoverItem) => void,
    onDismiss: () => void,
  ) => InlinePopoverHandle;
}

/**
 * Manages the @ popover lifecycle for one textarea. Returns a function
 * that the caller hooks into the textarea's `input` listener.
 */
export function createAtMentionDriver(runtime: AtMentionRuntime): {
  onInput: (e: Event) => void;
  dispose: () => void;
} {
  let popover: InlinePopoverHandle | null = null;
  let activeAtPos: number | null = null;

  const close = (): void => {
    if (popover) {
      popover.dispose();
      popover = null;
    }
    activeAtPos = null;
  };

  const openWithToken = (atPos: number, query: string): void => {
    activeAtPos = atPos;
    const items = runtime.searchFiles(query);
    popover = runtime.openPopover(
      items,
      (item) => {
        const path = String(item.metadata ?? item.label);
        if (activeAtPos !== null) {
          replaceAtToken(runtime.textarea, activeAtPos, `@${path} `);
        }
        close();
      },
      () => close(),
    );
  };

  const onInput = (e: Event): void => {
    const ta = runtime.textarea;
    const token = findActiveAtToken(ta);

    if (popover) {
      // Popover is open. Either keep showing for the live token, or close.
      if (!token || token.atPos !== activeAtPos) {
        // User deleted the @ or moved out of the token — close.
        close();
        // If they typed a new @ that should re-open, fall through to the
        // fresh-trigger logic below.
        if (!isFreshAtTrigger(ta, e)) return;
        const fresh = findActiveAtToken(ta);
        if (!fresh) return;
        openWithToken(fresh.atPos, fresh.query);
        return;
      }
      // Same token — just update the query.
      popover.update(runtime.searchFiles(token.query));
      return;
    }

    // No popover yet. Open on a fresh @ keystroke.
    if (!isFreshAtTrigger(ta, e)) return;
    if (!token) return;
    openWithToken(token.atPos, token.query);
  };

  return {
    onInput,
    dispose: close,
  };
}
