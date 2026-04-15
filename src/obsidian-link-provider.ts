import { App, Notice, type TFile } from "obsidian";

// Match obsidian://open?... only. Other subcommands (e.g. shell-command) are intentionally rejected.
// Pattern mirrors the safe-character set used by xterm's strict URL regex.
export const OBSIDIAN_OPEN_URL_REGEX =
  /obsidian:\/\/open\?[^\s"'!*(){}|\\\^<>`]*[^\s"':,.!?{}|\\\^~\[\]`()<>]/;

const ALLOWED_HOSTS = new Set(["open"]);

export function createObsidianLinkHandler(app: App): (event: MouseEvent, uri: string) => void {
  return (event: MouseEvent, uri: string): void => {
    if (!event.metaKey && !event.ctrlKey) return;

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
  };
}
