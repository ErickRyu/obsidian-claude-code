/**
 * Phase 5b Task 7 — Resume fallback to SessionArchive (SH-07 / 5b-3).
 *
 * Contract exercised:
 *   - When the webview leaf opens with `runtime.resumeOnStart === true`
 *     and `runtime.archive` is wired, the view should detect a resume
 *     failure and fall back to replaying the archived JSONL from disk.
 *   - Two failure shapes must both trigger the fallback:
 *       (a) `result` event with `is_error: true` (CLI reports resume
 *           failure cleanly — preferred signal).
 *       (b) child exits with non-zero code before any result event —
 *           session.error emits `exit: 1` (hard CLI crash).
 *   - Fallback replays every archived event through the same
 *     `dispatchStreamEvent` pipeline that live stdout uses — the
 *     rendered cards should be indistinguishable from a live run.
 *   - Fallback fires AT MOST ONCE per view instance. A late-arriving
 *     second signal (e.g. exit after is_error result) must not double-
 *     replay the archive.
 *   - With `resumeOnStart !== true`, NEITHER failure shape triggers
 *     archive.load — the view must not shadow a normal error with a
 *     phantom replay.
 */
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Window } from "happy-dom";
import type { ChildProcess } from "node:child_process";
import type { WorkspaceLeaf } from "obsidian";
import { ClaudeWebviewView } from "../../src/webview/view";
import type { SpawnImpl } from "../../src/webview/session/session-controller";
import type { SpawnArgsSettings } from "../../src/webview/session/spawn-args";
import {
  SessionArchive,
  type ArchiveFsImpl,
} from "../../src/webview/session/session-archive";
import type { StreamEvent } from "../../src/webview/parser/types";

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
    pid: 33333,
    exitCode: null,
    kill(_signal?: string): boolean {
      fake.killed = true;
      return true;
    },
  }) as FakeChild;
  return fake;
}

function makeFakeFs(): ArchiveFsImpl & {
  files: Map<string, string>;
  dirs: Set<string>;
} {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    mkdirSync(p: string): void {
      dirs.add(p);
    },
    existsSync(p: string): boolean {
      return files.has(p) || dirs.has(p);
    },
    readFileSync(p: string, _encoding: "utf8"): string {
      const c = files.get(p);
      if (c === undefined) throw new Error(`ENOENT: ${p}`);
      return c;
    },
    appendFileSync(p: string, data: string): void {
      files.set(p, (files.get(p) ?? "") + data);
    },
  };
}

const SID = "cccc1111-2222-3333-4444-555555555555";
const BASE = "/vault/.obsidian/plugins/claude-webview/archives";

function seedArchive(fs: ReturnType<typeof makeFakeFs>): void {
  const archive = new SessionArchive({
    baseDir: BASE,
    fs,
    clock: () => new Date("2026-04-17T02:30:00.000Z"),
  });
  const systemInit: StreamEvent = {
    type: "system",
    subtype: "init",
    session_id: SID,
    uuid: "uu-init",
    model: "sonnet",
  };
  const assistant: StreamEvent = {
    type: "assistant",
    message: {
      id: "m-archived",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "ARCHIVED_HELLO" }],
    },
    session_id: SID,
    uuid: "uu-asst",
  };
  const result: StreamEvent = {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 42,
    result: "archived",
    session_id: SID,
    uuid: "uu-result",
  };
  archive.append(SID, systemInit);
  archive.append(SID, assistant);
  archive.append(SID, result);
}

function makeHarness(opts: {
  resumeOnStart: boolean;
  withArchive: boolean;
}): {
  view: ClaudeWebviewView;
  rootHost: HTMLElement;
  children: FakeChild[];
  fs: ReturnType<typeof makeFakeFs>;
} {
  const fs = makeFakeFs();
  if (opts.withArchive) seedArchive(fs);

  const children: FakeChild[] = [];
  const spawnImpl: SpawnImpl = () => {
    const c = makeFakeChild();
    children.push(c);
    return c as unknown as ChildProcess;
  };
  const settings = {
    claudePath: "claude",
    permissionPreset: "standard" as const,
    extraArgs: "",
    lastSessionId: SID,
  };

  const win = new Window();
  const doc = win.document;
  const containerEl = doc.createElement("div");
  const rootHost = doc.createElement("div");
  containerEl.appendChild(doc.createElement("div"));
  containerEl.appendChild(rootHost);
  doc.body.appendChild(containerEl);

  const leaf = { view: null as unknown as ClaudeWebviewView } as WorkspaceLeaf & {
    view: ClaudeWebviewView;
  };
  const view = new ClaudeWebviewView(leaf);
  (view as unknown as { containerEl: HTMLElement }).containerEl =
    containerEl as unknown as HTMLElement;
  leaf.view = view;

  const archive = opts.withArchive
    ? new SessionArchive({ baseDir: BASE, fs })
    : undefined;

  view.runtime = {
    spawnImpl,
    settings,
    resumeOnStart: opts.resumeOnStart,
    archive,
  };

  return {
    view,
    rootHost: rootHost as unknown as HTMLElement,
    children,
    fs,
  };
}

function emitIsErrorResult(child: FakeChild): void {
  child.stdout.emit(
    "data",
    JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      duration_ms: 10,
      result: "session not found",
      session_id: SID,
      uuid: "uu-err",
    }) + "\n",
  );
}

describe("Webview resume fallback → SessionArchive replay (Phase 5b SH-07)", () => {
  it("result.is_error=true on resume triggers archive.load + replay", async () => {
    const { view, rootHost, children } = makeHarness({
      resumeOnStart: true,
      withArchive: true,
    });
    await view.onOpen();
    const child = children[0];
    expect(child).toBeTruthy();

    emitIsErrorResult(child);
    await Promise.resolve();
    await Promise.resolve();

    expect(rootHost.textContent ?? "").toContain("ARCHIVED_HELLO");
    await view.onClose();
  });

  it("child exits non-zero before any result also triggers archive.load + replay", async () => {
    const { view, rootHost, children } = makeHarness({
      resumeOnStart: true,
      withArchive: true,
    });
    await view.onOpen();
    const child = children[0];
    expect(child).toBeTruthy();

    child.emit("exit", 1);
    await Promise.resolve();
    await Promise.resolve();

    expect(rootHost.textContent ?? "").toContain("ARCHIVED_HELLO");
    await view.onClose();
  });

  it("fallback fires at most once even when multiple failure signals arrive", async () => {
    const { view, rootHost, children, fs } = makeHarness({
      resumeOnStart: true,
      withArchive: true,
    });
    // Wrap fs.readFileSync to count load invocations.
    const original = fs.readFileSync;
    let loadReadCount = 0;
    fs.readFileSync = (p: string, _encoding: "utf8") => {
      loadReadCount++;
      return original.call(fs, p, _encoding);
    };

    await view.onOpen();
    const child = children[0];
    expect(child).toBeTruthy();

    emitIsErrorResult(child);
    await Promise.resolve();
    child.emit("exit", 1);
    await Promise.resolve();
    await Promise.resolve();

    expect(rootHost.textContent ?? "").toContain("ARCHIVED_HELLO");
    expect(loadReadCount).toBe(1);
    await view.onClose();
  });

  it("without resumeOnStart, neither failure signal loads the archive", async () => {
    const { view, rootHost, children, fs } = makeHarness({
      resumeOnStart: false,
      withArchive: true,
    });
    const original = fs.readFileSync;
    let loadReadCount = 0;
    fs.readFileSync = (p: string, _encoding: "utf8") => {
      loadReadCount++;
      return original.call(fs, p, _encoding);
    };
    await view.onOpen();
    const child = children[0];
    expect(child).toBeTruthy();

    emitIsErrorResult(child);
    child.emit("exit", 1);
    await Promise.resolve();
    await Promise.resolve();

    expect(loadReadCount).toBe(0);
    expect(rootHost.textContent ?? "").not.toContain("ARCHIVED_HELLO");
    await view.onClose();
  });

  it("stderr emission during resume does NOT trigger archive replay (review HIGH fix)", async () => {
    // Regression guard for the review finding: prior implementation fired
    // the fallback on any `session.error` whose message was not exactly
    // `exit: 0`, including `stderr: <chunk>` which is routine warmup
    // output on many real sessions. The fix narrows the listener to
    // `exit:` messages only. This test overlays archived content only
    // when the guard is correctly tight.
    const { view, rootHost, children, fs } = makeHarness({
      resumeOnStart: true,
      withArchive: true,
    });
    const original = fs.readFileSync;
    let loadReadCount = 0;
    fs.readFileSync = (p: string, _encoding: "utf8") => {
      loadReadCount++;
      return original.call(fs, p, _encoding);
    };

    await view.onOpen();
    const child = children[0];
    expect(child).toBeTruthy();

    // CLI warmup warning on stderr — should NOT trigger fallback.
    child.stderr.emit("data", "deprecation: foo will be removed\n");
    await Promise.resolve();
    await Promise.resolve();

    expect(loadReadCount).toBe(0);
    expect(rootHost.textContent ?? "").not.toContain("ARCHIVED_HELLO");
    await view.onClose();
  });

  it("with resumeOnStart but no archive wired, failure produces no replay", async () => {
    const { view, rootHost, children } = makeHarness({
      resumeOnStart: true,
      withArchive: false,
    });
    await view.onOpen();
    const child = children[0];
    expect(child).toBeTruthy();

    emitIsErrorResult(child);
    await Promise.resolve();
    await Promise.resolve();

    expect(rootHost.textContent ?? "").not.toContain("ARCHIVED_HELLO");
    await view.onClose();
  });
});
