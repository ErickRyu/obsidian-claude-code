/**
 * Sub-AC 2 of AC 8 — Child-process error surface + cleanup contract.
 *
 * Scope: wire spawn failure and EPIPE handling in the `claude -p`
 * child_process layer to route errors through the ErrorSurface policy
 * (`bus.emit({kind:'session.error', message})`) with proper cleanup of the
 * spawned process.  Phase 3's `src/webview/session/session-controller.ts`
 * will implement this contract; this iteration locks the behavioral
 * envelope so Phase 3's implementation cannot silently regress error
 * handling or leak listeners onto the long-lived child process.
 *
 * Phase-gate compliance: The runtime `SessionController` class lives on
 * the Phase 3 file allowlist, so we MUST NOT add
 * `src/webview/session/session-controller.ts` in Phase 2.  Instead, the
 * contract is captured by a test-local reference harness
 * (`wireChildProcessErrorSurface`) defined below.  When Phase 3 lands,
 * its `SessionController` implementation is required to exhibit every
 * behavior pinned by this file.  The harness intentionally uses the
 * same `Bus` instance type Phase 3 will wire through.
 *
 * Error-surface-discipline (from the v0.6.0 constraints):
 *   - spawn failure   → `session.error` with message beginning "spawn failed"
 *   - stdin EPIPE     → `session.error` with message beginning "EPIPE" or
 *                       "stdin closed"; never a re-throw
 *   - stdin destroyed → same; the harness short-circuits the write instead
 *                       of letting Node throw ERR_STREAM_DESTROYED
 *   - stderr bytes    → `session.error` with the stderr line as message
 *   - non-zero exit   → `session.error` with code in the message
 *   - backpressure    → write() returning false gates subsequent writes on
 *                       a 'drain' event; no silent drop
 *
 * Cleanup contract (MH-11 partner):
 *   - dispose() removes every listener on child / child.stdin /
 *     child.stdout / child.stderr (listenerCount across EVERY event
 *     name must be 0 post-dispose)
 *   - dispose() calls child.kill('SIGTERM') exactly once
 *   - dispose() is idempotent — calling twice is safe
 *   - stdout chunks arriving AFTER dispose must not reach the bus
 *     (double-guard: listener already detached AND the harness ignores
 *     post-dispose deliveries)
 *
 * Assertion style: behavioral counts + payload-field checks only.  No
 * HTML / JSON snapshots.
 */
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createBus, type Bus } from "../../src/webview/event-bus";

// ---------------------------------------------------------------------------
// Minimal structural types modeling the subset of Node's ChildProcess that
// SessionController relies on.  Using a structural interface rather than
// `import type {ChildProcess}` keeps the fake lightweight and forces the
// production implementation (Phase 3) to rely only on these fields too.
// ---------------------------------------------------------------------------

interface WritableLike extends EventEmitter {
  write(chunk: string): boolean;
  destroyed: boolean;
  end(): void;
}

interface ReadableLike extends EventEmitter {
  setEncoding(enc: string): void;
}

interface ChildLike extends EventEmitter {
  readonly stdin: WritableLike;
  readonly stdout: ReadableLike;
  readonly stderr: ReadableLike;
  kill(signal?: string): boolean;
  killed: boolean;
}

// ---------------------------------------------------------------------------
// Fake ChildProcess builder — EventEmitter-backed so listenerCount() works
// naturally.  stdin is a PassThrough so `write()` returns a boolean and a
// 'drain' event is emitable; stdout/stderr are PassThroughs so chunk
// `.emit('data', ...)` works.
// ---------------------------------------------------------------------------

interface FakeChild extends ChildLike {
  killCalls: string[];
  triggerDrain(): void;
  simulateSpawnError(err: Error): void;
  simulateStderr(chunk: string): void;
  simulateStdout(chunk: string): void;
  simulateExit(code: number | null, signal?: string | null): void;
  simulateStdinEpipe(): void;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as EventEmitter & Partial<FakeChild>;
  const stdin = new PassThrough() as unknown as WritableLike;
  const stdout = new PassThrough() as unknown as ReadableLike;
  const stderr = new PassThrough() as unknown as ReadableLike;

  const killCalls: string[] = [];

  Object.defineProperties(child, {
    stdin: { value: stdin, enumerable: true },
    stdout: { value: stdout, enumerable: true },
    stderr: { value: stderr, enumerable: true },
    killed: { value: false, writable: true, enumerable: true },
    killCalls: { value: killCalls, enumerable: true },
  });

  (child as FakeChild).kill = (signal?: string): boolean => {
    killCalls.push(signal ?? "SIGTERM");
    (child as FakeChild).killed = true;
    return true;
  };
  (child as FakeChild).triggerDrain = (): void => {
    stdin.emit("drain");
  };
  (child as FakeChild).simulateSpawnError = (err: Error): void => {
    child.emit("error", err);
  };
  (child as FakeChild).simulateStderr = (chunk: string): void => {
    stderr.emit("data", chunk);
  };
  (child as FakeChild).simulateStdout = (chunk: string): void => {
    stdout.emit("data", chunk);
  };
  (child as FakeChild).simulateExit = (
    code: number | null,
    signal?: string | null,
  ): void => {
    child.emit("exit", code, signal ?? null);
    child.emit("close", code, signal ?? null);
  };
  (child as FakeChild).simulateStdinEpipe = (): void => {
    const err = new Error("write EPIPE") as Error & { code?: string };
    err.code = "EPIPE";
    stdin.emit("error", err);
  };

  return child as FakeChild;
}

// ---------------------------------------------------------------------------
// Reference harness — wireChildProcessErrorSurface.
//
// This is the Phase 3 SessionController error-surface contract in
// functional form.  Phase 3's class implementation MUST preserve every
// invariant exercised below; the test file is the living spec for it.
// ---------------------------------------------------------------------------

export interface HarnessResult {
  /** Queue one JSONL line for stdin; returns false if stdin is unusable. */
  send(json: string): boolean;
  /** Tear everything down: remove listeners, SIGTERM, never throw. */
  dispose(): void;
  /** Whether the harness has observed a hard stop (spawn-fail / exit / dispose). */
  isDead(): boolean;
}

interface HarnessOptions {
  readonly bus: Bus;
  readonly child: ChildLike;
  /** Prefix applied to every session.error message (namespace hygiene). */
  readonly errorPrefix?: string;
}

/**
 * Wires the bus-level error surface onto a spawned child process.  The
 * function itself never throws; every error path emits a `session.error`
 * bus event.
 */
function wireChildProcessErrorSurface(opts: HarnessOptions): HarnessResult {
  const { bus, child } = opts;
  const errorPrefix = opts.errorPrefix ?? "";
  let dead = false;
  let awaitingDrain = false;
  const pendingWrites: string[] = [];

  const emitError = (message: string): void => {
    bus.emit({ kind: "session.error", message: errorPrefix + message });
  };

  // --- UTF-8 boundary safety before wiring listeners -----------------------
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  // --- child-level 'error' (spawn failure, uncaught child-level issue) ----
  child.on("error", (err: unknown) => {
    if (dead) return;
    const message =
      err instanceof Error
        ? `spawn failed: ${err.message}`
        : `spawn failed: ${String(err)}`;
    emitError(message);
    markDead();
  });

  // --- child exit ---------------------------------------------------------
  child.on("exit", (code: number | null, signal: string | null) => {
    if (dead) return;
    if (code !== 0 && code !== null) {
      emitError(`claude exited with code ${code}`);
    } else if (signal !== null && signal !== undefined) {
      emitError(`claude terminated by signal ${signal}`);
    }
    markDead();
  });

  // --- stderr surfacing ---------------------------------------------------
  child.stderr.on("data", (chunk: unknown) => {
    if (dead) return;
    const line = String(chunk).trim();
    if (line.length === 0) return;
    emitError(`stderr: ${line}`);
  });

  // --- stdin error (EPIPE, write after close) -----------------------------
  child.stdin.on("error", (err: unknown) => {
    if (dead) return;
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : "";
    const msg =
      err instanceof Error ? err.message : String(err);
    if (code === "EPIPE") {
      emitError(`EPIPE — stdin closed by child: ${msg}`);
    } else {
      emitError(`stdin error: ${msg}`);
    }
    markDead();
  });

  // --- backpressure drain -------------------------------------------------
  child.stdin.on("drain", () => {
    awaitingDrain = false;
    flushPending();
  });

  function flushPending(): void {
    while (pendingWrites.length > 0 && !awaitingDrain && !dead) {
      const next = pendingWrites.shift();
      if (next === undefined) break;
      const ok = doWrite(next);
      if (!ok) break;
    }
  }

  function doWrite(json: string): boolean {
    if (dead) return false;
    if (child.stdin.destroyed) {
      emitError("EPIPE — stdin destroyed before write");
      markDead();
      return false;
    }
    try {
      const accepted = child.stdin.write(json + "\n");
      if (!accepted) {
        awaitingDrain = true;
      }
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      emitError(`stdin write threw: ${msg}`);
      markDead();
      return false;
    }
  }

  function markDead(): void {
    dead = true;
  }

  return {
    send(json: string): boolean {
      if (dead) {
        emitError("send after dispose — ignored");
        return false;
      }
      if (awaitingDrain) {
        // Backpressure: queue instead of dropping.
        pendingWrites.push(json);
        return true;
      }
      return doWrite(json);
    },
    dispose(): void {
      if (dead) {
        // Idempotent — still make sure listeners are gone.
        child.stdin.removeAllListeners();
        child.stdout.removeAllListeners();
        child.stderr.removeAllListeners();
        child.removeAllListeners();
        return;
      }
      dead = true;
      child.stdin.removeAllListeners();
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();
      try {
        child.kill("SIGTERM");
      } catch {
        // kill() is best-effort; if the child is already gone the OS
        // returns false / throws ESRCH — we still honor dispose().
      }
    },
    isDead(): boolean {
      return dead;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectSessionErrors(bus: Bus): string[] {
  const out: string[] = [];
  bus.on("session.error", (ev) => out.push(ev.message));
  return out;
}

function totalListenerCount(child: ChildLike): number {
  return (
    child.listenerCount("error") +
    child.listenerCount("exit") +
    child.listenerCount("close") +
    child.stdin.listenerCount("error") +
    child.stdin.listenerCount("drain") +
    child.stdout.listenerCount("data") +
    child.stdout.listenerCount("error") +
    child.stderr.listenerCount("data") +
    child.stderr.listenerCount("error")
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Sub-AC 2 of AC 8 — child_process error surface policy", () => {
  describe("spawn failure", () => {
    it("child 'error' event before 'spawn' becomes session.error 'spawn failed: …'", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const child = makeFakeChild();
      const h = wireChildProcessErrorSurface({ bus, child });

      child.simulateSpawnError(
        Object.assign(new Error("ENOENT: claude not found"), { code: "ENOENT" }),
      );

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBe("spawn failed: ENOENT: claude not found");
      expect(h.isDead()).toBe(true);
      h.dispose();
      bus.dispose();
    });

    it("non-Error thrown on spawn is stringified rather than crashing the bus", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const child = makeFakeChild();
      const h = wireChildProcessErrorSurface({ bus, child });

      // Cast to the Error param type so TypeScript accepts the emit call.
      // The runtime contract is that the harness normalizes via String().
      child.emit("error", "raw-string-error" as unknown as Error);

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBe("spawn failed: raw-string-error");
      expect(h.isDead()).toBe(true);
      bus.dispose();
    });

    it("send() after spawn failure emits session.error and returns false (no late writes)", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const child = makeFakeChild();
      const h = wireChildProcessErrorSurface({ bus, child });

      child.simulateSpawnError(new Error("boom"));
      const accepted = h.send('{"type":"user","message":{"role":"user","content":"x"}}');

      expect(accepted).toBe(false);
      expect(errors).toContain("send after dispose — ignored");
      bus.dispose();
    });
  });

  describe("EPIPE and stdin destroyed", () => {
    it("stdin 'error' with code=EPIPE becomes session.error starting with 'EPIPE'", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const child = makeFakeChild();
      wireChildProcessErrorSurface({ bus, child });

      child.simulateStdinEpipe();

      expect(errors).toHaveLength(1);
      expect(errors[0].startsWith("EPIPE")).toBe(true);
      expect(errors[0]).toContain("write EPIPE");
      bus.dispose();
    });

    it("write to destroyed stdin short-circuits with 'EPIPE — stdin destroyed before write' (no throw)", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const child = makeFakeChild();
      const h = wireChildProcessErrorSurface({ bus, child });

      // Mark stdin destroyed BEFORE sending.
      (child.stdin as unknown as { destroyed: boolean }).destroyed = true;

      expect(() => h.send("{}")).not.toThrow();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBe("EPIPE — stdin destroyed before write");
      expect(h.isDead()).toBe(true);
      bus.dispose();
    });

    it("stdin write() that synchronously throws is caught and surfaces as 'stdin write threw'", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const child = makeFakeChild();
      // Monkey-patch stdin.write so it throws on the next invocation.
      const throwingWrite: WritableLike["write"] = () => {
        throw new Error("simulated ERR_STREAM_DESTROYED");
      };
      (child.stdin as unknown as { write: WritableLike["write"] }).write =
        throwingWrite;

      const h = wireChildProcessErrorSurface({ bus, child });
      const accepted = h.send('{"probe":true}');

      expect(accepted).toBe(false);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBe(
        "stdin write threw: simulated ERR_STREAM_DESTROYED",
      );
      expect(h.isDead()).toBe(true);
      bus.dispose();
    });
  });

  describe("backpressure (drain)", () => {
    it("write() returning false queues subsequent sends until 'drain', then flushes", () => {
      const bus = createBus();
      const child = makeFakeChild();

      // Force write() to return false on first call, true thereafter.
      let callCount = 0;
      const origWrite = child.stdin.write.bind(child.stdin);
      const seenChunks: string[] = [];
      (child.stdin as unknown as { write: WritableLike["write"] }).write = (
        chunk: string,
      ): boolean => {
        callCount += 1;
        seenChunks.push(chunk);
        if (callCount === 1) {
          return false;
        }
        return origWrite(chunk);
      };

      const h = wireChildProcessErrorSurface({ bus, child });

      // First send — back-pressured, returns true (queued), no drain yet.
      expect(h.send('{"n":1}')).toBe(true);
      // Second send — harness is awaiting-drain, so it queues instead of
      // writing.
      expect(h.send('{"n":2}')).toBe(true);
      expect(callCount).toBe(1); // only first write attempted
      expect(seenChunks).toEqual(['{"n":1}\n']);

      // Fire drain — harness flushes the one queued write.
      child.triggerDrain();
      expect(callCount).toBe(2);
      expect(seenChunks).toEqual(['{"n":1}\n', '{"n":2}\n']);
      bus.dispose();
    });
  });

  describe("stderr surfacing", () => {
    it("stderr 'data' chunks become session.error messages with 'stderr:' prefix", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const child = makeFakeChild();
      wireChildProcessErrorSurface({ bus, child });

      child.simulateStderr("warn: slow response\n");
      child.simulateStderr("error: rate-limited");

      expect(errors).toEqual([
        "stderr: warn: slow response",
        "stderr: error: rate-limited",
      ]);
      bus.dispose();
    });

    it("empty / whitespace-only stderr chunks are dropped (no noise)", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const child = makeFakeChild();
      wireChildProcessErrorSurface({ bus, child });

      child.simulateStderr("\n");
      child.simulateStderr("   ");
      child.simulateStderr("");

      expect(errors).toEqual([]);
      bus.dispose();
    });
  });

  describe("exit codes", () => {
    it("exit code=0 does NOT emit session.error (normal completion)", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const child = makeFakeChild();
      wireChildProcessErrorSurface({ bus, child });

      child.simulateExit(0, null);
      expect(errors).toEqual([]);
      bus.dispose();
    });

    it("exit code !== 0 emits session.error with code in message", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const child = makeFakeChild();
      wireChildProcessErrorSurface({ bus, child });

      child.simulateExit(127, null);
      expect(errors).toEqual(["claude exited with code 127"]);
      bus.dispose();
    });

    it("exit by signal (code=null, signal=SIGTERM) emits terminated-by-signal message", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const child = makeFakeChild();
      wireChildProcessErrorSurface({ bus, child });

      child.simulateExit(null, "SIGTERM");
      expect(errors).toEqual(["claude terminated by signal SIGTERM"]);
      bus.dispose();
    });
  });

  describe("cleanup — dispose() semantics", () => {
    it("dispose() removes every listener across child / stdin / stdout / stderr", () => {
      const bus = createBus();
      const child = makeFakeChild();
      const h = wireChildProcessErrorSurface({ bus, child });
      // Wire an extra listener on stdout to simulate a renderer subscription.
      child.stdout.on("data", () => {});

      expect(totalListenerCount(child)).toBeGreaterThan(0);
      h.dispose();
      expect(totalListenerCount(child)).toBe(0);
      bus.dispose();
    });

    it("dispose() calls child.kill('SIGTERM') exactly once", () => {
      const bus = createBus();
      const child = makeFakeChild();
      const h = wireChildProcessErrorSurface({ bus, child });
      expect(child.killCalls).toEqual([]);
      h.dispose();
      expect(child.killCalls).toEqual(["SIGTERM"]);
      bus.dispose();
    });

    it("dispose() is idempotent — calling twice is safe and does not double-kill", () => {
      const bus = createBus();
      const child = makeFakeChild();
      const h = wireChildProcessErrorSurface({ bus, child });

      h.dispose();
      expect(() => h.dispose()).not.toThrow();
      expect(child.killCalls).toEqual(["SIGTERM"]); // still only 1 kill
      expect(totalListenerCount(child)).toBe(0);
      bus.dispose();
    });

    it("post-dispose stdout 'data' emit does NOT reach the bus (MH-11 partner guard)", () => {
      const bus = createBus();
      const streamEventSpy = vi.fn();
      bus.on("stream.event", streamEventSpy);
      const errors = collectSessionErrors(bus);
      const child = makeFakeChild();
      const h = wireChildProcessErrorSurface({ bus, child });
      h.dispose();

      // Even though we emit a well-formed assistant event, the bus must
      // remain silent because the stdout listener has been removed.
      child.simulateStdout(
        JSON.stringify({
          type: "assistant",
          message: {
            id: "msg-post",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "SHOULD_NOT_RENDER" }],
          },
          session_id: "s-post",
          uuid: "u-post",
        }) + "\n",
      );
      // No stream.event fired because the harness owns no
      // stdout.data→parse→bus wiring (that's a later Phase 3 concern) —
      // what matters here is zero delivery of session.error downstream
      // from a post-dispose stdout emit.
      expect(streamEventSpy).not.toHaveBeenCalled();
      expect(errors).toEqual([]);
      bus.dispose();
    });

    it("dispose() after spawn failure still removes listeners (cleanup runs on failed spawn too)", () => {
      const bus = createBus();
      const child = makeFakeChild();
      const h = wireChildProcessErrorSurface({ bus, child });

      child.simulateSpawnError(new Error("boom"));
      // After spawn failure, harness is dead but listeners may still
      // reference the defunct child.  dispose() must still clear them.
      expect(totalListenerCount(child)).toBeGreaterThanOrEqual(0);
      h.dispose();
      expect(totalListenerCount(child)).toBe(0);
      bus.dispose();
    });
  });

  describe("error never escapes harness", () => {
    it("every surfaced error class is a session.error emit — harness never throws to the caller", () => {
      const bus = createBus();
      const child = makeFakeChild();
      const h = wireChildProcessErrorSurface({ bus, child });

      // Exercise every path in one go.
      expect(() => child.simulateSpawnError(new Error("boom1"))).not.toThrow();
      expect(() => child.simulateStderr("warn")).not.toThrow();
      expect(() => child.simulateStdinEpipe()).not.toThrow();
      expect(() => child.simulateExit(1, null)).not.toThrow();
      expect(() => h.send("{}")).not.toThrow();
      expect(() => h.dispose()).not.toThrow();
      expect(() => h.dispose()).not.toThrow();
      bus.dispose();
    });
  });
});
