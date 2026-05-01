/**
 * Inline popover for @ file picker and / slash command menu.
 *
 * Replaces SuggestModal — keeps focus on the textarea, no backdrop, no
 * focus race that would route the trigger keystroke into the modal's
 * search input. Positioned above the textarea, keyboard-navigable, and
 * dispatches a pure callback on selection.
 */

export interface PopoverItem {
  /** Stable key. Used for DOM data-id and identity comparison. */
  readonly id: string;
  /** Primary visible text. */
  readonly label: string;
  /** Secondary muted text shown beside the label. */
  readonly description?: string;
  /** Optional badge text (e.g. "cli", "user", "global"). */
  readonly badge?: string;
  /** Caller-defined payload, returned in `onSelect`. */
  readonly metadata?: unknown;
}

export interface InlinePopoverOptions {
  /** Element the popover anchors to (typically the textarea). */
  readonly anchor: HTMLElement;
  /** Initial item list. */
  readonly items: readonly PopoverItem[];
  /** Called when the user picks an item (click or Enter). */
  readonly onSelect: (item: PopoverItem) => void;
  /** Called when the user dismisses (Esc, click-outside, deleted token). */
  readonly onDismiss?: () => void;
  /** Text shown when items is empty. Defaults to "No results". */
  readonly emptyMessage?: string;
}

export interface InlinePopoverHandle {
  /** Replace the visible items. Selection resets to index 0. */
  update(items: readonly PopoverItem[]): void;
  /** Tear down DOM + listeners. Idempotent. */
  dispose(): void;
  /** True until dispose is called. */
  isOpen(): boolean;
}

export function mountInlinePopover(
  opts: InlinePopoverOptions,
): InlinePopoverHandle {
  const doc = opts.anchor.ownerDocument;
  if (!doc) {
    throw new Error("[claude-webview] inline-popover: anchor has no ownerDocument");
  }
  const win = doc.defaultView;
  if (!win) {
    throw new Error("[claude-webview] inline-popover: ownerDocument has no defaultView");
  }

  const root = doc.createElement("div");
  root.className = "claude-wv-popover";
  root.setAttribute("role", "listbox");
  // Inline styles so we don't depend on the plugin's styles.css being
  // up to date — the popover should render correctly even if a user
  // is on an old CSS bundle.
  Object.assign(root.style, {
    position: "absolute",
    zIndex: "1000",
    minWidth: "240px",
    maxHeight: "260px",
    overflowY: "auto",
    background: "var(--background-primary)",
    border: "1px solid var(--background-modifier-border)",
    borderRadius: "6px",
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.25)",
    padding: "4px 0",
    fontSize: "13px",
  } as CSSStyleDeclaration);

  let currentItems: readonly PopoverItem[] = [];
  let selectedIndex = 0;
  let disposed = false;

  doc.body.appendChild(root);

  const reposition = (): void => {
    if (disposed) return;
    const r = opts.anchor.getBoundingClientRect();
    // Render above the textarea. If there isn't enough room above
    // (small viewport), fall back to placing it below.
    const viewportTop = 0;
    const popoverHeight = root.offsetHeight || 200;
    const wantsAbove = r.top - viewportTop > popoverHeight + 8;

    root.style.left = `${r.left}px`;
    root.style.maxWidth = `${Math.max(r.width, 280)}px`;
    if (wantsAbove) {
      root.style.top = `${r.top - popoverHeight - 6}px`;
    } else {
      root.style.top = `${r.bottom + 6}px`;
    }
  };

  const render = (): void => {
    if (disposed) return;
    root.replaceChildren();
    if (currentItems.length === 0) {
      const empty = doc.createElement("div");
      empty.className = "claude-wv-popover-empty";
      Object.assign(empty.style, {
        padding: "10px 14px",
        color: "var(--text-muted)",
        fontStyle: "italic",
      } as CSSStyleDeclaration);
      empty.textContent = opts.emptyMessage ?? "No results";
      root.appendChild(empty);
      reposition();
      return;
    }

    currentItems.forEach((item, i) => {
      const row = doc.createElement("div");
      row.className = "claude-wv-popover-item";
      row.setAttribute("role", "option");
      row.setAttribute("data-id", item.id);
      Object.assign(row.style, {
        padding: "6px 12px",
        cursor: "pointer",
        display: "flex",
        alignItems: "baseline",
        gap: "8px",
      } as CSSStyleDeclaration);
      if (i === selectedIndex) {
        row.style.background = "var(--background-modifier-hover)";
      }

      const label = doc.createElement("span");
      label.className = "claude-wv-popover-label";
      Object.assign(label.style, {
        color: "var(--text-normal)",
        flex: "0 0 auto",
      } as CSSStyleDeclaration);
      label.textContent = item.label;
      row.appendChild(label);

      if (item.badge) {
        const badge = doc.createElement("small");
        badge.className = "claude-wv-popover-badge";
        Object.assign(badge.style, {
          fontSize: "10px",
          padding: "1px 5px",
          borderRadius: "3px",
          background: "var(--background-modifier-border)",
          color: "var(--text-muted)",
          textTransform: "uppercase",
          flex: "0 0 auto",
        } as CSSStyleDeclaration);
        badge.textContent = item.badge;
        row.appendChild(badge);
      }

      if (item.description) {
        const desc = doc.createElement("small");
        desc.className = "claude-wv-popover-description";
        Object.assign(desc.style, {
          color: "var(--text-muted)",
          flex: "1 1 auto",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        } as CSSStyleDeclaration);
        desc.textContent = item.description;
        row.appendChild(desc);
      }

      // mousedown (NOT click) so the textarea doesn't lose focus before
      // we react. preventDefault on mousedown blocks the focus shift.
      row.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        if (disposed) return;
        opts.onSelect(item);
      });
      row.addEventListener("mouseenter", () => {
        if (disposed) return;
        if (selectedIndex !== i) {
          selectedIndex = i;
          render();
        }
      });

      root.appendChild(row);
    });

    reposition();
  };

  const update = (items: readonly PopoverItem[]): void => {
    if (disposed) return;
    currentItems = items;
    selectedIndex = items.length > 0 ? 0 : 0;
    render();
  };

  const onKeydown = (e: KeyboardEvent): void => {
    if (disposed) return;
    switch (e.key) {
      case "ArrowDown":
        if (currentItems.length > 0) {
          selectedIndex = (selectedIndex + 1) % currentItems.length;
          render();
          e.preventDefault();
        }
        return;
      case "ArrowUp":
        if (currentItems.length > 0) {
          selectedIndex =
            (selectedIndex - 1 + currentItems.length) % currentItems.length;
          render();
          e.preventDefault();
        }
        return;
      case "Enter": {
        const picked = currentItems[selectedIndex];
        if (picked) {
          e.preventDefault();
          opts.onSelect(picked);
        }
        return;
      }
      case "Escape":
        e.preventDefault();
        opts.onDismiss?.();
        return;
      default:
        return;
    }
  };

  const onMousedownOutside = (e: MouseEvent): void => {
    if (disposed) return;
    const target = e.target as Node | null;
    if (!target) return;
    if (root.contains(target)) return;
    if (target === opts.anchor || opts.anchor.contains(target)) return;
    opts.onDismiss?.();
  };

  // capture: true so we win against listeners that the textarea or
  // input-bar registered for ArrowUp / ArrowDown / Enter.
  opts.anchor.addEventListener("keydown", onKeydown, { capture: true });
  doc.addEventListener("mousedown", onMousedownOutside);
  win.addEventListener("resize", reposition);
  win.addEventListener("scroll", reposition, true);

  update(opts.items);

  return {
    update(items) {
      update(items);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      opts.anchor.removeEventListener("keydown", onKeydown, {
        capture: true,
      } as EventListenerOptions);
      doc.removeEventListener("mousedown", onMousedownOutside);
      win.removeEventListener("resize", reposition);
      win.removeEventListener("scroll", reposition, true);
      root.remove();
    },
    isOpen() {
      return !disposed;
    },
  };
}
