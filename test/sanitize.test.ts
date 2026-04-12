import { describe, it, expect } from "vitest";
import { sanitizeForPty, wrapBackticks } from "../src/claude-terminal-view";

describe("sanitizeForPty", () => {
  it("removes control characters but keeps normal text", () => {
    expect(sanitizeForPty("hello world")).toBe("hello world");
  });

  it("strips null bytes and low control chars", () => {
    expect(sanitizeForPty("hello\x00world")).toBe("helloworld");
    expect(sanitizeForPty("\x01\x02\x03test")).toBe("test");
  });

  it("preserves newline, carriage return, and tab", () => {
    expect(sanitizeForPty("line1\nline2")).toBe("line1\nline2");
    expect(sanitizeForPty("col1\tcol2")).toBe("col1\tcol2");
    expect(sanitizeForPty("text\r\n")).toBe("text\r\n");
  });

  it("strips ESC character (0x1B is in the control char range)", () => {
    // ESC (0x1B) falls within \x0e-\x1f range and is stripped
    expect(sanitizeForPty("\x1b[31mred\x1b[0m")).toBe("[31mred[0m");
  });

  it("handles empty string", () => {
    expect(sanitizeForPty("")).toBe("");
  });

  it("preserves unicode (Korean, emoji)", () => {
    expect(sanitizeForPty("안녕하세요")).toBe("안녕하세요");
    expect(sanitizeForPty("test 🎉")).toBe("test 🎉");
  });
});

describe("wrapBackticks", () => {
  it("wraps text without triple backticks normally", () => {
    expect(wrapBackticks("hello")).toBe("hello");
  });

  it("wraps text containing triple backticks with quad backticks", () => {
    const input = "```js\nconsole.log('hi')\n```";
    const result = wrapBackticks(input);
    expect(result).toContain("````");
    expect(result).toContain(input);
  });

  it("handles empty string", () => {
    expect(wrapBackticks("")).toBe("");
  });
});
