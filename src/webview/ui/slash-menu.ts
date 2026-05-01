/**
 * Slash command menu — Phase 3 UX input bar enhancement.
 *
 * Two sections:
 *   1. Pure helpers (testable under happy-dom):
 *      - SlashCommand / SlashCommandSource / SlashMenuDeps interfaces
 *      - shouldTriggerSlash(textarea, e) — guard predicate
 *      - handleSlashKey(deps, e) — intercept + open modal
 *      - mergeSlashCommands(cli, user) — dedupe + sort
 *
 *   2. Obsidian-coupled class (NOT tested under happy-dom):
 *      - SlashCommandModal extends SuggestModal<SlashCommand>
 *
 * Trigger rule: only fire when the textarea is completely empty AND the user
 * presses "/" with no modifier keys and outside IME composition.
 * This avoids false positives when typing paths like "path/to/file".
 *
 * Safety: selecting a command WRITES the text to the textarea (/<name> ) but
 * does NOT auto-submit. The user must press Cmd/Ctrl+Enter explicitly. This
 * prevents accidental execution of destructive commands like /clear.
 */
import { App, SuggestModal, prepareFuzzySearch } from "obsidian";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface SlashCommand {
  readonly name: string;
  readonly source: "cli" | "user";
  readonly description?: string;
}

export interface SlashCommandSource {
  list(): SlashCommand[];
}

export interface SlashMenuDeps {
  readonly textarea: HTMLTextAreaElement;
  readonly source: SlashCommandSource;
  readonly openModal: (
    items: readonly SlashCommand[],
    onSelect: (cmd: SlashCommand) => void,
    onDismiss: () => void
  ) => void;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Returns true iff the keyboard event should trigger the slash command menu.
 * Conditions (all must be true):
 *   - e.key === "/"
 *   - textarea.value.length === 0
 *   - !e.isComposing
 *   - !e.metaKey && !e.ctrlKey && !e.altKey
 */
export function shouldTriggerSlash(
  textarea: HTMLTextAreaElement,
  e: KeyboardEvent
): boolean {
  if (e.key !== "/") return false;
  if (textarea.value.length !== 0) return false;
  if (e.isComposing) return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  return true;
}

/**
 * Handles a keydown event that may be a slash trigger.
 * Returns true if the event was intercepted (openModal was called).
 *
 * Side effects when intercepted:
 *   - e.preventDefault() is called
 *   - openModal is called with the current source.list() result
 *   - onSelect writes "/<cmd.name> " to the textarea, dispatches "input"
 *   - onDismiss writes "/" to the textarea, dispatches "input"
 */
export function handleSlashKey(deps: SlashMenuDeps, e: KeyboardEvent): boolean {
  if (!shouldTriggerSlash(deps.textarea, e)) return false;

  e.preventDefault();

  const items = deps.source.list();
  let selected = false;

  const dispatchInputEvent = (ta: HTMLTextAreaElement): void => {
    // Use the document's Event constructor to stay in the same DOM context.
    // In happy-dom, the global `Event` is different from the document-scoped one,
    // so we use `ta.ownerDocument.createEvent` to create a compatible event.
    const doc = ta.ownerDocument;
    if (doc && typeof doc.createEvent === "function") {
      const ev = doc.createEvent("Event");
      ev.initEvent("input", true, false);
      ta.dispatchEvent(ev);
    }
  };

  const onSelect = (cmd: SlashCommand): void => {
    selected = true;
    deps.textarea.value = `/${cmd.name} `;
    // Place cursor at end
    const len = deps.textarea.value.length;
    try {
      deps.textarea.setSelectionRange(len, len);
    } catch {
      // Ignore — happy-dom may not fully implement setSelectionRange.
    }
    dispatchInputEvent(deps.textarea);
  };

  const onDismiss = (): void => {
    if (selected) return; // Already handled by onSelect path.
    deps.textarea.value = "/";
    const len = deps.textarea.value.length;
    try {
      deps.textarea.setSelectionRange(len, len);
    } catch {
      // Ignore.
    }
    dispatchInputEvent(deps.textarea);
  };

  deps.openModal(items, onSelect, onDismiss);
  return true;
}

/**
 * Merges CLI builtin commands and user-defined commands into a single sorted
 * deduplicated list.
 *
 * Deduplication rule: when CLI and user share the same name, CLI wins.
 * Result is sorted alphabetically by name.
 */
export function mergeSlashCommands(
  cli: readonly string[],
  user: readonly SlashCommand[]
): SlashCommand[] {
  // Build map from name → command; user commands go in first, then CLI
  // overwrites on conflict (so CLI always wins).
  const map = new Map<string, SlashCommand>();

  for (const cmd of user) {
    if (!map.has(cmd.name)) {
      map.set(cmd.name, cmd);
    }
  }

  for (const name of cli) {
    // CLI always wins — overwrite any user entry with the same name.
    map.set(name, { name, source: "cli" });
  }

  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Obsidian-coupled modal (not testable under happy-dom)
// ---------------------------------------------------------------------------

/**
 * SuggestModal that lists slash commands with fuzzy filtering.
 *
 * Constructor params:
 *   app       — Obsidian App instance
 *   items     — full slash command list (already merged + sorted)
 *   onSelect  — called when user picks a command
 *   onDismiss — called when user presses Esc without selecting
 */
export class SlashCommandModal extends SuggestModal<SlashCommand> {
  private readonly items: readonly SlashCommand[];
  private readonly _onSelect: (cmd: SlashCommand) => void;
  private readonly _onDismiss: () => void;
  private didSelect = false;

  constructor(
    app: App,
    items: readonly SlashCommand[],
    onSelect: (cmd: SlashCommand) => void,
    onDismiss: () => void
  ) {
    super(app);
    this.items = items;
    this._onSelect = onSelect;
    this._onDismiss = onDismiss;
    this.setPlaceholder("Type to filter slash commands…");
  }

  getSuggestions(query: string): SlashCommand[] {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return [...this.items];

    const fuzzy = prepareFuzzySearch(q);
    return this.items.filter((cmd) => {
      if (fuzzy(cmd.name)) return true;
      if (cmd.description && fuzzy(cmd.description)) return true;
      return false;
    });
  }

  renderSuggestion(cmd: SlashCommand, el: HTMLElement): void {
    el.addClass("claude-wv-slash-item");

    const nameEl = el.createEl("span", { cls: "claude-wv-slash-name" });
    nameEl.textContent = `/${cmd.name}`;

    const sourceEl = el.createEl("small", { cls: "claude-wv-slash-source" });
    sourceEl.textContent = `[${cmd.source}]`;

    const descEl = el.createEl("small", { cls: "claude-wv-slash-desc" });
    descEl.textContent = cmd.description ?? "";
  }

  onChooseSuggestion(cmd: SlashCommand, _evt: MouseEvent | KeyboardEvent): void {
    this.didSelect = true;
    this._onSelect(cmd);
  }

  onClose(): void {
    super.onClose();
    if (!this.didSelect) {
      this._onDismiss();
    }
  }
}
