/**
 * / slash command trigger.
 *
 * Opens an inline popover when `/` is the first character in an otherwise
 * empty textarea. Sources merged on every popover update:
 *   - CLI builtins reported via `system.init.slash_commands`
 *   - User vault commands in `<vault>/.claude/commands/*.md`
 *   - Global commands in `~/.claude/commands/*.md`
 *
 * On select, the textarea becomes `/<name> ` so the user can add args
 * before pressing Enter (no auto-execution — `/clear` etc. shouldn't
 * fire from a single keystroke + click).
 */

import type { PopoverItem, InlinePopoverHandle } from "./inline-popover";

export type SlashCommandSource = "cli" | "user" | "global";

export interface SlashCommand {
  readonly name: string;
  readonly source: SlashCommandSource;
  readonly description?: string;
}

export interface SlashCommandSourceProvider {
  list(): SlashCommand[];
}

/**
 * Merges CLI builtin command names + user (vault) commands + global
 * (`~/.claude/commands`) commands into a single deduped, sorted list.
 * Earlier sources win on name collision: cli > user > global.
 */
export function mergeSlashCommands(
  cli: readonly string[],
  user: readonly SlashCommand[],
  global: readonly SlashCommand[] = [],
): SlashCommand[] {
  const seen = new Set<string>();
  const out: SlashCommand[] = [];
  for (const name of cli) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, source: "cli" });
  }
  for (const c of user) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push(c);
  }
  for (const c of global) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push(c);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Returns true if a fresh `/` keystroke at the start of an otherwise
 * empty textarea should open the popover.
 */
export function isFreshSlashTrigger(
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
  if ("data" in ie && ie.data !== undefined && ie.data !== "/") return false;

  const value = textarea.value;
  if (value.length !== 1) return false;
  if (value[0] !== "/") return false;
  return true;
}

/**
 * Returns the running slash token if the textarea begins with `/` and
 * the cursor is still inside the command-name region (no whitespace yet).
 * The query is everything after `/` up to the cursor.
 */
export function findActiveSlashToken(
  textarea: HTMLTextAreaElement,
): { query: string } | null {
  const value = textarea.value;
  if (value.length === 0) return null;
  if (value[0] !== "/") return null;
  const cursor = textarea.selectionStart ?? value.length;
  const beforeCursor = value.slice(0, cursor);
  if (/\s/.test(beforeCursor)) return null;
  return { query: beforeCursor.slice(1) };
}

/**
 * Replaces the textarea contents with `/<name> ` (with trailing space so
 * the user types args next).
 */
export function applySlashCommand(
  textarea: HTMLTextAreaElement,
  name: string,
): void {
  textarea.value = `/${name} `;
  const pos = textarea.value.length;
  textarea.selectionStart = pos;
  textarea.selectionEnd = pos;
  textarea.focus();

  const EventCtor: typeof Event =
    (textarea.ownerDocument?.defaultView as unknown as { Event: typeof Event } | null)
      ?.Event ?? Event;
  textarea.dispatchEvent(new EventCtor("input", { bubbles: true }));
}

export interface SlashMenuRuntime {
  readonly textarea: HTMLTextAreaElement;
  /** Returns popover items for the current query. */
  readonly searchCommands: (query: string) => PopoverItem[];
  /** Mounts the popover. */
  readonly openPopover: (
    items: readonly PopoverItem[],
    onSelect: (item: PopoverItem) => void,
    onDismiss: () => void,
  ) => InlinePopoverHandle;
}

/**
 * Returns a driver hooked into the textarea's `input` event. The driver
 * opens the popover on a fresh `/` and updates / closes it as the user
 * keeps typing.
 */
export function createSlashMenuDriver(runtime: SlashMenuRuntime): {
  onInput: (e: Event) => void;
  dispose: () => void;
} {
  let popover: InlinePopoverHandle | null = null;

  const close = (): void => {
    if (popover) {
      popover.dispose();
      popover = null;
    }
  };

  const open = (query: string): void => {
    const items = runtime.searchCommands(query);
    popover = runtime.openPopover(
      items,
      (item) => {
        const name = String(item.metadata ?? item.label.replace(/^\//, ""));
        applySlashCommand(runtime.textarea, name);
        close();
      },
      () => close(),
    );
  };

  const onInput = (e: Event): void => {
    const ta = runtime.textarea;
    const token = findActiveSlashToken(ta);

    if (popover) {
      if (!token) {
        close();
        return;
      }
      popover.update(runtime.searchCommands(token.query));
      return;
    }

    if (!isFreshSlashTrigger(ta, e)) return;
    if (!token) return;
    open(token.query);
  };

  return { onInput, dispose: close };
}

/**
 * Reads `~/.claude/commands/*.md`. Returns SlashCommand entries with the
 * first non-empty, non-frontmatter line as description. All errors
 * (folder missing, permission denied, malformed file) are silenced and
 * yield an empty list.
 *
 * Uses Node's `fs/promises` — safe under Obsidian desktop, not under
 * happy-dom unit tests (which simply get [] from the catch).
 */
export async function listGlobalSlashCommands(
  homeDir: string | undefined = typeof process !== "undefined"
    ? process.env.HOME ?? process.env.USERPROFILE
    : undefined,
): Promise<SlashCommand[]> {
  if (!homeDir) {
    // eslint-disable-next-line no-console
    console.warn("[claude-webview] listGlobalSlashCommands: no HOME env");
    return [];
  }
  let fsP: typeof import("node:fs/promises");
  let pathMod: typeof import("node:path");
  try {
    fsP = await import("node:fs/promises");
    pathMod = await import("node:path");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[claude-webview] listGlobalSlashCommands: node module load failed:", err);
    return [];
  }
  const dir = pathMod.join(homeDir, ".claude", "commands");
  let entries: string[];
  try {
    entries = await fsP.readdir(dir);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[claude-webview] listGlobalSlashCommands: readdir(${dir}) failed:`, err);
    return [];
  }
  const out: SlashCommand[] = [];
  for (const file of entries) {
    if (!file.endsWith(".md")) continue;
    const name = file.replace(/\.md$/, "");
    let description: string | undefined;
    try {
      const content = await fsP.readFile(pathMod.join(dir, file), "utf-8");
      const firstLine = content
        .split("\n")
        .find((l) => l.trim().length > 0 && !l.trim().startsWith("---"));
      if (firstLine) description = firstLine.trim().replace(/^#\s*/, "").slice(0, 200);
    } catch {
      // Skip — emit the command name without a description.
    }
    out.push({ name, source: "global", description });
  }
  return out;
}
