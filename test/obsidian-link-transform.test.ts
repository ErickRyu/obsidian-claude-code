import { describe, it, expect } from "vitest";
import { ObsidianLinkTransform } from "../src/obsidian-link-transform";

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
});
