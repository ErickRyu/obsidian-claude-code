import { describe, it, expect } from "vitest";
import { LineBuffer } from "../../src/webview/parser/line-buffer";

describe("LineBuffer", () => {
  it("splits a chunk at mid-line and retains the tail for next feed", () => {
    const buf = new LineBuffer();
    const first = buf.feed('{"a":1}\n{"b":2');
    expect(first).toEqual(['{"a":1}']);
    const second = buf.feed('}\n');
    expect(second).toEqual(['{"b":2}']);
  });

  it("skips empty lines (blank LF-only)", () => {
    const buf = new LineBuffer();
    const lines = buf.feed("\n\n\na\n\nb\n");
    expect(lines).toEqual(["a", "b"]);
  });

  it("normalizes CRLF to LF when emitting lines", () => {
    const buf = new LineBuffer();
    const lines = buf.feed("line1\r\nline2\r\n");
    expect(lines).toEqual(["line1", "line2"]);
  });

  it("flush() returns residual tail after all chunks", () => {
    const buf = new LineBuffer();
    buf.feed("incomplete");
    expect(buf.flush()).toBe("incomplete");
    // flush empties the buffer
    expect(buf.flush()).toBeNull();
  });

  it("handles UTF-8 multibyte Korean characters split across chunks without corruption", () => {
    // Pre-requisite: upstream called setEncoding('utf8') so chunks are already
    // decoded strings. The buffer operates on strings, so the invariant here is
    // that concatenation preserves codepoints.
    const buf = new LineBuffer();
    // "안녕" (U+C548 U+B155) + "세상" (U+C138 U+C0C1)
    const full = "안녕\n세상\n";
    // Split at a non-LF midpoint (index 1, between codepoints — still safe because we operate on strings not bytes)
    const a = buf.feed(full.slice(0, 1));
    const b = buf.feed(full.slice(1));
    expect(a).toEqual([]);
    expect(b).toEqual(["안녕", "세상"]);
  });

  it("handles a very long single line (>64KB) without data loss", () => {
    const buf = new LineBuffer();
    const payload = "x".repeat(70_000);
    const lines = buf.feed(payload + "\ntail\n");
    expect(lines.length).toBe(2);
    expect(lines[0].length).toBe(70_000);
    expect(lines[1]).toBe("tail");
  });
});
