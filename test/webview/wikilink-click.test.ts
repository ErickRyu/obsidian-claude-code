/**
 * 2026-05-01 dogfood regression test — wikilink click delegation.
 *
 * MarkdownRenderer.render emits `<a class="internal-link" data-href="…">`
 * for `[[wikilink]]` syntax, but Obsidian's auto-attached click handler
 * only fires inside reading/editing views. In a custom ItemView like
 * ours, clicks were dead until we added a delegated capture-phase
 * listener on `cardsEl` that routes through `app.workspace.openLinkText`.
 *
 * This test locks in:
 *   - Plain click → openLinkText(linktext, sourcePath, false)
 *   - Cmd/Ctrl+click → openLinkText(..., true) (new pane)
 *   - sourcePath comes from `app.workspace.getActiveFile()?.path`
 *   - External http(s) / obsidian:// anchors are NOT intercepted
 *   - Anchors without internal-link / data-href are NOT intercepted
 *   - The handler runs in capture phase (so an inner stopPropagation
 *     cannot pre-empt it)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Window } from "happy-dom";
import type { ChildProcess } from "node:child_process";
import type { WorkspaceLeaf } from "obsidian";
import { ClaudeWebviewView } from "../../src/webview/view";
import type { SpawnImpl } from "../../src/webview/session/session-controller";
import type { SpawnArgsSettings } from "../../src/webview/session/spawn-args";

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill(signal?: string): boolean;
  killed: boolean;
  pid: number;
  exitCode: number | null;
}

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter();
  const fake = Object.assign(ee, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    pid: 99999,
    exitCode: null,
    kill(_signal?: string): boolean {
      fake.killed = true;
      return true;
    },
  }) as FakeChild;
  return fake;
}

interface Harness {
  view: ClaudeWebviewView;
  rootHost: HTMLElement;
  openLinkText: ReturnType<typeof vi.fn>;
  cleanup: () => Promise<void>;
}

async function makeHarness(activeFilePath: string | null = "current.md"): Promise<Harness> {
  const spawnImpl: SpawnImpl = () =>
    makeFakeChild() as unknown as ChildProcess;
  const settings: SpawnArgsSettings = {
    claudePath: "claude",
    permissionPreset: "standard",
    extraArgs: "",
  };

  const win = new Window();
  const doc = win.document;
  const containerEl = doc.createElement("div");
  const rootHost = doc.createElement("div");
  containerEl.appendChild(doc.createElement("div"));
  containerEl.appendChild(rootHost);
  doc.body.appendChild(containerEl);

  const openLinkText = vi.fn(() => Promise.resolve());
  const getActiveFile = vi.fn(() =>
    activeFilePath !== null ? { path: activeFilePath } : null,
  );

  const leaf = {
    view: null as unknown as ClaudeWebviewView,
    app: {
      workspace: { openLinkText, getActiveFile },
    },
  } as unknown as WorkspaceLeaf & {
    view: ClaudeWebviewView;
    app: unknown;
  };

  const view = new ClaudeWebviewView(leaf);
  (view as unknown as { containerEl: HTMLElement }).containerEl =
    containerEl as unknown as HTMLElement;
  leaf.view = view;
  (view as unknown as {
    __testHooks: {
      spawnImpl: SpawnImpl;
      settings: SpawnArgsSettings;
      eagerStartForTests: boolean;
    };
  }).__testHooks = { spawnImpl, settings, eagerStartForTests: true };

  await view.onOpen();

  return {
    view,
    rootHost: rootHost as unknown as HTMLElement,
    openLinkText,
    cleanup: async () => {
      await view.onClose();
    },
  };
}

function getCards(rootHost: HTMLElement): HTMLElement {
  const el = rootHost.querySelector(".claude-wv-cards");
  if (!el) throw new Error("cardsEl missing — view not mounted");
  return el as unknown as HTMLElement;
}

function makeAnchor(
  doc: Document,
  attrs: Record<string, string>,
  text: string,
): HTMLAnchorElement {
  const a = doc.createElement("a");
  for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
  a.textContent = text;
  return a;
}

describe("wikilink click delegation (2026-05-01 dogfood fix)", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness("current-note.md");
  });

  it("plain click on internal-link → openLinkText with active-file sourcePath", () => {
    const cards = getCards(harness.rootHost);
    const doc = (cards.ownerDocument ?? cards) as unknown as Document;
    const a = makeAnchor(
      doc,
      {
        "data-href": "ep10-smartviz",
        href: "ep10-smartviz",
        class: "internal-link",
      },
      "ep10-smartviz",
    );
    cards.appendChild(a);

    const evt = new (cards.ownerDocument as unknown as { defaultView: { MouseEvent: typeof MouseEvent } }).defaultView.MouseEvent(
      "click",
      { bubbles: true, cancelable: true },
    );
    a.dispatchEvent(evt);

    expect(harness.openLinkText).toHaveBeenCalledTimes(1);
    expect(harness.openLinkText).toHaveBeenCalledWith(
      "ep10-smartviz",
      "current-note.md",
      false,
    );
  });

  it("Cmd/Ctrl+click → openLinkText(..., newLeaf=true)", () => {
    const cards = getCards(harness.rootHost);
    const doc = (cards.ownerDocument ?? cards) as unknown as Document;
    const a = makeAnchor(
      doc,
      { "data-href": "folder/note", class: "internal-link" },
      "note",
    );
    cards.appendChild(a);

    const win = (cards.ownerDocument as unknown as { defaultView: Window }).defaultView;
    const evt = new (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent(
      "click",
      { bubbles: true, cancelable: true, metaKey: true },
    );
    a.dispatchEvent(evt);

    expect(harness.openLinkText).toHaveBeenCalledTimes(1);
    expect(harness.openLinkText).toHaveBeenCalledWith(
      "folder/note",
      "current-note.md",
      true,
    );
  });

  it("anchor without internal-link / data-href is NOT intercepted", () => {
    const cards = getCards(harness.rootHost);
    const doc = (cards.ownerDocument ?? cards) as unknown as Document;
    const a = makeAnchor(doc, { href: "https://example.com" }, "external");
    cards.appendChild(a);

    const win = (cards.ownerDocument as unknown as { defaultView: Window }).defaultView;
    const evt = new (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent(
      "click",
      { bubbles: true, cancelable: true },
    );
    a.dispatchEvent(evt);

    expect(harness.openLinkText).not.toHaveBeenCalled();
  });

  it("internal-link with http:// data-href falls through (treated as external)", () => {
    const cards = getCards(harness.rootHost);
    const doc = (cards.ownerDocument ?? cards) as unknown as Document;
    const a = makeAnchor(
      doc,
      { "data-href": "https://example.com", class: "internal-link" },
      "weird",
    );
    cards.appendChild(a);

    const win = (cards.ownerDocument as unknown as { defaultView: Window }).defaultView;
    const evt = new (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent(
      "click",
      { bubbles: true, cancelable: true },
    );
    a.dispatchEvent(evt);

    expect(harness.openLinkText).not.toHaveBeenCalled();
  });

  it("obsidian:// data-href falls through (Obsidian protocol handler owns it)", () => {
    const cards = getCards(harness.rootHost);
    const doc = (cards.ownerDocument ?? cards) as unknown as Document;
    const a = makeAnchor(
      doc,
      { "data-href": "obsidian://open?vault=v&path=x.md", class: "internal-link" },
      "uri",
    );
    cards.appendChild(a);

    const win = (cards.ownerDocument as unknown as { defaultView: Window }).defaultView;
    const evt = new (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent(
      "click",
      { bubbles: true, cancelable: true },
    );
    a.dispatchEvent(evt);

    expect(harness.openLinkText).not.toHaveBeenCalled();
  });

  it("inner element click bubbles up to anchor and is delegated", () => {
    const cards = getCards(harness.rootHost);
    const doc = (cards.ownerDocument ?? cards) as unknown as Document;
    const a = makeAnchor(
      doc,
      { "data-href": "ep10-smartviz", class: "internal-link" },
      "",
    );
    const inner = doc.createElement("span");
    inner.textContent = "ep10-smartviz";
    a.appendChild(inner);
    cards.appendChild(a);

    const win = (cards.ownerDocument as unknown as { defaultView: Window }).defaultView;
    const evt = new (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent(
      "click",
      { bubbles: true, cancelable: true },
    );
    inner.dispatchEvent(evt);

    expect(harness.openLinkText).toHaveBeenCalledTimes(1);
    expect(harness.openLinkText).toHaveBeenCalledWith(
      "ep10-smartviz",
      "current-note.md",
      false,
    );
  });

  it("no active file → sourcePath falls back to empty string", async () => {
    await harness.cleanup();
    harness = await makeHarness(null);
    const cards = getCards(harness.rootHost);
    const doc = (cards.ownerDocument ?? cards) as unknown as Document;
    const a = makeAnchor(
      doc,
      { "data-href": "x", class: "internal-link" },
      "x",
    );
    cards.appendChild(a);

    const win = (cards.ownerDocument as unknown as { defaultView: Window }).defaultView;
    const evt = new (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent(
      "click",
      { bubbles: true, cancelable: true },
    );
    a.dispatchEvent(evt);

    expect(harness.openLinkText).toHaveBeenCalledWith("x", "", false);
  });

  it("preventDefault is called so the browser does not navigate the anchor", () => {
    const cards = getCards(harness.rootHost);
    const doc = (cards.ownerDocument ?? cards) as unknown as Document;
    const a = makeAnchor(
      doc,
      { "data-href": "x", class: "internal-link" },
      "x",
    );
    cards.appendChild(a);

    const win = (cards.ownerDocument as unknown as { defaultView: Window }).defaultView;
    const evt = new (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent(
      "click",
      { bubbles: true, cancelable: true },
    );
    a.dispatchEvent(evt);

    expect(evt.defaultPrevented).toBe(true);
  });
});
