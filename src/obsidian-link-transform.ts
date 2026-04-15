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
//
// When an `EmissionMetrics` collector is supplied, the transformer also
// bumps the `linkMarkdownEmitted` counter once per wrapped markdown link,
// which the plugin logs at session end to gauge whether Claude follows the
// system-prompt format.

import type { EmissionMetrics } from "./emission-metrics";

const OSC = "\x1b]";
const ST = "\x1b\\";

// Matches a complete markdown link whose target is obsidian://open?...
// Group 1: visible text, Group 2: URL.
// The negative lookbehind `(?<!\x1b)` rejects `[` that is part of an ANSI
// CSI sequence (\x1b[...), which otherwise causes the regex to greedily
// swallow terminal output from the CSI all the way to the real link.
const COMPLETE_LINK_RE = /(?<!\x1b)\[([^\]\n\x1b]+)\]\((obsidian:\/\/open\?[^)\s]*)\)/g;

// Matches a bare obsidian://open?... URL that Claude emitted without the
// markdown `[text](url)` wrapper. Terminates at whitespace, closing
// paren/bracket, quote, or angle. Negative lookbehind `(?<!\x1b\]8;;)`
// prevents matching a URL that is already embedded inside an OSC 8 hyperlink
// from the markdown pass (or from upstream output).
const BARE_URL_RE =
  /(?<!\x1b\]8;;)(obsidian:\/\/open\?[^\s)\]"'<>\x1b]+)/g;

// Shortest `obsidian://open?` prefix we treat as "possibly starting a bare
// URL" at a chunk tail. Below 5 chars (`obsid`) buffering triggers on far
// too many plain words beginning with `o`, `ob`, `obs`, `obsi`.
const BARE_URL_PREFIX = "obsidian://open?";
const MIN_BARE_PREFIX = 5;

// Maximum chars held across chunks while waiting for a link to close.
// Beyond this we flush and give up — prevents unbounded growth on noisy input.
const MAX_BUFFER = 4096;

export class ObsidianLinkTransform {
  private buffer = "";

  constructor(private readonly metrics?: EmissionMetrics) {}

  /**
   * Transform a chunk of PTY output. Returns the transformed string to write
   * to xterm. May hold trailing bytes internally if the chunk ends mid-link.
   */
  transform(chunk: string): string {
    const combined = this.buffer + chunk;
    this.buffer = "";

    // Hold the earlier of the two partial starts so both markdown and bare
    // URL tails have a chance to complete on the next chunk.
    const markdownSplit = this.findPartialLinkStart(combined);
    const bareSplit = this.findPartialBareUrlStart(combined);
    const candidates = [markdownSplit, bareSplit].filter(
      (v): v is number => v !== null
    );
    const splitAt = candidates.length > 0 ? Math.min(...candidates) : null;

    let processable: string;
    if (splitAt !== null && combined.length - splitAt <= MAX_BUFFER) {
      processable = combined.slice(0, splitAt);
      this.buffer = combined.slice(splitAt);
    } else {
      processable = combined;
    }

    // Markdown pass must precede the bare pass so the URLs wrapped by it are
    // already protected by `\x1b]8;;` and the bare pass's lookbehind skips
    // them.
    const afterMarkdown = processable.replace(
      COMPLETE_LINK_RE,
      (_, text: string, url: string) => {
        this.metrics?.recordMarkdownLink();
        return `${OSC}8;;${url}${ST}${text}${OSC}8;;${ST}`;
      }
    );
    return afterMarkdown.replace(
      BARE_URL_RE,
      (_, url: string) => {
        this.metrics?.recordBareUrl();
        return `${OSC}8;;${url}${ST}${basenameFromUrl(url)}${OSC}8;;${ST}`;
      }
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

    // Find the last `[` in the tail that hasn't been closed by `)` AND is a
    // plausible markdown-link start. A `[` is NOT a link start when it is
    // part of an ANSI CSI escape sequence (immediately preceded by \x1b) or
    // when it is in the middle of a word (preceded by a letter/digit). Both
    // false positives are frequent enough in terminal output that failing to
    // reject them corrupts ESC sequences and delays typing echo.
    let lastOpen = -1;
    for (let i = tail.length - 1; i >= 0; i--) {
      const ch = tail[i];
      if (ch === ")") return null; // tail ends with a closed group — nothing partial
      if (ch !== "[") continue;
      // Reject `[` inside an ANSI CSI escape sequence (\x1b[...)
      if (i > 0 && tail.charCodeAt(i - 1) === 0x1b) continue;
      // Reject `[` in the middle of a word; real links in Claude's output
      // are always preceded by whitespace, a newline, or an open-paren.
      if (i > 0) {
        const prev = tail[i - 1];
        const isBoundary =
          prev === " " || prev === "\t" || prev === "\r" ||
          prev === "(" || prev === ">";
        if (!isBoundary) continue;
      }
      lastOpen = i;
      break;
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

  /**
   * Walk backwards to the last word boundary and report the index of an
   * unterminated bare `obsidian://open?...` URL if one is growing at the tail.
   * Returns the index of the URL's first char, or null if nothing to hold.
   *
   * Two shapes qualify:
   *   1. Tail is a proper prefix of `obsidian://open?` of length ≥ 5
   *      (e.g. `obsid`, `obsidian:/`). Could still grow into a full URL.
   *   2. Tail starts with the full `obsidian://open?` and has no terminator
   *      (space, newline, paren, bracket, quote, angle, ESC) after it yet.
   *
   * We skip positions that are embedded in an already-emitted OSC 8 prefix
   * (`\x1b]8;;obsidian://...`) so we don't re-buffer the URL inside an
   * existing hyperlink.
   */
  private findPartialBareUrlStart(s: string): number | null {
    // Find the boundary before the trailing candidate. Anything after the
    // last whitespace / bracket / paren / quote counts as the candidate.
    let start = s.length;
    for (let i = s.length - 1; i >= 0; i--) {
      const ch = s[i];
      if (
        ch === " " || ch === "\t" || ch === "\n" || ch === "\r" ||
        ch === "(" || ch === "[" || ch === "<" || ch === ">" ||
        ch === '"' || ch === "'" || ch === "\x1b"
      ) {
        start = i + 1;
        break;
      }
      if (i === 0) start = 0;
    }

    if (start >= s.length) return null;
    // Inside an OSC 8 hyperlink the URL is preceded by `\x1b]8;;`. Skip.
    if (start >= 5 && s.slice(start - 5, start) === "\x1b]8;;") return null;

    const tail = s.slice(start);

    // Case 1: proper prefix of the full scheme+path intro.
    if (
      tail.length >= MIN_BARE_PREFIX &&
      tail.length < BARE_URL_PREFIX.length &&
      BARE_URL_PREFIX.startsWith(tail)
    ) {
      return start;
    }

    // Case 2: full prefix reached. Only buffer when the tail looks
    // mid-structure (empty after prefix, or ends with a query-structural
    // char like `=`, `&`, `?`, `/`, or a half-written `%XX` escape). If
    // the URL appears to end naturally at end-of-chunk (e.g. with `.md`),
    // wrap it now — otherwise a URL right before a newline would flicker.
    if (tail.startsWith(BARE_URL_PREFIX)) {
      const rest = tail.slice(BARE_URL_PREFIX.length);
      if (/[\s)\]"'<>\x1b]/.test(rest)) return null;
      if (rest.length === 0) return start;
      if (/(?:[=&?/]|%[0-9a-fA-F]?)$/.test(rest)) return start;
    }

    return null;
  }
}

/**
 * Extract a short display label from an obsidian://open URL by percent-decoding
 * the `path` query parameter and taking its final path segment. When `path` is
 * absent or malformed we fall back to the whole URL so the user still sees
 * something clickable.
 */
function basenameFromUrl(url: string): string {
  const match = url.match(/[?&]path=([^&]+)/);
  if (!match) return url;
  let decoded: string;
  try {
    decoded = decodeURIComponent(match[1]);
  } catch {
    decoded = match[1];
  }
  const slash = decoded.lastIndexOf("/");
  return slash >= 0 ? decoded.slice(slash + 1) : decoded;
}
