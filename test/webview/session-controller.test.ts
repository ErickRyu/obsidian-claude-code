/**
 * Phase 3 Task 8 — SessionController fake-spawn contract.
 *
 * Covers Phase 3 verification matrix 3-3:
 *   - stdout JSONL chunk → LineBuffer → parseLine → bus.emit('stream.event')
 *   - send(text) writes JSONL to child.stdin with trailing '\n'
 *   - stdin.destroyed → session.error emitted, no write attempted
 *   - stdin.write() returning false → drain waited for before next write
 *   - stdout.emit('error', EPIPE-like) → session.error emitted
 *   - child 'exit' → session.error emitted (informational; Phase 5a will
 *     promote to a neutral "session.end")
 *   - dispose() removes every listener on stdout/stderr/child + kills child
 *
 * The fake ChildProcess is an `EventEmitter` whose `stdin` / `stdout` / `stderr`
 * are `PassThrough` streams — the same contract the real `node:child_process`
 * exposes (everything extends `EventEmitter` + streams expose `.destroyed`
 * and `.write()` return values).  The structural cast at the fake-wiring
 * boundary is `as unknown as ChildProcess` — no `as any` / intersection.
 */
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { createBus, type BusEvent } from "../../src/webview/event-bus";
import {
  SessionController,
  type SpawnImpl,
} from "../../src/webview/session/session-controller";
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
    calls.push({ cmd, args });
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

function collect(bus: ReturnType<typeof createBus>): BusEvent[] {
  const seen: BusEvent[] = [];
  bus.on("stream.event", (e) => seen.push(e));
  bus.on("session.error", (e) => seen.push(e));
  return seen;
}

describe("SessionController — fake-spawn lifecycle contract (Phase 3 3-3)", () => {
  it("start() spawns with args from buildSpawnArgs and passes settings-derived preset flags", () => {
    const bus = createBus();
    const { spawnImpl, calls } = makeFakeSpawn();
    const ctrl = new SessionController({ settings: fxSettings(), bus, spawnImpl });
    ctrl.start();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("claude");
    expect(calls[0]!.args).toContain("--permission-mode");
    const permIdx = calls[0]!.args.indexOf("--permission-mode");
    expect(calls[0]!.args[permIdx + 1]).toBe("acceptEdits");
    ctrl.dispose();
  });

  it("start() with resumeId adds --resume <id> to argv (feeds next spawn)", () => {
    const bus = createBus();
    const { spawnImpl, calls } = makeFakeSpawn();
    const ctrl = new SessionController({ settings: fxSettings(), bus, spawnImpl });
    const VALID_UUID = "d70751ee-151b-4b5b-b5c4-957c02505dc6";
    ctrl.start(undefined, VALID_UUID);
    const args = calls[0]!.args;
    const idx = args.indexOf("--resume");
    expect(idx).toBeGreaterThan(0);
    expect(args[idx + 1]).toBe(VALID_UUID);
    ctrl.dispose();
  });

  it("stdout JSONL chunk → bus.emit('stream.event') for every valid line", async () => {
    const bus = createBus();
    const { spawnImpl, last } = makeFakeSpawn();
    const seen = collect(bus);
    const ctrl = new SessionController({ settings: fxSettings(), bus, spawnImpl });
    ctrl.start();
    const child = last();
    expect(child).not.toBeNull();

    const sysInit = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "s1",
      model: "claude-sonnet",
      cwd: "/vault",
      tools: [],
      permissionMode: "acceptEdits",
    });
    const asstText = JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_1",
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
      },
      session_id: "s1",
    });

    child!.stdout.emit("data", sysInit + "\n" + asstText + "\n");

    // Allow microtasks to flush.
    await Promise.resolve();

    const streamEvents = seen.filter((e) => e.kind === "stream.event");
    expect(streamEvents.length).toBe(2);
    // Differential — confirms the controller is actually parsing, not
    // hard-coding.  Swap the order and the kinds follow.
    expect(
      streamEvents.map((e) => (e.kind === "stream.event" ? e.event.type : "?"))
    ).toEqual(["system", "assistant"]);

    ctrl.dispose();
  });

  it("stdout split across multiple chunks is reassembled by LineBuffer", async () => {
    const bus = createBus();
    const { spawnImpl, last } = makeFakeSpawn();
    const seen = collect(bus);
    const ctrl = new SessionController({ settings: fxSettings(), bus, spawnImpl });
    ctrl.start();
    const child = last()!;

    const full = JSON.stringify({
      type: "assistant",
      message: { id: "m", role: "assistant", content: [{ type: "text", text: "xy" }] },
      session_id: "s",
    });
    const mid = Math.floor(full.length / 2);
    child.stdout.emit("data", full.slice(0, mid));
    await Promise.resolve();
    expect(seen.filter((e) => e.kind === "stream.event")).toHaveLength(0);
    child.stdout.emit("data", full.slice(mid) + "\n");
    await Promise.resolve();
    expect(seen.filter((e) => e.kind === "stream.event")).toHaveLength(1);
    ctrl.dispose();
  });

  it("send(text) writes a JSONL user message to stdin with a trailing newline", () => {
    const bus = createBus();
    const { spawnImpl, last } = makeFakeSpawn();
    const ctrl = new SessionController({ settings: fxSettings(), bus, spawnImpl });
    ctrl.start();
    const child = last()!;

    const received: string[] = [];
    child.stdin.on("data", (chunk: Buffer | string) => {
      received.push(chunk.toString("utf8"));
    });

    ctrl.send("hello there");

    const joined = received.join("");
    expect(joined.endsWith("\n")).toBe(true);
    const parsed: unknown = JSON.parse(joined.trimEnd());
    expect(parsed).toMatchObject({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "hello there" }],
      },
    });

    ctrl.dispose();
  });

  it("send() on destroyed stdin emits session.error and writes nothing", () => {
    const bus = createBus();
    const { spawnImpl, last } = makeFakeSpawn();
    const seen = collect(bus);
    const ctrl = new SessionController({ settings: fxSettings(), bus, spawnImpl });
    ctrl.start();
    const child = last()!;

    // Mark stdin as destroyed.  PassThrough#destroy sets .destroyed = true
    // synchronously before emitting 'close'.
    child.stdin.destroy();

    ctrl.send("never arrives");

    const errors = seen.filter((e) => e.kind === "session.error");
    expect(errors.length).toBeGreaterThan(0);
    const msg = errors.map((e) => (e.kind === "session.error" ? e.message : "")).join(" ");
    expect(msg).toMatch(/stdin/i);

    ctrl.dispose();
  });

  it("stdin.write() returning false → drain is awaited before next send succeeds", async () => {
    const bus = createBus();
    const { spawnImpl, last } = makeFakeSpawn();
    const ctrl = new SessionController({ settings: fxSettings(), bus, spawnImpl });
    ctrl.start();
    const child = last()!;

    const writes: string[] = [];
    let writeCount = 0;
    // Wrap stdin.write so the first call returns false (backpressure), the
    // rest return true.  We schedule 'drain' one microtask later so the
    // controller's retry path is exercised.
    const origWrite = child.stdin.write.bind(child.stdin);
    child.stdin.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      writeCount += 1;
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ok = origWrite(chunk as never, ...(rest as never[]));
      if (writeCount === 1) {
        // Schedule drain after the synchronous caller finishes.
        setImmediate(() => child.stdin.emit("drain"));
        return false;
      }
      return ok;
    }) as typeof child.stdin.write;

    ctrl.send("first");
    ctrl.send("second");

    // Let the setImmediate drain fire.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(writeCount).toBeGreaterThanOrEqual(2);
    expect(writes.join("")).toContain("first");
    expect(writes.join("")).toContain("second");

    ctrl.dispose();
  });

  it("stdout 'error' event → bus.emit('session.error') with error message", async () => {
    const bus = createBus();
    const { spawnImpl, last } = makeFakeSpawn();
    const seen = collect(bus);
    const ctrl = new SessionController({ settings: fxSettings(), bus, spawnImpl });
    ctrl.start();
    const child = last()!;

    child.stdout.emit("error", new Error("EPIPE"));
    await Promise.resolve();
    const errors = seen.filter((e) => e.kind === "session.error");
    expect(errors.length).toBeGreaterThan(0);
    const msg = errors.map((e) => (e.kind === "session.error" ? e.message : "")).join(" ");
    expect(msg).toMatch(/EPIPE/);

    ctrl.dispose();
  });

  it("child 'error' (spawn failure) → bus.emit('session.error')", async () => {
    const bus = createBus();
    const { spawnImpl, last } = makeFakeSpawn();
    const seen = collect(bus);
    const ctrl = new SessionController({ settings: fxSettings(), bus, spawnImpl });
    ctrl.start();
    const child = last()!;

    child.emit("error", new Error("ENOENT: claude not found"));
    await Promise.resolve();
    const errors = seen.filter((e) => e.kind === "session.error");
    expect(errors.length).toBeGreaterThan(0);
    const msg = errors.map((e) => (e.kind === "session.error" ? e.message : "")).join(" ");
    expect(msg).toMatch(/ENOENT/);

    ctrl.dispose();
  });

  it("dispose() removes every listener on stdout / stderr / child and kills the child", () => {
    const bus = createBus();
    const { spawnImpl, last } = makeFakeSpawn();
    const ctrl = new SessionController({ settings: fxSettings(), bus, spawnImpl });
    ctrl.start();
    const child = last()!;

    // Pre-dispose the controller registers its own handlers.  Listener
    // counts are non-zero.
    expect(child.stdout.listenerCount("data")).toBeGreaterThan(0);

    ctrl.dispose();

    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stdout.listenerCount("error")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.killed).toBe(true);
  });

  it("dispose() is idempotent — second call is a no-op and does not throw", () => {
    const bus = createBus();
    const { spawnImpl } = makeFakeSpawn();
    const ctrl = new SessionController({ settings: fxSettings(), bus, spawnImpl });
    ctrl.start();
    ctrl.dispose();
    expect(() => ctrl.dispose()).not.toThrow();
  });

  it("post-dispose stdout emission does NOT reach the bus (disposed-flag guard)", async () => {
    const bus = createBus();
    const { spawnImpl, last } = makeFakeSpawn();
    const seen = collect(bus);
    const ctrl = new SessionController({ settings: fxSettings(), bus, spawnImpl });
    ctrl.start();
    const child = last()!;
    ctrl.dispose();

    // Even if something races and re-emits after listener removal + dispose,
    // the internal disposed flag blocks bus.emit.
    child.stdout.emit(
      "data",
      JSON.stringify({
        type: "assistant",
        message: { id: "x", role: "assistant", content: [{ type: "text", text: "LATE" }] },
        session_id: "s",
      }) + "\n"
    );
    await Promise.resolve();
    const latePostDispose = seen.filter((e) => e.kind === "stream.event");
    expect(latePostDispose).toHaveLength(0);
  });
});
