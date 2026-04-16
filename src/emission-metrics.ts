// Session-scoped, in-memory counters for how Claude's terminal output
// formatted references to vault notes. The purpose is to verify the premise
// behind Cmd+Click — that Claude follows the system-prompt instruction and
// emits clickable `obsidian://open?...` URLs. If bare URLs or raw paths
// dominate, the instruction is not working and we need to escalate (stronger
// prompt, MCP `open_note` tool, etc).
//
// No persistence. No telemetry beacon. Values are kept in-process and logged
// to the developer console on plugin unload. Counters increment AT MOST once
// per emission site (we do not try to count characters or dedupe across
// terminals).

/** What we observed in a given chunk / buffer line. */
export interface EmissionReport {
  linkMarkdownEmitted: number;
  linkBareUrlEmitted: number;
  vaultPathMentioned: number;
}

export class EmissionMetrics {
  linkMarkdownEmitted = 0;
  linkBareUrlEmitted = 0;
  vaultPathMentioned = 0;

  /** Increment the counter for `[text](obsidian://open?...)` links. */
  recordMarkdownLink(count = 1): void {
    this.linkMarkdownEmitted += count;
  }

  /** Increment the counter for raw `obsidian://open?...` URLs. */
  recordBareUrl(count = 1): void {
    this.linkBareUrlEmitted += count;
  }

  /** Increment when a raw vault-relative path resolves to a real note. */
  recordVaultPathMentioned(count = 1): void {
    this.vaultPathMentioned += count;
  }

  snapshot(): EmissionReport {
    return {
      linkMarkdownEmitted: this.linkMarkdownEmitted,
      linkBareUrlEmitted: this.linkBareUrlEmitted,
      vaultPathMentioned: this.vaultPathMentioned,
    };
  }

  /**
   * Log the current ratios to the developer console. Silent when no emissions
   * were recorded — avoids noisy "0 / 0 / 0" in sessions that never produced
   * a vault reference (e.g. a short session about unrelated topics).
   */
  report(): void {
    const total =
      this.linkMarkdownEmitted +
      this.linkBareUrlEmitted +
      this.vaultPathMentioned;
    if (total === 0) return;

    const clickableShare =
      (this.linkMarkdownEmitted + this.linkBareUrlEmitted) / total;
    const markdownShare = this.linkMarkdownEmitted / total;

    console.log("[obsidian-claude-code] emission compliance", {
      markdown: this.linkMarkdownEmitted,
      bare: this.linkBareUrlEmitted,
      rawPath: this.vaultPathMentioned,
      total,
      clickableShare: Number(clickableShare.toFixed(3)),
      markdownShare: Number(markdownShare.toFixed(3)),
    });
  }
}
