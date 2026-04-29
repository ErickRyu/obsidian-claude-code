import * as fs from "fs";
import * as path from "path";
import { MCP_PROMPT_FILE } from "./constants";

/**
 * Selects which link syntax the prompt teaches Claude to emit.
 *
 * - `"url"` (default — terminal mode): `[name](obsidian://open?vault=…&path=…)`
 *   so xterm.js's OSC 8 hyperlink transform can hand the URL to the OS.
 * - `"wikilink"` (webview mode): `[[basename]]` so Obsidian's
 *   `MarkdownRenderer.render` resolves it inside the host vault — no vault
 *   name lookup, no URL-encoding pitfalls. Terminal can't open `[[…]]`
 *   on click, hence the per-mode split. (2026-04-29 dogfood: a vault
 *   without a `name` field in `~/Library/Application Support/obsidian/obsidian.json`
 *   produced "Vault not found" for every URL Claude emitted.)
 */
export type ObsidianLinkStyle = "url" | "wikilink";

/**
 * Builds the system-prompt instruction that teaches Claude to emit clickable
 * `obsidian://open?vault=...&path=...` URLs. Kept as a pure function so it can
 * be reused outside the writer (e.g. tests, future variants).
 */
export function buildObsidianLinkInstruction(vaultName: string): string[] {
  const encoded = encodeURIComponent(vaultName);
  return [
    "",
    "When you reference a vault note in your reply, format it as an Obsidian URL so the user can Cmd/Ctrl+click it:",
    `  [<basename>](obsidian://open?vault=${encoded}&path=<url-encoded-vault-relative-path-with-extension>)`,
    `Example: [llm-strategic-bias](obsidian://open?vault=${encoded}&path=personal-wiki%2Fconcepts%2Fllm-strategic-bias.md)`,
    "Use this format only for files that exist in the user's vault. Always include the file extension.",
    "CRITICAL: percent-encode the entire path. Spaces must become %20, Korean and other non-ASCII chars must be encodeURIComponent'd. A literal space in the URL breaks click handling when the line wraps in the sidebar.",
  ];
}

/**
 * Builds the system-prompt instruction for webview mode, where the host
 * `MarkdownRenderer.render` resolves `[[basename]]` against the same vault
 * the plugin runs in. Vault-name-free, encoding-free — the renderer does
 * the lookup via `app.metadataCache.getFirstLinkpathDest`.
 */
export function buildWikilinkInstruction(): string[] {
  return [
    "",
    "When you reference a vault note in your reply, format it as an Obsidian wikilink so the user can click it:",
    "  [[<vault-relative-path-without-extension>]]",
    "Examples:",
    "  [[ep10-smartviz]]                              (unambiguous basename)",
    "  [[walkandtalk-wiki/sources/ep10-smartviz]]    (when the basename collides)",
    "Use this format only for files that exist in the user's vault. Do NOT include the .md extension and do NOT URL-encode anything — Obsidian resolves the link against the active vault directly.",
    "Wikilinks render as native Obsidian links: clicking them opens the note in the same window, and Cmd/Ctrl+click opens it in a new pane.",
  ];
}

/**
 * Owns the `obsidian-prompt.txt` file that is handed to the claude CLI via
 * `--append-system-prompt-file`. Writes are atomic (temp + rename) so the CLI
 * never sees a partially-written file at spawn time. The writer is always
 * present whenever the plugin is loaded, regardless of MCP state, so Cmd+Click
 * URL instructions reach Claude even when MCP is disabled.
 */
export class SystemPromptWriter {
  private readonly promptFilePath: string;
  private readonly getLinkStyle: () => ObsidianLinkStyle;

  /**
   * `getLinkStyle` is called on every write so a runtime uiMode toggle
   * (terminal ↔ webview) is reflected in the next prompt regenerate.
   * Defaults to `"url"` to preserve the v0.5.x terminal behavior for
   * any existing caller that does not pass the third argument.
   */
  constructor(
    pluginDir: string,
    private readonly getVaultName: () => string,
    getLinkStyle?: () => ObsidianLinkStyle,
  ) {
    this.promptFilePath = path.join(pluginDir, MCP_PROMPT_FILE);
    this.getLinkStyle = getLinkStyle ?? (() => "url");
  }

  getPromptFilePath(): string {
    return this.promptFilePath;
  }

  /** Baseline state: URL instruction only, no context. */
  writeBase(): void {
    this.write([]);
  }

  /** Context-augmented state: MCP-provided context lines, then URL instruction. */
  writeWithContext(contextLines: string[]): void {
    this.write(contextLines);
  }

  /** Called from plugin onunload. */
  dispose(): void {
    try {
      fs.unlinkSync(this.promptFilePath);
    } catch {
      // Missing is fine.
    }
  }

  private write(contextLines: string[]): void {
    const linkLines =
      this.getLinkStyle() === "wikilink"
        ? buildWikilinkInstruction()
        : buildObsidianLinkInstruction(this.getVaultName());
    const lines = [...contextLines, ...linkLines];
    const tmp = `${this.promptFilePath}.tmp`;
    try {
      fs.writeFileSync(tmp, lines.join("\n") + "\n");
      fs.renameSync(tmp, this.promptFilePath);
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // best effort
      }
    }
  }
}
