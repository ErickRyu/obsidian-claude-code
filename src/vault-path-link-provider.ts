import { App, type TFile } from "obsidian";
import type { Terminal, ILinkProvider, ILink } from "@xterm/xterm";

const VAULT_EXTENSIONS = ["md", "canvas"];
// Strong terminators that always break a path candidate.
// Whitespace is intentionally allowed inside the candidate so that paths like
// "Journal/Daily/2026-04-15 수.md" can be matched. The walk-back algorithm
// stops at these characters when collecting the candidate.
const TERMINATORS = /[\n<>"`\\(\)\[\]\{\}]/;

// Regex finds end-of-path extension; we then walk backwards to discover the
// candidate start. Lookahead ensures we only match when followed by a
// boundary character.
const EXT_TAIL_REGEX = new RegExp(
  `\\.(?:${VAULT_EXTENSIONS.join("|")})(?=[\\s,;:!?)\\]"'\`<>]|$)`,
  "g"
);

/**
 * xterm.js link provider that detects vault-relative file paths in terminal
 * output (e.g. "Journal/Daily/2026-04-15 수.md") and turns them into clickable
 * links. Only paths that resolve to an existing note via metadataCache are
 * surfaced — this eliminates false positives in prose like "see README.md".
 *
 * Limitation: handles single-line candidates only. URLs/paths split across
 * wrapped rows are not reconstructed (use the obsidian:// URL flow for that).
 */
export class VaultPathLinkProvider implements ILinkProvider {
  constructor(
    private readonly terminal: Terminal,
    private readonly app: App
  ) {}

  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
    const line = this.terminal.buffer.active.getLine(y - 1);
    if (!line) return callback(undefined);

    const text = line.translateToString(true);
    const links: ILink[] = [];
    const taken: Array<[number, number]> = [];

    // Reset regex state per line
    const re = new RegExp(EXT_TAIL_REGEX.source, "g");
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const extEnd = match.index + match[0].length;

      // Walk backwards to a terminator to capture the longest plausible candidate
      let i = match.index - 1;
      while (i >= 0 && !TERMINATORS.test(text[i])) {
        i--;
      }
      const rawStart = i + 1;
      const rawCandidate = text.slice(rawStart, extEnd);

      // Try resolution with progressively shorter candidates:
      //   1) longest walk-back (raw)
      //   2) raw with leading whitespace trimmed
      //   3) raw with annotation prefix (e.g. "경로:") stripped
      const attempts = this.candidateAttempts(rawCandidate, rawStart);
      let chosen: { candidate: string; start: number; target: TFile } | null = null;
      for (const a of attempts) {
        const target = this.resolve(a.candidate);
        if (target) {
          chosen = { candidate: a.candidate, start: a.start, target };
          break;
        }
      }
      if (!chosen) continue;

      // Avoid overlapping ranges (the same path matched via multiple attempts)
      const end = chosen.start + chosen.candidate.length;
      if (taken.some(([a, b]) => chosen!.start < b && end > a)) continue;
      taken.push([chosen.start, end]);

      links.push({
        range: {
          start: { x: chosen.start + 1, y },
          end: { x: end, y },
        },
        text: chosen.candidate,
        activate: (event: MouseEvent) => this.handleClick(event, chosen!.candidate),
      });
    }

    callback(links.length ? links : undefined);
  }

  /**
   * Generate candidate substrings to try resolving, ordered from longest to
   * shortest. We always try the full walk-back first (so paths like
   * "Journal/2026-04-15 수.md" containing a space resolve before the trailing
   * "수.md" suffix gets a chance). Then we try every suffix that begins right
   * after a whitespace boundary, which strips off prose like "open ", "see ",
   * "경로: ", "Path: ".
   */
  private candidateAttempts(
    raw: string,
    rawStart: number
  ): Array<{ candidate: string; start: number }> {
    const out: Array<{ candidate: string; start: number }> = [];
    out.push({ candidate: raw, start: rawStart });

    let cursor = 0;
    while (cursor < raw.length) {
      const wsRel = raw.slice(cursor).search(/\s/);
      if (wsRel < 0) break;
      // Skip the run of whitespace
      let end = cursor + wsRel;
      while (end < raw.length && /\s/.test(raw[end])) end++;
      if (end >= raw.length) break;
      out.push({ candidate: raw.slice(end), start: rawStart + end });
      cursor = end;
    }
    return out;
  }

  private resolve(candidate: string): TFile | null {
    if (!candidate || candidate.length < 3) return null;
    return this.app.metadataCache.getFirstLinkpathDest(candidate, "");
  }

  private handleClick(event: MouseEvent, candidate: string): void {
    if (!event.metaKey && !event.ctrlKey) return;
    // Re-resolve at click time in case vault state changed
    const target = this.resolve(candidate);
    if (!target) return;
    void this.app.workspace.openLinkText(target.path, "", false);
  }
}
