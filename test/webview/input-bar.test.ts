/**
 * Phase 3 Task 7 — input-bar runtime contract (3-8).
 *
 * Covers:
 *   - Build: textarea + send button + accessible labels.
 *   - Send click → bus.emit({kind:'ui.send', text}) with trimmed text.
 *   - Empty / whitespace-only text → no emit (blocks accidental sends).
 *   - Cmd+Enter AND Ctrl+Enter → emit (cross-platform).
 *   - Plain Enter (no modifier) → emit (chat-app UX: Enter to send).
 *   - Shift+Enter → no emit (preserves newline insertion).
 *   - Enter during IME composition → no emit (Korean/Japanese/Chinese input).
 *   - After send, textarea value is cleared.
 *   - registerDomEvent fallback: when the option is provided (Obsidian
 *     ItemView gives us this), listeners go through it (so cleanup on
 *     view unload is handled by Obsidian lifecycle).
 */
import { describe, it, expect, vi } from "vitest";
import { Window } from "happy-dom";
import { createBus } from "../../src/webview/event-bus";
import { buildInputBar } from "../../src/webview/ui/input-bar";

function mountRoot(): { root: HTMLElement; win: Window } {
  const win = new Window();
  const doc = win.document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { root: root as unknown as HTMLElement, win };
}

function keydown(
  target: HTMLElement,
  init: { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; isComposing?: boolean }
): { defaultPrevented: boolean } {
  const doc = target.ownerDocument as unknown as Document;
  const win = doc.defaultView as unknown as Window & typeof globalThis;
  const KeyboardEventCtor =
    (win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
  const e = new KeyboardEventCtor("keydown", {
    key: init.key,
    bubbles: true,
    cancelable: true,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
  });
  if (init.isComposing) {
    Object.defineProperty(e, "isComposing", { value: true });
  }
  target.dispatchEvent(e);
  return { defaultPrevented: e.defaultPrevented };
}

describe("buildInputBar — Phase 3 input bar runtime (3-8)", () => {
  it("mounts a textarea + send button with aria labels into root", () => {
    const { root } = mountRoot();
    const bus = createBus();
    const bar = buildInputBar(root, bus);

    expect(bar.textareaEl.tagName.toLowerCase()).toBe("textarea");
    expect(bar.sendButtonEl.tagName.toLowerCase()).toBe("button");
    expect(bar.textareaEl.getAttribute("aria-label")).toBeTruthy();
    expect(bar.sendButtonEl.getAttribute("aria-label")).toBeTruthy();

    bar.dispose();
  });

  it("send click emits ui.send with trimmed text and clears textarea", () => {
    const { root } = mountRoot();
    const bus = createBus();
    const seen: string[] = [];
    bus.on("ui.send", (e) => seen.push(e.text));

    const bar = buildInputBar(root, bus);
    bar.textareaEl.value = "  hello  ";
    bar.sendButtonEl.click();

    expect(seen).toEqual(["hello"]);
    expect(bar.textareaEl.value).toBe("");
    bar.dispose();
  });

  it("empty / whitespace-only text does NOT emit", () => {
    const { root } = mountRoot();
    const bus = createBus();
    const seen: string[] = [];
    bus.on("ui.send", (e) => seen.push(e.text));

    const bar = buildInputBar(root, bus);
    bar.textareaEl.value = "   \n  ";
    bar.sendButtonEl.click();
    expect(seen).toHaveLength(0);

    bar.textareaEl.value = "";
    bar.sendButtonEl.click();
    expect(seen).toHaveLength(0);

    bar.dispose();
  });

  it("Cmd+Enter emits ui.send (macOS shortcut)", () => {
    const { root } = mountRoot();
    const bus = createBus();
    const seen: string[] = [];
    bus.on("ui.send", (e) => seen.push(e.text));

    const bar = buildInputBar(root, bus);
    bar.textareaEl.value = "via Cmd+Enter";
    const r = keydown(bar.textareaEl, { key: "Enter", metaKey: true });

    expect(seen).toEqual(["via Cmd+Enter"]);
    expect(r.defaultPrevented).toBe(true);
    bar.dispose();
  });

  it("Ctrl+Enter emits ui.send (Windows/Linux shortcut)", () => {
    const { root } = mountRoot();
    const bus = createBus();
    const seen: string[] = [];
    bus.on("ui.send", (e) => seen.push(e.text));

    const bar = buildInputBar(root, bus);
    bar.textareaEl.value = "via Ctrl+Enter";
    const r = keydown(bar.textareaEl, { key: "Enter", ctrlKey: true });

    expect(seen).toEqual(["via Ctrl+Enter"]);
    expect(r.defaultPrevented).toBe(true);
    bar.dispose();
  });

  it("plain Enter (no modifier) DOES emit — chat-app Enter-to-send UX", () => {
    const { root } = mountRoot();
    const bus = createBus();
    const seen: string[] = [];
    bus.on("ui.send", (e) => seen.push(e.text));

    const bar = buildInputBar(root, bus);
    bar.textareaEl.value = "hello";
    const r = keydown(bar.textareaEl, { key: "Enter" });

    expect(seen).toEqual(["hello"]);
    expect(r.defaultPrevented).toBe(true);
    bar.dispose();
  });

  it("Shift+Enter does NOT emit — preserves newline insertion", () => {
    const { root } = mountRoot();
    const bus = createBus();
    const seen: string[] = [];
    bus.on("ui.send", (e) => seen.push(e.text));

    const bar = buildInputBar(root, bus);
    bar.textareaEl.value = "multiline";
    const r = keydown(bar.textareaEl, { key: "Enter", shiftKey: true });

    expect(seen).toHaveLength(0);
    expect(r.defaultPrevented).toBe(false);
    bar.dispose();
  });

  it("Enter during IME composition does NOT emit — preserves Korean/Japanese/Chinese input", () => {
    const { root } = mountRoot();
    const bus = createBus();
    const seen: string[] = [];
    bus.on("ui.send", (e) => seen.push(e.text));

    const bar = buildInputBar(root, bus);
    bar.textareaEl.value = "한글";
    const r = keydown(bar.textareaEl, { key: "Enter", isComposing: true });

    expect(seen).toHaveLength(0);
    expect(r.defaultPrevented).toBe(false);
    bar.dispose();
  });

  it("registerDomEvent fallback — when provided, listeners go through it", () => {
    const { root } = mountRoot();
    const bus = createBus();
    const registerDomEvent = vi.fn(
      (target: HTMLElement, type: string, handler: (e: Event) => void) => {
        target.addEventListener(type, handler);
      }
    );

    const bar = buildInputBar(root, bus, { registerDomEvent });
    // At least one click binding + one keydown binding + one input binding
    // registered via the option.
    expect(registerDomEvent.mock.calls.length).toBeGreaterThanOrEqual(3);
    bar.dispose();
  });

  it("onAtInput receives every input event on the textarea", () => {
    const { root } = mountRoot();
    const bus = createBus();

    const onAtInput = vi.fn();
    const bar = buildInputBar(root, bus, { onAtInput });

    // Simulate a typed character that fires an input event.
    bar.textareaEl.value = "@";
    bar.textareaEl.dispatchEvent(
      new (root.ownerDocument!.defaultView as unknown as { Event: typeof Event }).Event(
        "input",
        { bubbles: true },
      ),
    );

    expect(onAtInput).toHaveBeenCalledOnce();
    bar.dispose();
  });

  it("onSlashTrigger short-circuits before Enter handling", () => {
    const { root } = mountRoot();
    const bus = createBus();
    const seen: string[] = [];
    bus.on("ui.send", (e) => seen.push(e.text));

    const onSlashTrigger = vi.fn(() => true);

    const bar = buildInputBar(root, bus, { onSlashTrigger });
    bar.textareaEl.value = "should not send";

    // onSlashTrigger returns true → Enter is short-circuited.
    keydown(bar.textareaEl, { key: "Enter", metaKey: true });

    expect(onSlashTrigger).toHaveBeenCalled();
    expect(seen).toHaveLength(0);

    bar.dispose();
  });

  it("dispose removes listeners so post-dispose click is a no-op", () => {
    const { root } = mountRoot();
    const bus = createBus();
    const seen: string[] = [];
    bus.on("ui.send", (e) => seen.push(e.text));

    const bar = buildInputBar(root, bus);
    bar.textareaEl.value = "before dispose";
    bar.sendButtonEl.click();
    expect(seen).toEqual(["before dispose"]);

    bar.dispose();
    bar.textareaEl.value = "after dispose";
    bar.sendButtonEl.click();
    // Only the pre-dispose send is recorded.
    expect(seen).toEqual(["before dispose"]);
  });
});
