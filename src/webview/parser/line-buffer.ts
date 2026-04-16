/**
 * LineBuffer — split an incoming character stream on LF boundaries.
 *
 * Assumes upstream has called `stream.setEncoding('utf8')` so we only see
 * decoded strings (no raw Buffers). We normalize CRLF → LF and strip trailing
 * CR on emitted lines. Tail is held back until a LF arrives or `flush()` is called.
 */
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
