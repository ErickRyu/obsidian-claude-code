// Transforms markdown-style obsidian links in PTY output into OSC 8
// hyperlink escape sequences so the raw URL stays hidden from the terminal
// display while remaining clickable via xterm.js's native linkHandler.
//
//   before:  [name](obsidian://open?vault=v&path=a.md)
//   after:   ESC]8;;obsidian://open?vault=v&path=a.md ESC\ name ESC]8;; ESC\
//
// PTY data arrives in arbitrary chunks, so a trailing partial match (e.g. a
// chunk ending in `[name](obsid`) is buffered and re-joined with the next
// chunk. The buffer is bounded — if the partial never completes within
// MAX_BUFFER chars we flush it as plain text and move on.

const OSC = "\x1b]";
const ST = "\x1b\\";

// Matches a complete markdown link whose target is obsidian://open?...
// Group 1: visible text, Group 2: URL.
const COMPLETE_LINK_RE = /\[([^\]\n]+)\]\((obsidian:\/\/open\?[^)\s]*)\)/g;

// Maximum chars held across chunks while waiting for a link to close.
// Beyond this we flush and give up — prevents unbounded growth on noisy input.
const MAX_BUFFER = 4096;

export class ObsidianLinkTransform {
  private buffer = "";

  /**
   * Transform a chunk of PTY output. Returns the transformed string to write
   * to xterm. May hold trailing bytes internally if the chunk ends mid-link.
   */
  transform(chunk: string): string {
    const combined = this.buffer + chunk;
    this.buffer = "";

    const splitAt = this.findPartialLinkStart(combined);

    let processable: string;
    if (splitAt !== null && combined.length - splitAt <= MAX_BUFFER) {
      processable = combined.slice(0, splitAt);
      this.buffer = combined.slice(splitAt);
    } else {
      processable = combined;
    }

    return processable.replace(
      COMPLETE_LINK_RE,
      (_, text: string, url: string) => `${OSC}8;;${url}${ST}${text}${OSC}8;;${ST}`
    );
  }

  /**
   * Flush any buffered bytes without transforming. Call on dispose to avoid
   * losing pending output.
   */
  flush(): string {
    const remaining = this.buffer;
    this.buffer = "";
    return remaining;
  }

  /**
   * Walk backwards looking for an unbalanced `[` that could still grow into a
   * markdown link. Returns the index to hold from, or null if nothing to hold.
   *
   * Heuristic: anything after the last `\n`, `)`, or a standalone `]` that
   * isn't followed by `(` is considered potentially-complete. We only buffer
   * when we see a `[` without its closing `)` yet, because that's the only
   * shape that could still become `[text](obsidian://...)`.
   */
  private findPartialLinkStart(s: string): number | null {
    // Scan the tail only — a link can't span a newline because the visible
    // text part forbids newlines.
    const lastNewline = s.lastIndexOf("\n");
    const tailStart = lastNewline + 1;
    const tail = s.slice(tailStart);

    // Find the last `[` in the tail that hasn't been closed by `)`.
    let lastOpen = -1;
    for (let i = tail.length - 1; i >= 0; i--) {
      const ch = tail[i];
      if (ch === ")") return null; // tail ends with a closed group — nothing partial
      if (ch === "[") {
        lastOpen = i;
        break;
      }
    }
    if (lastOpen < 0) return null;

    // If the segment from `[` to end already contains a complete match, no
    // need to hold — the regex will consume it.
    const segment = tail.slice(lastOpen);
    COMPLETE_LINK_RE.lastIndex = 0;
    if (COMPLETE_LINK_RE.test(segment)) {
      COMPLETE_LINK_RE.lastIndex = 0;
      return null;
    }

    // Require at least a hint that this `[` is heading toward an obsidian
    // link — otherwise we'd hold every `[` in normal output. We accept:
    //   - `[` alone (could become `[text](obsidian://...)`)
    //   - `[text`
    //   - `[text]`
    //   - `[text](`
    //   - `[text](obsid…` (partial URL scheme)
    // We REJECT `[text](http…)` etc. — those aren't our concern.
    const afterBracket = segment.slice(1);
    const bracketClose = afterBracket.indexOf("]");
    if (bracketClose >= 0) {
      const afterClose = afterBracket.slice(bracketClose + 1);
      if (afterClose.startsWith("(")) {
        const urlPart = afterClose.slice(1);
        // URL has started — only hold if it's still compatible with
        // `obsidian://open?` prefix.
        if (!"obsidian://open?".startsWith(urlPart) && !urlPart.startsWith("obsidian://open?")) {
          return null;
        }
      } else if (afterClose.length > 0) {
        // `]` followed by something other than `(` — not a link.
        return null;
      }
    }

    return tailStart + lastOpen;
  }
}
