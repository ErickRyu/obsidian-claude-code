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

export type SlashCommandSource = "cli" | "user" | "global" | "plugin";

export interface SlashCommand {
  readonly name: string;
  readonly source: SlashCommandSource;
  readonly description?: string;
}

export interface SlashCommandSourceProvider {
  list(): SlashCommand[];
}

/**
 * Merges command sources into a single deduped, sorted list.
 *   - `cli` — CLI builtin command names from `system.init.slash_commands`.
 *   - `user` — vault `.claude/commands/*.md` (typed as full SlashCommand
 *     so caller can provide descriptions + `source: "user"`).
 *   - `global` — caller-supplied tail. Used in production for the union
 *     of `~/.claude/commands/*.md` (`source: "global"`) and plugin
 *     discoveries (`source: "plugin"`); both flow in through this slot
 *     so each entry's own `source` field is preserved on output.
 * Earlier sources win on name collision: cli > user > (global ∪ plugin).
 * Output sorted alphabetically by name.
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
 * Reads `~/.claude/plugins/installed_plugins.json` and discovers every
 * installed plugin's `commands/*.md` files and `skills/<dir>/` folders.
 * This mirrors what Claude CLI assembles into `system.init.slash_commands`,
 * but without needing the CLI to spawn first. The CLI only emits
 * `system.init` after the user's first prompt — without filesystem
 * discovery the popover would be empty until a message is sent.
 */
export async function listPluginCommandsAndSkills(
  homeDir: string | undefined = typeof process !== "undefined"
    ? process.env.HOME ?? process.env.USERPROFILE
    : undefined,
): Promise<SlashCommand[]> {
  if (!homeDir) return [];
  let fsP: typeof import("node:fs/promises");
  let pathMod: typeof import("node:path");
  try {
    fsP = (globalThis as unknown as { require: NodeRequire }).require("fs/promises");
    pathMod = (globalThis as unknown as { require: NodeRequire }).require("path");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[claude-webview] listPluginCommandsAndSkills: require failed:", err);
    return [];
  }

  const installedJsonPath = pathMod.join(
    homeDir,
    ".claude",
    "plugins",
    "installed_plugins.json",
  );
  let manifest: { plugins?: Record<string, Array<{ installPath?: string }>> };
  try {
    const raw = await fsP.readFile(installedJsonPath, "utf-8");
    manifest = JSON.parse(raw);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[claude-webview] listPluginCommandsAndSkills: read installed_plugins.json failed:",
      err,
    );
    return [];
  }

  const plugins = manifest.plugins ?? {};
  const out: SlashCommand[] = [];
  const seen = new Set<string>();

  const pushIfNew = (name: string, description?: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push({ name, source: "plugin", description });
  };

  for (const instances of Object.values(plugins)) {
    if (!Array.isArray(instances)) continue;
    for (const inst of instances) {
      const installPath = inst?.installPath;
      if (!installPath || typeof installPath !== "string") continue;

      // commands/*.md
      try {
        const cmdsDir = pathMod.join(installPath, "commands");
        const entries = await fsP.readdir(cmdsDir);
        for (const f of entries) {
          if (!f.endsWith(".md")) continue;
          let description: string | undefined;
          try {
            const content = await fsP.readFile(pathMod.join(cmdsDir, f), "utf-8");
            const firstLine = content
              .split("\n")
              .find((l) => l.trim().length > 0 && !l.trim().startsWith("---"));
            if (firstLine) description = firstLine.trim().replace(/^#\s*/, "").slice(0, 200);
          } catch {
            /* ignore */
          }
          pushIfNew(f.replace(/\.md$/, ""), description);
        }
      } catch {
        /* commands/ may not exist */
      }

      // skills/<dir>/
      try {
        const skillsDir = pathMod.join(installPath, "skills");
        const entries = await fsP.readdir(skillsDir, { withFileTypes: true });
        for (const ent of entries) {
          if (!ent.isDirectory()) continue;
          let description: string | undefined;
          try {
            const skillMd = pathMod.join(skillsDir, ent.name, "SKILL.md");
            const content = await fsP.readFile(skillMd, "utf-8");
            // Try to grab description from frontmatter or first prose line.
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
            if (fmMatch) {
              const desc = fmMatch[1]
                .split("\n")
                .find((l) => l.startsWith("description:"));
              if (desc) {
                description = desc
                  .replace(/^description:\s*/, "")
                  .trim()
                  .slice(0, 200);
              }
            }
            if (!description) {
              const firstLine = content
                .split("\n")
                .find((l) => l.trim().length > 0 && !l.trim().startsWith("---"));
              if (firstLine) {
                description = firstLine.trim().replace(/^#\s*/, "").slice(0, 200);
              }
            }
          } catch {
            /* ignore */
          }
          pushIfNew(ent.name, description);
        }
      } catch {
        /* skills/ may not exist */
      }
    }
  }
  return out;
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
  // Use require() rather than dynamic import: the plugin bundle is CJS,
  // and Obsidian's Electron renderer can resolve `fs/promises` via the
  // CommonJS loader but NOT via ESM dynamic import (which would require
  // `node:` prefix and an experimental flag). esbuild leaves this require
  // call alone because we marked node-pty / electron / obsidian as
  // external — bare module specifiers are still bundled, but Node
  // builtins resolve through the runtime require regardless.
  let fsP: typeof import("node:fs/promises");
  let pathMod: typeof import("node:path");
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    fsP = (globalThis as unknown as { require: NodeRequire }).require("fs/promises");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    pathMod = (globalThis as unknown as { require: NodeRequire }).require("path");
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
