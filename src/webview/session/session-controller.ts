/**
 * SessionController — Phase 3 Task 2.
 *
 * Owns one `claude -p --output-format=stream-json` child process and bridges
 * it to the webview `Bus`.  Responsibilities:
 *
 *   1. `start()` — spawn the child via the injected `SpawnImpl` using
 *      argv from `buildSpawnArgs(settings, {resumeId})`, set utf-8 encoding
 *      on the stdout/stderr side, and register the data/exit/error
 *      listeners that emit to the bus.
 *   2. `send(text)` — write a JSONL user turn to `child.stdin` with a
 *      trailing `\n`, with EPIPE / backpressure defense:
 *        - `stdin.destroyed` → emit `session.error` and drop the write.
 *        - `stdin.write()` returning false → queue subsequent payloads
 *          and drain them once the stream emits `drain`.
 *        - `stdin` `error` events surface as `session.error`.
 *   3. `dispose()` — MUST remove every listener on
 *      `child.stdout` / `child.stderr` / `child.stdin` / `child` and
 *      call `child.kill('SIGTERM')`.  This is the runtime gate for
 *      MH-11 (view-lifecycle.test.ts 3-4 / 3-5).  Idempotent.
 *
 * The controller is DOM-free.  The view.ts owner is responsible for the
 * double-guard (`this.disposed || this.leaf.view !== this`) before
 * dispatching bus events into renderers.
 *
 * Orphan tracking: `activeSessionControllers` is the plugin-scope registry
 * `wireWebview()` drains on `plugin.register(() => disposeAllSessionControllers())`
 * so a reload that skips `onClose` does not leave live child processes
 * behind.
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { LineBuffer } from "../parser/line-buffer";
import { parseLine } from "../parser/stream-json-parser";
import type { StreamEvent } from "../parser/types";
import type { Bus } from "../event-bus";
import { buildSpawnArgs, type SpawnArgsSettings } from "./spawn-args";
import type { SessionArchive } from "./session-archive";

/**
 * The spawn function the controller calls.  The production wiring passes
 * `node:child_process`'s `spawn`; tests pass a fake that returns an
 * `EventEmitter`-based stand-in.  `options.cwd` is the only SpawnOptions
 * field we pass through — the controller sets stdio to `["pipe","pipe","pipe"]`
 * internally.
 */
export type SpawnImpl = (
  cmd: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export interface SessionControllerOptions {
  readonly settings: SpawnArgsSettings;
  readonly bus: Bus;
  readonly spawnImpl: SpawnImpl;
  readonly cwd?: string;
  /**
   * Phase 5a — fired the first time a `result` event arrives with a
   * non-empty `session_id`. The webview wiring uses this to persist the
   * id into `settings.lastSessionId` so a later "Resume last" command
   * can append `--resume <id>`. Idempotent within a single controller
   * instance: subsequent result events with the same id do not re-fire.
   */
  readonly onSessionId?: (sessionId: string) => void;
  /**
   * Phase 5b — when wired, every parsed `StreamEvent` is also appended
   * to the archive under the first session_id observed on the stream.
   * Events arriving before a session_id is known are buffered in-memory
   * and flushed on the first session-id-bearing event (typically
   * `system.init`). Dropped-silently in error scenarios so a filesystem
   * hiccup never crashes the rendering pipeline — the archive is
   * best-effort, the bus dispatch is authoritative.
   */
  readonly archive?: SessionArchive;
}

const activeSessionControllers = new Set<SessionController>();

/**
 * Plugin-unload drain: disposes every controller that `onClose` did not
 * already clean up.  Safe to call multiple times — `dispose()` is idempotent.
 */
export function disposeAllSessionControllers(): void {
  const snapshot = Array.from(activeSessionControllers);
  for (const c of snapshot) {
    try {
      c.dispose();
    } catch {
      // Continue — one failing dispose must not block the rest.
    }
  }
}

export class SessionController {
  private child: ChildProcess | null = null;
  private readonly lineBuffer = new LineBuffer();
  private disposed = false;
  private readonly drainQueue: string[] = [];
  private awaitingDrain = false;
  private lastNotifiedSessionId: string | null = null;
  /**
   * Phase 5b archive bookkeeping. `capturedSessionId` is set the first
   * time any parsed event exposes a non-empty session_id (typically
   * `system.init`). Until then, events accumulate in `pendingArchive`
   * and are flushed in-order once the id is known.
   */
  private capturedSessionId: string | null = null;
  private pendingArchive: StreamEvent[] = [];

  constructor(private readonly opts: SessionControllerOptions) {
    activeSessionControllers.add(this);
  }

  /** Whether the child process has been spawned. */
  isStarted(): boolean {
    return this.child !== null;
  }

  /**
   * Spawn the child process.  No-op when already started or after dispose.
   * `initialText`, when non-empty, is sent as the first user turn
   * immediately after spawn — the common "open webview with a prompt"
   * path.  `resumeId` appends `--resume <id>` to argv.
   */
  start(initialText?: string, resumeId?: string): void {
    if (this.disposed) return;
    if (this.child) return;

    const options =
      resumeId !== undefined && resumeId.length > 0
        ? { resumeId }
        : {};
    const { cmd, args } = buildSpawnArgs(this.opts.settings, options);

    const spawnOpts: SpawnOptions = {
      stdio: ["pipe", "pipe", "pipe"],
    };
    if (this.opts.cwd !== undefined) {
      spawnOpts.cwd = this.opts.cwd;
    }

    const child = this.opts.spawnImpl(cmd, args, spawnOpts);
    this.child = child;

    if (child.stdout !== null) child.stdout.setEncoding("utf8");
    if (child.stderr !== null) child.stderr.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => this.handleStdoutData(chunk));
    child.stdout?.on("error", (err: Error) =>
      this.emitError(`stdout: ${err.message}`),
    );
    child.stderr?.on("data", (chunk: string) => this.handleStderrData(chunk));
    child.stdin?.on("error", (err: Error) =>
      this.emitError(`stdin: ${err.message}`),
    );
    child.on("exit", (code: number | null) => this.handleExit(code));
    child.on("error", (err: Error) =>
      this.emitError(`spawn: ${err.message}`),
    );

    // With --input-format stream-json, the first user message must be
    // written to stdin as JSONL (not as a -p argument). Send it now —
    // the pipe buffers, so it's safe even before claude is fully ready.
    if (initialText !== undefined && initialText.length > 0) {
      this.send(initialText);
    }
  }

  /**
   * Write a JSONL user turn to stdin.  Applies backpressure handling
   * (queue → drain) and EPIPE defense (destroyed-stdin short-circuit).
   */
  send(text: string): void {
    if (this.disposed) return;
    const child = this.child;
    if (!child) {
      this.emitError("send: controller not started");
      return;
    }
    const stdin = child.stdin;
    if (!stdin) {
      this.emitError("stdin: unavailable");
      return;
    }
    if (stdin.destroyed) {
      this.emitError("stdin: destroyed");
      return;
    }

    const payload = encodeUserTurn(text);

    if (this.awaitingDrain) {
      this.drainQueue.push(payload);
      return;
    }

    const ok = stdin.write(payload);
    if (!ok) {
      this.awaitingDrain = true;
      stdin.once("drain", () => this.flushDrainQueue());
    }
  }

  private flushDrainQueue(): void {
    if (this.disposed) return;
    const child = this.child;
    if (!child) return;
    const stdin = child.stdin;
    if (!stdin) return;
    this.awaitingDrain = false;
    while (this.drainQueue.length > 0) {
      if (stdin.destroyed) {
        this.emitError("stdin: destroyed");
        this.drainQueue.length = 0;
        return;
      }
      const next = this.drainQueue.shift();
      if (next === undefined) break;
      const ok = stdin.write(next);
      if (!ok) {
        this.awaitingDrain = true;
        stdin.once("drain", () => this.flushDrainQueue());
        return;
      }
    }
  }

  private handleStdoutData(chunk: string): void {
    if (this.disposed) return;
    const lines = this.lineBuffer.feed(chunk);
    for (const line of lines) {
      const parsed = parseLine(line);
      if (parsed.ok) {
        this.notifySessionIdIfNew(parsed.event);
        this.archiveEvent(parsed.event);
        this.opts.bus.emit({ kind: "stream.event", event: parsed.event });
      }
      // Malformed lines are silent: `parser-schema.test.ts` already
      // exercises the schema-rejection branch; surfacing them here as
      // session.error would spam during normal claude -p warm-up.
    }
  }

  /**
   * Phase 5b — mirror each parsed event into the archive. Events that
   * arrive before a session_id is observed are buffered (typically a
   * short window: `system.init` carries session_id and is the first
   * event on a healthy stream). A filesystem error surfaces as
   * `session.error` but does NOT interrupt bus dispatch — archive is
   * best-effort.
   */
  private archiveEvent(event: StreamEvent): void {
    if (this.disposed) return;
    const archive = this.opts.archive;
    if (!archive) return;

    if (this.capturedSessionId === null) {
      const sid = extractSessionId(event);
      if (sid === null) {
        this.pendingArchive.push(event);
        return;
      }
      this.capturedSessionId = sid;
      // Per-event try/catch — a transient FS error on event N must not
      // silently discard events N+1..end. Each failure still emits a
      // single `session.error` so the UI surfaces the incident without
      // spamming if the FS is totally wedged.
      let dropped = 0;
      let firstErr: string | null = null;
      for (const buffered of this.pendingArchive) {
        try {
          archive.append(sid, buffered);
        } catch (err: unknown) {
          dropped++;
          if (firstErr === null) {
            firstErr = err instanceof Error ? err.message : String(err);
          }
        }
      }
      if (firstErr !== null) {
        this.emitError(
          `archive flush: ${firstErr} (dropped ${dropped} buffered event(s))`,
        );
      }
      this.pendingArchive = [];
    }

    const sid = this.capturedSessionId;
    if (sid === null) return;
    try {
      archive.append(sid, event);
    } catch (err: unknown) {
      this.emitError(
        `archive append: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private notifySessionIdIfNew(event: StreamEvent): void {
    // MED-2 (review) — guard against a late stdout/handleExit delivery
    // racing a dispose. `persistSettings` touches Obsidian internals
    // (saveSettings) and must not fire for a closed controller.
    if (this.disposed) return;
    if (event.type !== "result") return;
    const sid = event.session_id;
    if (typeof sid !== "string" || sid.length === 0) return;
    if (sid === this.lastNotifiedSessionId) return;
    this.lastNotifiedSessionId = sid;
    const cb = this.opts.onSessionId;
    if (cb) {
      try {
        cb(sid);
      } catch {
        // Callback failures must never poison stdout parsing — we log via
        // session.error so the UI surfaces the incident.
        this.emitError("onSessionId callback threw");
      }
    }
  }

  private handleStderrData(chunk: string): void {
    if (this.disposed) return;
    if (chunk.length === 0) return;
    this.opts.bus.emit({
      kind: "session.error",
      message: `stderr: ${chunk}`,
    });
  }

  private handleExit(code: number | null): void {
    if (this.disposed) return;
    const tail = this.lineBuffer.flush();
    if (tail !== null) {
      const parsed = parseLine(tail);
      if (parsed.ok) {
        this.notifySessionIdIfNew(parsed.event);
        this.archiveEvent(parsed.event);
        this.opts.bus.emit({ kind: "stream.event", event: parsed.event });
      }
    }
    this.opts.bus.emit({
      kind: "session.error",
      message: `exit: ${code === null ? "null" : String(code)}`,
    });
  }

  private emitError(message: string): void {
    if (this.disposed) return;
    this.opts.bus.emit({ kind: "session.error", message });
  }

  /**
   * Tear down the child.  Idempotent.
   *
   * Order matters: listeners are removed BEFORE `kill` so a dying child
   * that re-emits `exit`/`error` cannot race into the bus.  Listeners
   * on stdin/stdout/stderr AND on the ChildProcess itself are all
   * cleared — the MH-11 contract requires `listenerCount` === 0 for
   * each of the four surfaces.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    activeSessionControllers.delete(this);

    const child = this.child;
    this.child = null;
    this.drainQueue.length = 0;
    this.awaitingDrain = false;
    // HIGH (review) — release pendingArchive refs eagerly. On a path where
    // the controller is disposed without its owning bus (e.g. plugin
    // unload calling `disposeAllSessionControllers` from the orphan
    // registry), a closure on the bus may hold this instance alive until
    // unload finishes, and any unflushed events would stay retained.
    // Matches drainQueue's eager clear above.
    this.pendingArchive = [];
    this.capturedSessionId = null;

    if (!child) return;

    try {
      child.stdout?.removeAllListeners();
    } catch {
      // Continue — dispose must not throw.
    }
    try {
      child.stderr?.removeAllListeners();
    } catch {
      // Continue.
    }
    try {
      child.stdin?.removeAllListeners();
    } catch {
      // Continue.
    }
    try {
      child.removeAllListeners();
    } catch {
      // Continue.
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // Continue — the child may already be dead.
    }
  }
}

/**
 * Extract the `session_id` from any `StreamEvent` variant that carries one.
 * Returns `null` for `UnknownEvent` and for events whose `session_id` is
 * missing / empty. Phase 5b archive capture uses this to learn the id from
 * the first emitting event (typically `system.init`) rather than waiting
 * for the final `result` event.
 */
function extractSessionId(event: StreamEvent): string | null {
  switch (event.type) {
    case "system":
    case "assistant":
    case "rate_limit_event":
    case "result": {
      const sid = event.session_id;
      return typeof sid === "string" && sid.length > 0 ? sid : null;
    }
    case "user": {
      const sid = event.session_id;
      return typeof sid === "string" && sid.length > 0 ? sid : null;
    }
    case "__unknown__":
      return null;
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return null;
    }
  }
}

/**
 * Encode a plain-text user turn as the stream-json JSONL line the CLI
 * expects (`--input-format=stream-json`).  Keeping this pure + named so
 * tests can re-derive the expected payload without importing the class.
 */
function encodeUserTurn(text: string): string {
  const payload = {
    type: "user" as const,
    message: {
      role: "user" as const,
      content: [{ type: "text" as const, text }],
    },
  };
  return JSON.stringify(payload) + "\n";
}
