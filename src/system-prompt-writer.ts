import * as fs from "fs";
import * as path from "path";
import { MCP_PROMPT_FILE } from "./constants";

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
 * Owns the `obsidian-prompt.txt` file that is handed to the claude CLI via
 * `--append-system-prompt-file`. Writes are atomic (temp + rename) so the CLI
 * never sees a partially-written file at spawn time. The writer is always
 * present whenever the plugin is loaded, regardless of MCP state, so Cmd+Click
 * URL instructions reach Claude even when MCP is disabled.
 */
export class SystemPromptWriter {
  private readonly promptFilePath: string;

  constructor(pluginDir: string, private readonly getVaultName: () => string) {
    this.promptFilePath = path.join(pluginDir, MCP_PROMPT_FILE);
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
    const lines = [
      ...contextLines,
      ...buildObsidianLinkInstruction(this.getVaultName()),
    ];
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
