import { App, Notice, type TFile } from "obsidian";
import type { ILinkHandler, IBufferRange } from "@xterm/xterm";

// Match obsidian://open?... only. Other subcommands (e.g. shell-command) are intentionally rejected.
// Pattern mirrors the safe-character set used by xterm's strict URL regex.
export const OBSIDIAN_OPEN_URL_REGEX =
  /obsidian:\/\/open\?[^\s"'!*(){}|\\\^<>`]*[^\s"':,.!?{}|\\\^~\[\]`()<>]/;

const ALLOWED_HOSTS = new Set(["open"]);

function openObsidianUri(app: App, uri: string, requireModifier: boolean, event?: MouseEvent): void {
  if (requireModifier && !(event?.metaKey || event?.ctrlKey)) return;

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    new Notice("Invalid Obsidian link");
    return;
  }

  if (!ALLOWED_HOSTS.has(parsed.host)) {
    new Notice(`Blocked: only obsidian://open is allowed (got ${parsed.host || "unknown"})`);
    return;
  }

  const path = parsed.searchParams.get("path");
  if (!path) {
    new Notice("Obsidian link missing 'path' parameter");
    return;
  }

  const target: TFile | null = app.metadataCache.getFirstLinkpathDest(path, "");
  if (!target) {
    new Notice(`Note not found in vault: ${path}`);
    return;
  }

  void app.workspace.openLinkText(target.path, "", false);
}

export function createObsidianLinkHandler(app: App): (event: MouseEvent, uri: string) => void {
  return (event: MouseEvent, uri: string): void => {
    openObsidianUri(app, uri, true, event);
  };
}

/**
 * ILinkHandler for xterm's native OSC 8 hyperlink support. The terminal
 * parses `\x1b]8;;URL\x1b\\TEXT\x1b]8;;\x1b\\` and calls `activate` with the
 * URL when the user clicks the rendered TEXT. We only activate non-obsidian
 * schemes — obsidian:// is gated on the modifier key to match the existing
 * Cmd/Ctrl+click UX.
 */
export function createObsidianOsc8LinkHandler(app: App): ILinkHandler {
  return {
    activate(event: MouseEvent, text: string, _range: IBufferRange): void {
      if (text.startsWith("obsidian://")) {
        openObsidianUri(app, text, true, event);
        return;
      }
      // Non-obsidian hyperlinks (e.g. http/https) — open normally.
      if (typeof window !== "undefined" && typeof window.open === "function") {
        try {
          window.open(text, "_blank");
        } catch {
          // ignore
        }
      }
    },
  };
}
