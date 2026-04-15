import { describe, it, expect, vi, beforeEach } from "vitest";
import { App, type TFile } from "obsidian";
import {
  OBSIDIAN_OPEN_URL_REGEX,
  createObsidianLinkHandler,
  createObsidianOsc8LinkHandler,
} from "../src/obsidian-link-provider";
import type { IBufferRange } from "@xterm/xterm";

function makeApp(file: TFile | null = null): App {
  return {
    vault: { getName: () => "test-vault" },
    workspace: { openLinkText: vi.fn() },
    metadataCache: { getFirstLinkpathDest: vi.fn(() => file) },
  } as unknown as App;
}

function makeFile(path: string): TFile {
  return { path } as TFile;
}

function clickEvent(modifiers: { meta?: boolean; ctrl?: boolean } = {}): MouseEvent {
  return { metaKey: !!modifiers.meta, ctrlKey: !!modifiers.ctrl } as MouseEvent;
}

describe("OBSIDIAN_OPEN_URL_REGEX", () => {
  function matchAll(text: string): string[] {
    const re = new RegExp(OBSIDIAN_OPEN_URL_REGEX.source, "g");
    return [...text.matchAll(re)].map((m) => m[0]);
  }

  it("matches a single obsidian://open URL", () => {
    const text = "see [foo](obsidian://open?vault=v&path=a%2Fb.md) here";
    expect(matchAll(text)).toEqual([
      "obsidian://open?vault=v&path=a%2Fb.md",
    ]);
  });

  it("matches multiple URLs on one line", () => {
    const text = "obsidian://open?path=a.md obsidian://open?path=b.md";
    expect(matchAll(text).length).toBe(2);
  });

  it("strips trailing markdown closing parens and punctuation", () => {
    const text = "[x](obsidian://open?path=a.md), and more.";
    const matches = matchAll(text);
    expect(matches.length).toBe(1);
    expect(matches[0]).toBe("obsidian://open?path=a.md");
    expect(matches[0]).not.toContain(")");
    expect(matches[0]).not.toContain(",");
  });

  it("rejects obsidian://shell-command and other subcommands", () => {
    const text = "obsidian://shell-command/run obsidian://vault/x/new";
    expect(matchAll(text)).toEqual([]);
  });

  it("returns no matches for plain text without a URL", () => {
    expect(matchAll("just regular text")).toEqual([]);
  });
});

describe("createObsidianLinkHandler", () => {
  let app: App;
  let handler: (event: MouseEvent, uri: string) => void;
  let file: TFile;

  beforeEach(() => {
    file = makeFile("notes/foo.md");
    app = makeApp(file);
    handler = createObsidianLinkHandler(app);
  });

  it("opens the resolved note when Cmd is held", () => {
    handler(clickEvent({ meta: true }), "obsidian://open?vault=v&path=notes%2Ffoo.md");
    expect(app.metadataCache.getFirstLinkpathDest).toHaveBeenCalledWith("notes/foo.md", "");
    expect(app.workspace.openLinkText).toHaveBeenCalledWith("notes/foo.md", "", false);
  });

  it("opens the resolved note when Ctrl is held", () => {
    handler(clickEvent({ ctrl: true }), "obsidian://open?path=notes%2Ffoo.md");
    expect(app.workspace.openLinkText).toHaveBeenCalledWith("notes/foo.md", "", false);
  });

  it("does nothing when no modifier key is pressed", () => {
    handler(clickEvent({}), "obsidian://open?path=notes%2Ffoo.md");
    expect(app.metadataCache.getFirstLinkpathDest).not.toHaveBeenCalled();
    expect(app.workspace.openLinkText).not.toHaveBeenCalled();
  });

  it("rejects non-open hosts (e.g. shell-command)", () => {
    handler(clickEvent({ meta: true }), "obsidian://shell-command?cmd=evil");
    expect(app.workspace.openLinkText).not.toHaveBeenCalled();
  });

  it("notices and aborts when 'path' parameter is missing", () => {
    handler(clickEvent({ meta: true }), "obsidian://open?vault=v");
    expect(app.metadataCache.getFirstLinkpathDest).not.toHaveBeenCalled();
    expect(app.workspace.openLinkText).not.toHaveBeenCalled();
  });

  it("notices and aborts when path does not resolve to an indexed note", () => {
    app = makeApp(null); // metadataCache returns null
    handler = createObsidianLinkHandler(app);
    handler(clickEvent({ meta: true }), "obsidian://open?path=.obsidian%2Fconfig.json");
    expect(app.metadataCache.getFirstLinkpathDest).toHaveBeenCalledWith(
      ".obsidian/config.json",
      ""
    );
    expect(app.workspace.openLinkText).not.toHaveBeenCalled();
  });

  it("notices on malformed URL", () => {
    handler(clickEvent({ meta: true }), "not-a-url");
    expect(app.workspace.openLinkText).not.toHaveBeenCalled();
  });

  it("decodes percent-encoded paths before lookup", () => {
    handler(clickEvent({ meta: true }), "obsidian://open?path=personal-wiki%2Ffoo%20bar.md");
    expect(app.metadataCache.getFirstLinkpathDest).toHaveBeenCalledWith(
      "personal-wiki/foo bar.md",
      ""
    );
  });

  it("uses the resolved TFile path, not the raw URL path (handles aliases/case)", () => {
    file = makeFile("Personal-Wiki/Foo.md");
    app = makeApp(file);
    handler = createObsidianLinkHandler(app);
    handler(clickEvent({ meta: true }), "obsidian://open?path=personal-wiki%2Ffoo.md");
    expect(app.workspace.openLinkText).toHaveBeenCalledWith("Personal-Wiki/Foo.md", "", false);
  });
});

describe("createObsidianOsc8LinkHandler", () => {
  const range: IBufferRange = {
    start: { x: 1, y: 1 },
    end: { x: 1, y: 1 },
  };

  it("opens the resolved note for obsidian:// OSC 8 hyperlinks with modifier", () => {
    const file = makeFile("notes/foo.md");
    const app = makeApp(file);
    const handler = createObsidianOsc8LinkHandler(app);
    handler.activate(
      clickEvent({ meta: true }),
      "obsidian://open?path=notes%2Ffoo.md",
      range
    );
    expect(app.workspace.openLinkText).toHaveBeenCalledWith("notes/foo.md", "", false);
  });

  it("ignores obsidian:// clicks without a modifier key", () => {
    const app = makeApp(makeFile("notes/foo.md"));
    const handler = createObsidianOsc8LinkHandler(app);
    handler.activate(clickEvent({}), "obsidian://open?path=notes%2Ffoo.md", range);
    expect(app.workspace.openLinkText).not.toHaveBeenCalled();
  });

  it("opens non-obsidian URLs via window.open", () => {
    const app = makeApp(null);
    const handler = createObsidianOsc8LinkHandler(app);
    const openSpy = vi.fn();
    (globalThis as { window?: { open: typeof openSpy } }).window = { open: openSpy };
    try {
      handler.activate(clickEvent({}), "https://example.com", range);
      expect(openSpy).toHaveBeenCalledWith("https://example.com", "_blank");
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  it("rejects obsidian:// non-open hosts", () => {
    const app = makeApp(makeFile("x.md"));
    const handler = createObsidianOsc8LinkHandler(app);
    handler.activate(
      clickEvent({ meta: true }),
      "obsidian://shell-command?cmd=evil",
      range
    );
    expect(app.workspace.openLinkText).not.toHaveBeenCalled();
  });
});
