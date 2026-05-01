/**
 * Input bar — Phase 3 Task 3.
 *
 * Assembles the message-composition UI into the `inputRowEl` slot:
 *   - `<textarea>` with aria-label, auto-resize on input, 2-row default.
 *   - `<button>` Send with aria-label.
 *   - Cmd+Enter (macOS) / Ctrl+Enter (Win/Linux) → submit.
 *   - Plain Enter inserts a newline (unchanged default browser behavior).
 *
 * On submit: emit `{kind:'ui.send', text}` with the trimmed value, then
 * clear the textarea.  Empty / whitespace-only text is a no-op.
 *
 * DOM discipline (Phase 2 gate 2-5 reminder): this module uses
 * `replaceChildren` only — the banned-API grep gate covers this directory,
 * so any direct-mutation DOM call would fail CI.  Event listeners register
 * through the optional `registerDomEvent` hook so the Obsidian
 * `ItemView.registerDomEvent` path owns cleanup in production; the
 * direct-attach fallback is unit-test friendly and our `dispose()`
 * removes each direct-attach listener by hand.
 */
import type { Bus } from "../event-bus";

export interface InputBarOptions {
  /**
   * When provided (Obsidian runtime path), every DOM event binding is
   * registered through this hook so the leaf lifecycle owns cleanup.
   * When absent (unit tests under happy-dom), listeners go through
   * `target.addEventListener` and are explicitly removed on `dispose()`.
   */
  readonly registerDomEvent?: DomEventRegistrar;
  /**
   * Phase 3 — slash command menu trigger.
   * Called on every keydown event BEFORE the Enter handling logic.
   * When it returns `true`, the event has been fully handled by the caller
   * (modal opened, preventDefault called) — the input-bar keydown handler
   * short-circuits and does nothing further.
   * When it returns `false` (or is absent), the normal Enter logic runs.
   */
  readonly onSlashTrigger?: (e: KeyboardEvent) => boolean;
}

/** Narrowed `registerDomEvent` signature — mirrors Obsidian's overload. */
export type DomEventRegistrar = <K extends keyof HTMLElementEventMap>(
  target: HTMLElement,
  type: K,
  handler: (e: HTMLElementEventMap[K]) => void,
) => void;

export interface InputBar {
  readonly root: HTMLElement;
  readonly textareaEl: HTMLTextAreaElement;
  readonly sendButtonEl: HTMLButtonElement;
  /**
   * Remove every listener this instance attached via the direct-attach
   * fallback.  Listeners registered through `options.registerDomEvent`
   * are cleaned up by the leaf lifecycle and therefore ignored here.
   */
  dispose(): void;
}

const AUTO_RESIZE_MAX_HEIGHT_PX = 240;

export function buildInputBar(
  parent: HTMLElement,
  bus: Bus,
  options: InputBarOptions = {},
): InputBar {
  const doc = parent.ownerDocument;
  if (!doc) {
    throw new Error("[claude-webview] buildInputBar: parent has no ownerDocument");
  }

  const root = doc.createElement("div");
  root.className = "claude-wv-input-bar";
  root.setAttribute("role", "group");

  const textareaEl = doc.createElement("textarea");
  textareaEl.className = "claude-wv-input";
  textareaEl.rows = 2;
  textareaEl.setAttribute("aria-label", "Message Claude");
  textareaEl.placeholder = "Message Claude…";

  const sendButtonEl = doc.createElement("button");
  sendButtonEl.type = "button";
  sendButtonEl.className = "claude-wv-send";
  sendButtonEl.textContent = "Send";
  sendButtonEl.setAttribute("aria-label", "Send message");

  root.replaceChildren(textareaEl, sendButtonEl);
  parent.replaceChildren(root);

  const cleanups: Array<() => void> = [];

  const register: DomEventRegistrar = options.registerDomEvent
    ? options.registerDomEvent
    : (target, type, handler) => {
        target.addEventListener(type, handler as EventListener);
        cleanups.push(() =>
          target.removeEventListener(type, handler as EventListener),
        );
      };

  const submit = (): void => {
    const raw = textareaEl.value;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    bus.emit({ kind: "ui.send", text: trimmed });
    textareaEl.value = "";
    autoResize();
  };

  const autoResize = (): void => {
    // happy-dom may not compute scrollHeight — guard with a fallback so
    // unit tests don't trip over NaN height.
    textareaEl.style.height = "auto";
    const scrollHeight = textareaEl.scrollHeight;
    if (typeof scrollHeight === "number" && scrollHeight > 0) {
      const capped = Math.min(scrollHeight, AUTO_RESIZE_MAX_HEIGHT_PX);
      textareaEl.style.height = `${capped}px`;
    }
  };

  register(sendButtonEl, "click", (e) => {
    e.preventDefault();
    submit();
  });

  register(textareaEl, "keydown", (e) => {
    if (options.onSlashTrigger?.(e) === true) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  });

  register(textareaEl, "input", () => {
    autoResize();
  });

  return {
    root,
    textareaEl,
    sendButtonEl,
    dispose(): void {
      for (const fn of cleanups) {
        try {
          fn();
        } catch {
          // Continue — dispose must not throw.
        }
      }
      cleanups.length = 0;
    },
  };
}
