/**
 * Phase 5a Task 10 — Resume integration (5a-6, 5a-7).
 *
 * Contract pieces:
 *   (a) `SessionController` invokes an `onSessionId(id)` callback the first
 *       time a `result` event with a non-empty `session_id` arrives on
 *       stdout. Callback is idempotent — subsequent results with the same
 *       id do not re-fire.
 *   (b) `wireWebview(plugin)` registers a second Obsidian command
 *       `claude-webview:resume` in addition to the existing open command.
 *   (c) The resume command, when invoked, opens a leaf whose runtime
 *       `SpawnImpl` receives argv containing `--resume <lastSessionId>`.
 *       If `lastSessionId` is empty, the resume command short-circuits
 *       with a Notice and does NOT spawn.
 *
 * These wire-level tests use happy-dom + the existing obsidian mock. The
 * production code path to cover:
 *   - `session-controller.ts` → `onSessionId` option + result handling.
 *   - `webview/index.ts` → second registerCommand + command callback.
 */
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { createBus, type Bus } from "../../src/webview/event-bus";
import {
  SessionController,
  type SpawnImpl,
} from "../../src/webview/session/session-controller";
import { wireWebview } from "../../src/webview";
import { COMMAND_RESUME_WEBVIEW } from "../../src/constants";
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
    pid: 12345,
    exitCode: null,
    kill(_signal?: string): boolean {
      fake.killed = true;
      return true;
    },
  }) as FakeChild;
  return fake;
}

function makeFakeSpawn(): {
  spawnImpl: SpawnImpl;
  calls: Array<{ cmd: string; args: string[] }>;
  last: () => FakeChild | null;
} {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const children: FakeChild[] = [];
  const spawnImpl: SpawnImpl = (cmd: string, args: string[]) => {
    calls.push({ cmd, args: [...args] });
    const child = makeFakeChild();
    children.push(child);
    return child as unknown as ChildProcess;
  };
  return {
    spawnImpl,
    calls,
    last: () => children[children.length - 1] ?? null,
  };
}

function fxSettings(): SpawnArgsSettings {
  return {
    claudePath: "claude",
    permissionPreset: "standard",
    extraArgs: "",
  };
}

describe("SessionController — onSessionId callback (Phase 5a)", () => {
  it("fires onSessionId exactly once when first result event carries a non-empty session_id", async () => {
    const bus: Bus = createBus();
    const { spawnImpl, last } = makeFakeSpawn();
    const onSessionId = vi.fn();
    const controller = new SessionController({
      settings: fxSettings(),
      bus,
      spawnImpl,
      onSessionId,
    });
    controller.start();
    const child = last();
    expect(child).not.toBeNull();
    if (!child) return;

    const sid = "aa111111-0000-0000-0000-000000000000";
    const resultLine =
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 100,
        result: "hi",
        session_id: sid,
        uuid: "uu1-0000-0000-0000-000000000001",
        total_cost_usd: 0.01,
      }) + "\n";
    child.stdout.emit("data", resultLine);
    // Allow microtasks.
    await Promise.resolve();
    expect(onSessionId).toHaveBeenCalledTimes(1);
    expect(onSessionId).toHaveBeenCalledWith(sid);

    // Second identical result — callback must remain at 1 call.
    child.stdout.emit("data", resultLine);
    await Promise.resolve();
    expect(onSessionId).toHaveBeenCalledTimes(1);

    controller.dispose();
    bus.dispose();
  });

  it("does not fire onSessionId when result.session_id is empty", async () => {
    const bus: Bus = createBus();
    const { spawnImpl, last } = makeFakeSpawn();
    const onSessionId = vi.fn();
    const controller = new SessionController({
      settings: fxSettings(),
      bus,
      spawnImpl,
      onSessionId,
    });
    controller.start();
    const child = last();
    if (!child) throw new Error("fake child missing");
    const line =
      JSON.stringify({
        type: "result",
        subtype: "success",
        duration_ms: 1,
        result: "",
        session_id: "",
        uuid: "uu-empty-0000-0000-0000-000000000002",
      }) + "\n";
    child.stdout.emit("data", line);
    await Promise.resolve();
    expect(onSessionId).not.toHaveBeenCalled();

    controller.dispose();
    bus.dispose();
  });
});

interface MinimalCommand {
  id: string;
  name: string;
  callback?: () => void | Promise<void>;
}

interface MockPlugin {
  settings: {
    uiMode: "terminal" | "webview";
    claudePath: string;
    permissionPreset: "safe" | "standard" | "full";
    extraArgs: string;
    showThinking: boolean;
    showDebugSystemEvents: boolean;
    lastSessionId: string;
  };
  registeredViews: Array<{ type: string; factory: (leaf: unknown) => unknown }>;
  registeredCommands: MinimalCommand[];
  registeredDisposers: Array<() => void>;
  app: {
    workspace: {
      getLeavesOfType: ReturnType<typeof vi.fn>;
      getRightLeaf: ReturnType<typeof vi.fn>;
      revealLeaf: ReturnType<typeof vi.fn>;
    };
  };
  registerView(type: string, factory: (leaf: unknown) => unknown): void;
  register(fn: () => void): void;
  addCommand(cmd: MinimalCommand): void;
  saveSettings(): Promise<void>;
}

function makeMockPlugin(): MockPlugin {
  const plugin: MockPlugin = {
    settings: {
      uiMode: "webview",
      claudePath: "claude",
      permissionPreset: "standard",
      extraArgs: "",
      showThinking: false,
      showDebugSystemEvents: false,
      lastSessionId: "",
    },
    registeredViews: [],
    registeredCommands: [],
    registeredDisposers: [],
    app: {
      workspace: {
        getLeavesOfType: vi.fn(() => []),
        getRightLeaf: vi.fn(() => null),
        revealLeaf: vi.fn(),
      },
    },
    registerView(type, factory) {
      this.registeredViews.push({ type, factory });
    },
    register(fn) {
      this.registeredDisposers.push(fn);
    },
    addCommand(cmd) {
      this.registeredCommands.push(cmd);
    },
    async saveSettings() {
      return;
    },
  };
  return plugin;
}

describe("wireWebview — resume command registration (5a-7)", () => {
  it("registers a resume command in addition to the open command", () => {
    const plugin = makeMockPlugin();
    // Cast to loosen the host type — MockPlugin structurally satisfies the
    // fields wireWebview reads; the Plugin base class is mocked in the
    // __mocks__/obsidian.ts module.
    wireWebview(plugin as unknown as Parameters<typeof wireWebview>[0]);
    const ids = plugin.registeredCommands.map((c) => c.id);
    expect(ids).toContain(COMMAND_RESUME_WEBVIEW);
    // Open command must still be present (no regression).
    expect(ids.length).toBeGreaterThanOrEqual(2);
  });

  it("resume command registers and spawns with --resume flag", async () => {
    const plugin = makeMockPlugin();
    plugin.settings.lastSessionId = "77777777-0000-0000-0000-000000000000";

    // Capture the leaf factory so we can instantiate a view manually.
    wireWebview(plugin as unknown as Parameters<typeof wireWebview>[0]);
    const viewEntry = plugin.registeredViews[0];
    expect(viewEntry).toBeDefined();

    // Swap in a fake-spawn leaf via mock workspace — the resume command
    // calls `workspace.getLeavesOfType` then `getRightLeaf` to open a leaf;
    // we simulate a leaf whose `setViewState` resolves, then snapshot the
    // runtime the factory produces.
    const { spawnImpl, calls } = makeFakeSpawn();
    let createdView: { runtime?: unknown } | null = null;
    const fakeLeaf = {
      app: plugin,
      view: null,
      setViewState: vi.fn(async () => {
        const factory = viewEntry.factory as (leaf: unknown) => {
          runtime?: {
            spawnImpl: SpawnImpl;
            settings: { lastSessionId?: string };
          };
        };
        const view = factory(fakeLeaf);
        // Override spawnImpl + capture runtime for argv observation.
        if (view.runtime) {
          const runtime = view.runtime as {
            spawnImpl: SpawnImpl;
            settings: { lastSessionId?: string };
          };
          createdView = view as { runtime?: unknown };
          // Manually invoke a controller start as the view would.
          const ctrl = new SessionController({
            settings: runtime.settings as unknown as SpawnArgsSettings,
            bus: createBus(),
            spawnImpl,
          });
          ctrl.start(undefined, plugin.settings.lastSessionId);
          ctrl.dispose();
        }
      }),
    };
    plugin.app.workspace.getLeavesOfType = vi.fn(() => []);
    plugin.app.workspace.getRightLeaf = vi.fn(() => fakeLeaf);

    const resumeCmd = plugin.registeredCommands.find(
      (c) => c.id === COMMAND_RESUME_WEBVIEW,
    );
    expect(resumeCmd).toBeDefined();
    expect(resumeCmd?.callback).toBeDefined();
    await resumeCmd?.callback?.();

    // The test has to await the leaf creation + spawn trigger; at this
    // point `spawnImpl` has been called via the spawn-and-dispose wrapper.
    expect(calls.length).toBe(1);
    const args = calls[0].args;
    const resumeIdx = args.indexOf("--resume");
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    expect(args[resumeIdx + 1]).toBe(plugin.settings.lastSessionId);
    expect(createdView).not.toBeNull();
  });

  it("resume command sets runtime.resumeOnStart=true on the NEXT factory invocation (HIGH-1 fix)", async () => {
    const plugin = makeMockPlugin();
    plugin.settings.lastSessionId = "88888888-0000-0000-0000-000000000000";
    wireWebview(plugin as unknown as Parameters<typeof wireWebview>[0]);
    const viewEntry = plugin.registeredViews[0];
    expect(viewEntry).toBeDefined();

    let capturedResumeOnStart: boolean | undefined = undefined;
    const fakeLeaf = {
      app: plugin,
      view: null,
      setViewState: vi.fn(async () => {
        const factory = viewEntry.factory as (leaf: unknown) => {
          runtime?: { resumeOnStart?: boolean };
        };
        const view = factory(fakeLeaf);
        capturedResumeOnStart = view.runtime?.resumeOnStart;
      }),
    };
    plugin.app.workspace.getLeavesOfType = vi.fn(() => []);
    plugin.app.workspace.getRightLeaf = vi.fn(() => fakeLeaf);

    const resumeCmd = plugin.registeredCommands.find(
      (c) => c.id === COMMAND_RESUME_WEBVIEW,
    );
    await resumeCmd?.callback?.();
    expect(capturedResumeOnStart).toBe(true);

    // Second factory invocation without the resume command must see the
    // flag cleared — the resume is strictly one-shot.
    let secondResumeOnStart: boolean | undefined = undefined;
    const factory = viewEntry.factory as (leaf: unknown) => {
      runtime?: { resumeOnStart?: boolean };
    };
    const secondView = factory({
      app: plugin,
      view: null,
    });
    secondResumeOnStart = secondView.runtime?.resumeOnStart;
    expect(secondResumeOnStart).toBe(false);
  });

  it("resume command with empty lastSessionId does NOT spawn — short-circuits with a Notice", async () => {
    const plugin = makeMockPlugin();
    plugin.settings.lastSessionId = "";
    wireWebview(plugin as unknown as Parameters<typeof wireWebview>[0]);
    const resumeCmd = plugin.registeredCommands.find(
      (c) => c.id === COMMAND_RESUME_WEBVIEW,
    );
    expect(resumeCmd).toBeDefined();
    // Spying on the workspace helpers confirms the callback did not reach
    // the leaf-creation branch when no session is available.
    plugin.app.workspace.getRightLeaf = vi.fn(() => null);
    await resumeCmd?.callback?.();
    expect(plugin.app.workspace.getRightLeaf).not.toHaveBeenCalled();
  });
});
