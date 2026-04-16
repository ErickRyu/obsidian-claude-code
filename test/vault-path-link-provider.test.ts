import { describe, it, expect, vi, beforeEach } from "vitest";
import { App, type TFile } from "obsidian";
import type { ILink } from "@xterm/xterm";
import { VaultPathLinkProvider } from "../src/vault-path-link-provider";
import { EmissionMetrics } from "../src/emission-metrics";

function makeFile(path: string): TFile {
  return { path } as TFile;
}

function makeApp(filesByLookup: Record<string, TFile | null>): App {
  return {
    workspace: { openLinkText: vi.fn() },
    metadataCache: {
      getFirstLinkpathDest: vi.fn((linkpath: string): TFile | null => {
        return filesByLookup[linkpath] ?? null;
      }),
    },
  } as unknown as App;
}

function makeTerminal(line: string): any {
  return {
    buffer: {
      active: {
        getLine: (_y: number) => ({
          translateToString: (_trim: boolean) => line,
        }),
      },
    },
  };
}

function collectLinks(provider: VaultPathLinkProvider, y = 1): ILink[] {
  let captured: ILink[] | undefined;
  provider.provideLinks(y, (links) => {
    captured = links;
  });
  return captured ?? [];
}

function clickEvent(modifiers: { meta?: boolean; ctrl?: boolean } = {}): MouseEvent {
  return { metaKey: !!modifiers.meta, ctrlKey: !!modifiers.ctrl } as MouseEvent;
}

describe("VaultPathLinkProvider", () => {
  let app: App;

  beforeEach(() => {
    app = makeApp({});
  });

  it("returns no links when the line has no .md/.canvas paths", () => {
    const term = makeTerminal("just plain text without a path");
    const provider = new VaultPathLinkProvider(term, app);
    expect(collectLinks(provider)).toEqual([]);
  });

  it("returns no links when a .md token does not resolve in the vault", () => {
    const term = makeTerminal("see README.md for details");
    const provider = new VaultPathLinkProvider(term, app);
    expect(collectLinks(provider)).toEqual([]);
  });

  it("links a resolvable nested path", () => {
    const file = makeFile("personal-wiki/concepts/llm-strategic-bias.md");
    app = makeApp({ "personal-wiki/concepts/llm-strategic-bias.md": file });
    const text = "open personal-wiki/concepts/llm-strategic-bias.md now";
    const term = makeTerminal(text);
    const provider = new VaultPathLinkProvider(term, app);
    const links = collectLinks(provider);
    expect(links.length).toBe(1);
    expect(links[0].text).toBe("personal-wiki/concepts/llm-strategic-bias.md");
    // x is 1-indexed; "open " is 5 chars, so start.x = 6
    expect(links[0].range.start.x).toBe(6);
    expect(links[0].range.end.x).toBe(5 + links[0].text.length);
  });

  it("links a path with spaces and Korean characters", () => {
    const path = "Journal/Daily/2026/04/2026-04-15 수.md";
    const file = makeFile(path);
    app = makeApp({ [path]: file });
    const text = `경로: ${path}`;
    const term = makeTerminal(text);
    const provider = new VaultPathLinkProvider(term, app);
    const links = collectLinks(provider);
    expect(links.length).toBe(1);
    expect(links[0].text).toBe(path);
  });

  it("strips an annotation prefix like 'path:' to find a resolvable candidate", () => {
    const path = "notes/foo.md";
    const file = makeFile(path);
    app = makeApp({ [path]: file });
    const text = "Path: notes/foo.md";
    const term = makeTerminal(text);
    const provider = new VaultPathLinkProvider(term, app);
    const links = collectLinks(provider);
    expect(links.length).toBe(1);
    expect(links[0].text).toBe(path);
    expect(links[0].range.start.x).toBe("Path: ".length + 1);
  });

  it("links multiple resolvable paths on a line", () => {
    const a = makeFile("a.md");
    const b = makeFile("b.md");
    app = makeApp({ "a.md": a, "b.md": b });
    const text = "see a.md and b.md";
    const term = makeTerminal(text);
    const provider = new VaultPathLinkProvider(term, app);
    const links = collectLinks(provider);
    expect(links.map((l) => l.text)).toEqual(["a.md", "b.md"]);
  });

  it("ignores .md tokens inside markdown URL syntax (terminator handling)", () => {
    const text = "[note](obsidian://open?path=foo.md)";
    const term = makeTerminal(text);
    const provider = new VaultPathLinkProvider(term, makeApp({ "foo.md": makeFile("foo.md") }));
    const links = collectLinks(provider);
    // The "(" and ")" act as terminators, isolating a candidate that starts with
    // "obsidian://open?path=foo.md"; that won't resolve in the vault — link skipped.
    // The text before "[note](..." has no .md, so no link.
    expect(links).toEqual([]);
  });

  it("opens the resolved file on Cmd+click", () => {
    const file = makeFile("notes/foo.md");
    app = makeApp({ "notes/foo.md": file });
    const term = makeTerminal("see notes/foo.md");
    const provider = new VaultPathLinkProvider(term, app);
    const links = collectLinks(provider);
    links[0].activate(clickEvent({ meta: true }), links[0].text);
    expect(app.workspace.openLinkText).toHaveBeenCalledWith("notes/foo.md", "", false);
  });

  it("does nothing on plain click without modifier", () => {
    const file = makeFile("notes/foo.md");
    app = makeApp({ "notes/foo.md": file });
    const term = makeTerminal("see notes/foo.md");
    const provider = new VaultPathLinkProvider(term, app);
    const links = collectLinks(provider);
    links[0].activate(clickEvent({}), links[0].text);
    expect(app.workspace.openLinkText).not.toHaveBeenCalled();
  });

  describe("emission metrics", () => {
    it("increments vaultPathMentioned only for resolved paths", () => {
      const file = makeFile("a.md");
      app = makeApp({ "a.md": file });
      const metrics = new EmissionMetrics();
      const term = makeTerminal("see a.md and missing.md here");
      const provider = new VaultPathLinkProvider(term, app, metrics);
      collectLinks(provider);
      expect(metrics.vaultPathMentioned).toBe(1);
    });

    it("does not increment when no path resolves", () => {
      const metrics = new EmissionMetrics();
      const term = makeTerminal("see README.md for details");
      const provider = new VaultPathLinkProvider(term, app, metrics);
      collectLinks(provider);
      expect(metrics.vaultPathMentioned).toBe(0);
    });

    it("works without a metrics collector", () => {
      const file = makeFile("a.md");
      app = makeApp({ "a.md": file });
      const term = makeTerminal("see a.md");
      const provider = new VaultPathLinkProvider(term, app);
      expect(() => collectLinks(provider)).not.toThrow();
    });

    it("does not double-count when provideLinks is called twice for the same line", () => {
      // xterm.js calls provideLinks on every hover and every repaint, not
      // once per emission. A naive counter inflates on user interaction and
      // makes the dogfood ratio useless.
      const file = makeFile("a.md");
      app = makeApp({ "a.md": file });
      const metrics = new EmissionMetrics();
      const term = makeTerminal("see a.md");
      const provider = new VaultPathLinkProvider(term, app, metrics);
      collectLinks(provider);
      collectLinks(provider);
      collectLinks(provider);
      expect(metrics.vaultPathMentioned).toBe(1);
    });

    it("counts distinct paths on the same line separately", () => {
      const a = makeFile("a.md");
      const b = makeFile("b.md");
      app = makeApp({ "a.md": a, "b.md": b });
      const metrics = new EmissionMetrics();
      const term = makeTerminal("see a.md and b.md");
      const provider = new VaultPathLinkProvider(term, app, metrics);
      collectLinks(provider);
      collectLinks(provider);
      expect(metrics.vaultPathMentioned).toBe(2);
    });
  });

  it("re-resolves at click time and aborts if the file disappeared", () => {
    const file = makeFile("notes/foo.md");
    let exists: TFile | null = file;
    const dynamicApp = {
      workspace: { openLinkText: vi.fn() },
      metadataCache: {
        getFirstLinkpathDest: vi.fn(() => exists),
      },
    } as unknown as App;
    const term = makeTerminal("see notes/foo.md");
    const provider = new VaultPathLinkProvider(term, dynamicApp);
    const links = collectLinks(provider);
    expect(links.length).toBe(1);
    exists = null; // file removed between hover and click
    links[0].activate(clickEvent({ meta: true }), links[0].text);
    expect(dynamicApp.workspace.openLinkText).not.toHaveBeenCalled();
  });
});
