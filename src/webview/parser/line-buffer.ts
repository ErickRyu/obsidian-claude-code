/**
 * LineBuffer — split an incoming character stream on LF boundaries.
 *
 * Assumes upstream has called `stream.setEncoding('utf8')` so we only see
 * decoded strings (no raw Buffers). We normalize CRLF → LF and strip trailing
 * CR on emitted lines. Tail is held back until a LF arrives or `flush()` is called.
 *
 * Memory guard: a pathological emission of a multi-MB single line without LF
 * (claude bug, truncated download, hung stream) would otherwise grow `tail`
 * unbounded and freeze the Electron renderer. When `tail` exceeds
 * `MAX_TAIL_CHARS`, the buffer drops the partial and returns a sentinel error
 * marker line so the parser surfaces a `session.error` rather than silent OOM.
 */
const MAX_TAIL_CHARS = 8 * 1024 * 1024; // 8 MiB; well above any healthy claude -p line.
export const TAIL_OVERFLOW_MARKER = "__line_buffer_tail_overflow__";

export class LineBuffer {
  private tail = "";

  feed(chunk: string): string[] {
    if (!chunk) {
      return [];
    }
    this.tail += chunk;
    const lines: string[] = [];
    let idx = this.tail.indexOf("\n");
    while (idx !== -1) {
      let line = this.tail.slice(0, idx);
      // CR/LF normalization
      if (line.length > 0 && line.charCodeAt(line.length - 1) === 13 /* \r */) {
        line = line.slice(0, -1);
      }
      if (line.length > 0) {
        lines.push(line);
      }
      this.tail = this.tail.slice(idx + 1);
      idx = this.tail.indexOf("\n");
    }
    if (this.tail.length > MAX_TAIL_CHARS) {
      // Drop the overflowing partial. Surface a marker line so the controller
      // can emit session.error; without this the renderer process blows memory
      // on a single multi-MB unfinished line.
      this.tail = "";
      lines.push(TAIL_OVERFLOW_MARKER);
    }
    return lines;
  }

  /**
   * Emit any residual tail as a final line. Returns null if empty.
   */
  flush(): string | null {
    if (this.tail.length === 0) {
      return null;
    }
    let line = this.tail;
    if (line.length > 0 && line.charCodeAt(line.length - 1) === 13) {
      line = line.slice(0, -1);
    }
    this.tail = "";
    return line.length > 0 ? line : null;
  }

  peekTail(): string {
    return this.tail;
  }
}
