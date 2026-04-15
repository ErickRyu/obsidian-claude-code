import { describe, it, expect } from "vitest";
import { ObsidianLinkTransform } from "../src/obsidian-link-transform";
import { EmissionMetrics } from "../src/emission-metrics";

const OSC8_OPEN = "\x1b]8;;";
const OSC8_CLOSE = "\x1b]8;;\x1b\\";
const ST = "\x1b\\";

function osc8(url: string, text: string): string {
  return `${OSC8_OPEN}${url}${ST}${text}${OSC8_CLOSE}`;
}

describe("ObsidianLinkTransform", () => {
  it("rewrites a complete obsidian markdown link to OSC 8", () => {
    const t = new ObsidianLinkTransform();
    const url = "obsidian://open?vault=v&path=a.md";
    const out = t.transform(`see [foo](${url}) here`);
    expect(out).toBe(`see ${osc8(url, "foo")} here`);
  });

  it("rewrites multiple links in one chunk", () => {
    const t = new ObsidianLinkTransform();
    const url1 = "obsidian://open?vault=v&path=a.md";
    const url2 = "obsidian://open?vault=v&path=b.md";
    const out = t.transform(`[a](${url1}) and [b](${url2})`);
    expect(out).toBe(`${osc8(url1, "a")} and ${osc8(url2, "b")}`);
  });

  it("leaves plain text untouched", () => {
    const t = new ObsidianLinkTransform();
    expect(t.transform("nothing to see here\n")).toBe("nothing to see here\n");
  });

  it("leaves unrelated markdown links untouched", () => {
    const t = new ObsidianLinkTransform();
    const input = "[docs](https://example.com/a.md)";
    expect(t.transform(input)).toBe(input);
  });

  it("buffers a chunk that ends mid-link and emits on completion", () => {
    const t = new ObsidianLinkTransform();
    const url = "obsidian://open?vault=v&path=a.md";

    const a = t.transform("prefix [foo](obsidi");
    expect(a).toBe("prefix ");

    const b = t.transform(`an://open?vault=v&path=a.md) tail`);
    expect(b).toBe(`${osc8(url, "foo")} tail`);
  });

  it("buffers across a chunk that breaks inside the visible text", () => {
    const t = new ObsidianLinkTransform();
    const url = "obsidian://open?vault=v&path=a.md";

    const a = t.transform("prefix [fo");
    expect(a).toBe("prefix ");

    const b = t.transform(`o](${url}) tail`);
    expect(b).toBe(`${osc8(url, "foo")} tail`);
  });

  it("does not buffer when the `[` is on a previous line", () => {
    const t = new ObsidianLinkTransform();
    const out = t.transform("this [is not a link\nnext line ");
    expect(out).toBe("this [is not a link\nnext line ");
  });

  it("does not buffer non-obsidian partial markdown links", () => {
    const t = new ObsidianLinkTransform();
    const out = t.transform("see [docs](http");
    // We pass through — this isn't our concern.
    expect(out).toBe("see [docs](http");
  });

  it("handles url-encoded paths with Korean characters", () => {
    const t = new ObsidianLinkTransform();
    const url =
      "obsidian://open?vault=v&path=Journal%2F2026-04-15%20%EC%88%98.md";
    const out = t.transform(`open [일기](${url})`);
    expect(out).toBe(`open ${osc8(url, "일기")}`);
  });

  it("flush returns held buffer without transformation", () => {
    const t = new ObsidianLinkTransform();
    t.transform("prefix [foo](obsidi");
    expect(t.flush()).toBe("[foo](obsidi");
    expect(t.flush()).toBe("");
  });

  // Regression: ESC sequences like `\x1b[?1;2c`, `\x1b[31m`, `\x1b[K` contain
  // `[` that must NOT be treated as a partial markdown-link start. Before
  // the fix, these were buffered, which (a) split the ESC sequence, causing
  // xterm to render `^[` as visible text, and (b) delayed every keystroke
  // echo because shell/Claude output is saturated with ANSI codes.
  describe("ANSI escape sequence handling (regression)", () => {
    it("preserves a DA-style escape sequence intact", () => {
      const t = new ObsidianLinkTransform();
      const input = "\x1b[?1;2c";
      expect(t.transform(input)).toBe(input);
      expect(t.flush()).toBe("");
    });

    it("preserves ANSI color sequences around plain text", () => {
      const t = new ObsidianLinkTransform();
      const input = "\x1b[31mhello\x1b[0m";
      expect(t.transform(input)).toBe(input);
      expect(t.flush()).toBe("");
    });

    it("does not split an ESC sequence that straddles two chunks", () => {
      const t = new ObsidianLinkTransform();
      // Chunk 1 ends mid-CSI — must pass through untouched so xterm can
      // complete the parse with chunk 2.
      expect(t.transform("\x1b[3")).toBe("\x1b[3");
      expect(t.transform("1m")).toBe("1m");
    });

    it("still converts an obsidian link that follows an ANSI color reset", () => {
      const t = new ObsidianLinkTransform();
      const url = "obsidian://open?vault=v&path=foo.md";
      const input = `see \x1b[0m [foo](${url}) here`;
      expect(t.transform(input)).toBe(`see \x1b[0m ${osc8(url, "foo")} here`);
    });

    it("does not buffer a typical shell prompt ending in brackets", () => {
      const t = new ObsidianLinkTransform();
      const input = "erick-obsidian-vault (main*) [Opus 4.6 (1M context)]";
      expect(t.transform(input)).toBe(input);
      expect(t.flush()).toBe("");
    });

    it("does not buffer `[` preceded by a non-boundary character", () => {
      const t = new ObsidianLinkTransform();
      expect(t.transform("abc[def")).toBe("abc[def");
      expect(t.flush()).toBe("");
    });

    it("still buffers a genuine partial obsidian link at word boundary", () => {
      // Make sure the boundary guard didn't break the real use case.
      const t = new ObsidianLinkTransform();
      const url = "obsidian://open?vault=v&path=a.md";
      expect(t.transform("prefix [fo")).toBe("prefix ");
      expect(t.transform(`o](${url}) tail`)).toBe(`${osc8(url, "foo")} tail`);
    });
  });

<<<<<<< HEAD
  // Fallback for when Claude ignores the system prompt and emits a raw
  // obsidian:// URL without the markdown `[text](url)` wrapper. We detect
  // the bare URL, extract the basename from the `path` query param, and
  // wrap it in OSC 8 so the user sees a short clickable label instead of
  // a giant URL.
  describe("bare obsidian:// URL handling", () => {
    it("wraps a bare obsidian:// URL using basename from path", () => {
      const t = new ObsidianLinkTransform();
      const url = "obsidian://open?vault=v&path=foo.md";
      const out = t.transform(`see ${url} here`);
      expect(out).toBe(`see ${osc8(url, "foo.md")} here`);
    });

    it("extracts basename from a nested path", () => {
      const t = new ObsidianLinkTransform();
      const url = "obsidian://open?vault=v&path=dir%2Fsub%2Ffile.md";
      const out = t.transform(`see ${url}`);
      expect(out).toBe(`see ${osc8(url, "file.md")}`);
    });

    it("decodes korean-encoded basename", () => {
      const t = new ObsidianLinkTransform();
      const url =
        "obsidian://open?vault=v&path=Journal%2F2026-04-15%20%EC%88%98.md";
      expect(t.transform(url)).toBe(osc8(url, "2026-04-15 수.md"));
    });

    it("wraps multiple bare URLs in one chunk", () => {
      const t = new ObsidianLinkTransform();
      const u1 = "obsidian://open?vault=v&path=a.md";
      const u2 = "obsidian://open?vault=v&path=b.md";
      expect(t.transform(`${u1} and ${u2}`)).toBe(
        `${osc8(u1, "a.md")} and ${osc8(u2, "b.md")}`
      );
    });

    it("does NOT re-wrap a URL already inside an OSC 8 hyperlink", () => {
      const t = new ObsidianLinkTransform();
      const url = "obsidian://open?vault=v&path=a.md";
      const input = osc8(url, "foo");
      expect(t.transform(input)).toBe(input);
    });

    it("markdown wrapping precedes bare scan without double-wrap", () => {
      const t = new ObsidianLinkTransform();
      const url = "obsidian://open?vault=v&path=a.md";
      const out = t.transform(`[foo](${url}) and raw ${url}`);
      expect(out).toBe(
        `${osc8(url, "foo")} and raw ${osc8(url, "a.md")}`
      );
    });

    it("stops a bare URL at whitespace", () => {
      const t = new ObsidianLinkTransform();
      const url = "obsidian://open?vault=v&path=a.md";
      expect(t.transform(`${url} rest`)).toBe(`${osc8(url, "a.md")} rest`);
    });

    it("stops a bare URL at a newline", () => {
      const t = new ObsidianLinkTransform();
      const url = "obsidian://open?vault=v&path=a.md";
      expect(t.transform(`${url}\nrest`)).toBe(`${osc8(url, "a.md")}\nrest`);
    });

    it("stops a bare URL at a closing paren", () => {
      const t = new ObsidianLinkTransform();
      const url = "obsidian://open?vault=v&path=a.md";
      expect(t.transform(`(${url}) rest`)).toBe(`(${osc8(url, "a.md")}) rest`);
    });

    it("buffers a bare URL split across chunks (mid-URL)", () => {
      const t = new ObsidianLinkTransform();
      const url = "obsidian://open?vault=v&path=a.md";
      expect(t.transform("prefix obsidian://open?vault=v&path=")).toBe("prefix ");
      expect(t.transform("a.md tail")).toBe(`${osc8(url, "a.md")} tail`);
    });

    it("buffers a bare URL split inside the scheme", () => {
      const t = new ObsidianLinkTransform();
      const url = "obsidian://open?vault=v&path=a.md";
      expect(t.transform("prefix obsidi")).toBe("prefix ");
      expect(t.transform("an://open?vault=v&path=a.md tail")).toBe(
        `${osc8(url, "a.md")} tail`
      );
    });

    it("does NOT buffer a plain word starting with 'o'", () => {
      const t = new ObsidianLinkTransform();
      expect(t.transform("hello open source")).toBe("hello open source");
      expect(t.flush()).toBe("");
    });

    it("falls back to the full URL as label when path is missing", () => {
      const t = new ObsidianLinkTransform();
      const url = "obsidian://open?vault=v";
      expect(t.transform(url)).toBe(osc8(url, url));
    });
  });

  describe("emission metrics", () => {
    it("increments linkMarkdownEmitted once per wrapped link", () => {
      const metrics = new EmissionMetrics();
      const t = new ObsidianLinkTransform(metrics);
      const u1 = "obsidian://open?vault=v&path=a.md";
      const u2 = "obsidian://open?vault=v&path=b.md";
      t.transform(`see [a](${u1}) and [b](${u2})`);
      expect(metrics.linkMarkdownEmitted).toBe(2);
    });

    it("increments linkBareUrlEmitted once per wrapped bare URL", () => {
      const metrics = new EmissionMetrics();
      const t = new ObsidianLinkTransform(metrics);
      const u1 = "obsidian://open?vault=v&path=a.md";
      const u2 = "obsidian://open?vault=v&path=b.md";
      t.transform(`raw ${u1} and ${u2}`);
      expect(metrics.linkBareUrlEmitted).toBe(2);
      expect(metrics.linkMarkdownEmitted).toBe(0);
    });

    it("separates markdown and bare counters when both appear together", () => {
      const metrics = new EmissionMetrics();
      const t = new ObsidianLinkTransform(metrics);
      const url = "obsidian://open?vault=v&path=a.md";
      t.transform(`[wrapped](${url}) and raw ${url}`);
      expect(metrics.linkMarkdownEmitted).toBe(1);
      expect(metrics.linkBareUrlEmitted).toBe(1);
    });

    it("does not count plain text as a markdown link", () => {
      const metrics = new EmissionMetrics();
      const t = new ObsidianLinkTransform(metrics);
      t.transform("no links here at all\n");
      expect(metrics.linkMarkdownEmitted).toBe(0);
      expect(metrics.linkBareUrlEmitted).toBe(0);
    });

    it("works without a metrics collector", () => {
      const t = new ObsidianLinkTransform();
      const url = "obsidian://open?vault=v&path=a.md";
      expect(() =>
        t.transform(`see [foo](${url}) here`)
      ).not.toThrow();
    });
  });
});
