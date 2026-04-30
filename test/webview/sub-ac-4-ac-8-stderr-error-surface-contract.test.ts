/**
 * Sub-AC 4 of AC 8 — Stderr warning-vs-fatal error-surface contract.
 *
 * Scope: wire `claude -p` child_process.stderr non-empty handling to route
 * every captured line through the ErrorSurface policy
 * (`bus.emit({kind:'session.error', message})`), **distinguishing warnings
 * from fatal errors** by message prefix.  Sub-AC 2 of AC 8 pinned the basic
 * `stderr:` passthrough (spawn/EPIPE/exit/signal + generic stderr); this
 * iteration refines the stderr lane into three classes so the UI layer and
 * session-state machine (Phase 3+) can render / react differently.
 *
 * Phase-gate compliance: `src/webview/session/session-controller.ts` lives
 * on the Phase 3 allowlist, so the runtime wiring cannot land in Phase 2.
 * The behavioral envelope is captured by a test-local reference harness
 * (`wireStderrErrorSurface`) that composes the production `createBus`.
 * Phase 3's SessionController.stderr handling MUST exhibit every invariant
 * pinned here.  Backward-compat with Sub-AC 2 of AC 8: ambiguous stderr
 * still surfaces with the original `stderr:` prefix, so the prior contract
 * is a strict subset of this one.
 *
 * Error-surface-discipline (stderr-classifier slice):
 *   - FATAL class     → `session.error` with prefix "stderr-fatal:" +
 *                       classified keyword metadata; the `isFatal()` view
 *                       accessor returns true so Phase 3 can choose to
 *                       terminate the session.  Matches: "error", "fatal",
 *                       "panic", "crash", "aborted", "EPIPE",
 *                       "ECONNREFUSED", "unauthorized", and HTTP 4xx/5xx
 *                       status codes (case-insensitive, word-boundary).
 *   - WARN class      → `session.error` with prefix "stderr-warn:" and
 *                       classified keyword metadata; `isFatal()` returns
 *                       false.  Matches: "warn", "warning", "deprecated",
 *                       "notice", "info" (case-insensitive prefix or word-
 *                       boundary).
 *   - AMBIGUOUS class → `session.error` with the original "stderr:" prefix
 *                       (backward-compat).  `isFatal()` returns false.
 *   - Empty or whitespace-only line  → dropped (zero bus traffic).
 *   - Multi-line chunk               → split on "\n" and each non-empty
 *                                      trimmed line is classified
 *                                      independently.
 *   - Non-string chunk (Buffer etc.) → coerced via String(); never throws.
 *   - Giant line                     → truncated to `maxLinePreview`
 *                                      characters with a "…(N more chars)"
 *                                      marker.  The classifier runs
 *                                      against the FULL text before
 *                                      truncation so matches on trailing
 *                                      keywords are not missed.
 *   - ANSI escape sequences          → stripped from the classifier
 *                                      substring (the bus message still
 *                                      contains the raw bytes so debug
 *                                      users see the original stream).
 *   - Harness never throws to caller.
 *
 * Cleanup contract partner (MH-11): the harness exposes a `dispose()` that
 * is idempotent.  After dispose, further ingest() calls are dropped with a
 * `session.error` of class AMBIGUOUS prefix `stderr:` and body "ingest
 * after dispose — ignored" (never a silent swallow).
 *
 * Assertion style: behavioral counts + prefix-field checks on the bus
 * capture arrays.  No HTML / JSON snapshots.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createBus,
  type Bus,
  type BusEvent,
} from "../../src/webview/event-bus";

// ---------------------------------------------------------------------------
// Reference harness — wireStderrErrorSurface
//
// Phase 3 SessionController.stderr handling MUST preserve every invariant
// exercised below; this file is the living spec.
// ---------------------------------------------------------------------------

export type StderrClass = "fatal" | "warn" | "ambiguous";

export interface StderrClassification {
  readonly cls: StderrClass;
  readonly matchedKeyword: string | null;
  readonly prefix: "stderr-fatal:" | "stderr-warn:" | "stderr:";
}

export interface WireOptions {
  readonly bus: Bus;
  /** Max characters embedded in the emitted bus message. Default 240. */
  readonly maxLinePreview?: number;
}

export interface WireResult {
  /**
   * Feed a raw stderr chunk (string OR Buffer-like).  Splits on "\n", drops
   * empty / whitespace-only lines, classifies every other line and emits
   * one `session.error` per line.
   */
  ingest(chunk: unknown): void;
  /** Classify a SINGLE already-trimmed line (no splitting). */
  classify(line: string): StderrClassification;
  /** Teardown — idempotent.  Later ingest() calls become no-ops. */
  dispose(): void;
  /** True once a FATAL-class line has been observed (session-state hint). */
  isFatal(): boolean;
  /** Bookkeeping for evidence / tests. */
  stats(): HarnessStats;
}

export interface HarnessStats {
  readonly chunksIngested: number;
  readonly linesEmitted: number;
  readonly fatalEmitted: number;
  readonly warnEmitted: number;
  readonly ambiguousEmitted: number;
  readonly droppedEmptyLines: number;
  readonly disposed: boolean;
}

// Fatal classifier rules — every entry MUST match the line case-
// insensitively.  Keywords are word-boundary anchored; HTTP codes match
// space-separated or slash-separated digits.  The keyword text is returned
// verbatim in the classification.matchedKeyword field.
const FATAL_RULES: ReadonlyArray<{ kw: string; re: RegExp }> = [
  { kw: "error", re: /\berror\b/i },
  { kw: "fatal", re: /\bfatal\b/i },
  { kw: "panic", re: /\bpanic\b/i },
  { kw: "crash", re: /\bcrash(ed)?\b/i },
  { kw: "aborted", re: /\baborted\b/i },
  { kw: "EPIPE", re: /\bEPIPE\b/ },
  { kw: "ECONNREFUSED", re: /\bECONNREFUSED\b/ },
  { kw: "ECONNRESET", re: /\bECONNRESET\b/ },
  { kw: "ETIMEDOUT", re: /\bETIMEDOUT\b/ },
  { kw: "ENOTFOUND", re: /\bENOTFOUND\b/ },
  { kw: "unauthorized", re: /\bunauthor(i|ised|ized)\b/i },
  { kw: "HTTP 4xx", re: /\b4\d{2}\b/ },
  { kw: "HTTP 5xx", re: /\b5\d{2}\b/ },
];

// Warn classifier rules — checked AFTER fatal rules so "error warning" is
// fatal.  Keywords anchor at word boundaries.
const WARN_RULES: ReadonlyArray<{ kw: string; re: RegExp }> = [
  { kw: "warning", re: /\bwarning\b/i },
  { kw: "warn", re: /\bwarn\b/i },
  { kw: "deprecated", re: /\bdeprecated\b/i },
  { kw: "notice", re: /\bnotice\b/i },
  { kw: "info", re: /\binfo\b/i },
];

// Strip ANSI escape sequences from the classifier substring.  The bus
// message still carries the original bytes for debug visibility.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `…(${s.length - max} more chars)`;
}

function classifyLine(raw: string): StderrClassification {
  const probe = stripAnsi(raw);
  for (const rule of FATAL_RULES) {
    if (rule.re.test(probe)) {
      return { cls: "fatal", matchedKeyword: rule.kw, prefix: "stderr-fatal:" };
    }
  }
  for (const rule of WARN_RULES) {
    if (rule.re.test(probe)) {
      return { cls: "warn", matchedKeyword: rule.kw, prefix: "stderr-warn:" };
    }
  }
  return { cls: "ambiguous", matchedKeyword: null, prefix: "stderr:" };
}

function wireStderrErrorSurface(opts: WireOptions): WireResult {
  const { bus } = opts;
  const maxLinePreview = opts.maxLinePreview ?? 240;
  let chunksIngested = 0;
  let linesEmitted = 0;
  let fatalEmitted = 0;
  let warnEmitted = 0;
  let ambiguousEmitted = 0;
  let droppedEmptyLines = 0;
  let disposed = false;
  let fatalSeen = false;

  function emit(prefix: string, text: string): void {
    bus.emit({
      kind: "session.error",
      message: `${prefix} ${text}`,
    });
  }

  return {
    ingest(chunk: unknown): void {
      chunksIngested += 1;
      if (disposed) {
        // Post-dispose ingest is NEVER a silent swallow.  Route as
        // ambiguous stderr so debug users can see late arrivals.
        emit("stderr:", "ingest after dispose — ignored");
        ambiguousEmitted += 1;
        linesEmitted += 1;
        return;
      }
      // Coerce to string (Buffer support without importing node:buffer).
      let text: string;
      try {
        text = String(chunk);
      } catch {
        // Unreachable in practice — String() never throws on primitives or
        // objects with toString().  Guard anyway so the harness NEVER throws.
        emit("stderr:", "stderr chunk not coercible to string");
        ambiguousEmitted += 1;
        linesEmitted += 1;
        return;
      }
      if (text.length === 0) {
        droppedEmptyLines += 1;
        return;
      }
      const rawLines = text.split("\n");
      for (const rawLine of rawLines) {
        const line = rawLine.trim();
        if (line.length === 0) {
          droppedEmptyLines += 1;
          continue;
        }
        const classification = classifyLine(line);
        const preview = truncate(line, maxLinePreview);
        emit(classification.prefix, preview);
        linesEmitted += 1;
        switch (classification.cls) {
          case "fatal":
            fatalEmitted += 1;
            fatalSeen = true;
            break;
          case "warn":
            warnEmitted += 1;
            break;
          case "ambiguous":
            ambiguousEmitted += 1;
            break;
        }
      }
    },
    classify(line: string): StderrClassification {
      return classifyLine(line);
    },
    dispose(): void {
      disposed = true;
    },
    isFatal(): boolean {
      return fatalSeen;
    },
    stats(): HarnessStats {
      return {
        chunksIngested,
        linesEmitted,
        fatalEmitted,
        warnEmitted,
        ambiguousEmitted,
        droppedEmptyLines,
        disposed,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectSessionErrors(bus: Bus): string[] {
  const out: string[] = [];
  bus.on(
    "session.error",
    (e: Extract<BusEvent, { kind: "session.error" }>) => out.push(e.message),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Sub-AC 4 of AC 8 — stderr warning-vs-fatal error-surface policy", () => {
  describe("fatal classification", () => {
    it("line containing 'error' is classified fatal with matchedKeyword='error'", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const h = wireStderrErrorSurface({ bus });
      h.ingest("error: API key expired\n");
      expect(errors).toEqual(["stderr-fatal: error: API key expired"]);
      expect(h.isFatal()).toBe(true);
      const c = h.classify("error: API key expired");
      expect(c.cls).toBe("fatal");
      expect(c.matchedKeyword).toBe("error");
      bus.dispose();
    });

    it("uppercase 'FATAL' line is classified fatal (case-insensitive)", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const h = wireStderrErrorSurface({ bus });
      h.ingest("FATAL: unrecoverable state\n");
      expect(errors).toHaveLength(1);
      expect(errors[0].startsWith("stderr-fatal:")).toBe(true);
      expect(h.stats().fatalEmitted).toBe(1);
      bus.dispose();
    });

    it("EPIPE surfaces as fatal (child stdin closed)", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const h = wireStderrErrorSurface({ bus });
      h.ingest("write EPIPE on stdin\n");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBe("stderr-fatal: write EPIPE on stdin");
      expect(h.classify("write EPIPE on stdin").matchedKeyword).toBe("EPIPE");
      bus.dispose();
    });

    it("network error codes (ECONNREFUSED / ECONNRESET / ETIMEDOUT / ENOTFOUND) all surface as fatal", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const h = wireStderrErrorSurface({ bus });
      h.ingest("ECONNREFUSED 127.0.0.1:443\n");
      h.ingest("ECONNRESET peer closed\n");
      h.ingest("ETIMEDOUT claude.ai\n");
      h.ingest("ENOTFOUND api.anthropic.com\n");
      expect(errors).toHaveLength(4);
      for (const msg of errors) {
        expect(msg.startsWith("stderr-fatal:")).toBe(true);
      }
      bus.dispose();
    });

    it("HTTP 4xx / 5xx status codes are classified fatal", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const h = wireStderrErrorSurface({ bus });
      h.ingest("POST /v1/messages 401 Unauthorized\n");
      h.ingest("POST /v1/messages 500 Internal Server Error\n");
      h.ingest("GET /status 503 Service Unavailable\n");
      expect(errors).toHaveLength(3);
      for (const msg of errors) {
        expect(msg.startsWith("stderr-fatal:")).toBe(true);
      }
      expect(h.classify("500 Internal").matchedKeyword).toBe("HTTP 5xx");
      bus.dispose();
    });

    it("'unauthorized' / 'Unauthorised' variants classify as fatal", () => {
      const bus = createBus();
      const h = wireStderrErrorSurface({ bus });
      expect(h.classify("Unauthorized request").cls).toBe("fatal");
      expect(h.classify("Unauthorised access").cls).toBe("fatal");
      expect(h.classify("UNAUTHORIZED KEY").cls).toBe("fatal");
      bus.dispose();
    });

    it("'crash' / 'aborted' / 'panic' classify fatal (crash-signal surfacing)", () => {
      const bus = createBus();
      const h = wireStderrErrorSurface({ bus });
      expect(h.classify("process crashed unexpectedly").cls).toBe("fatal");
      expect(h.classify("request aborted by client").cls).toBe("fatal");
      expect(h.classify("panic: stack overflow").cls).toBe("fatal");
      bus.dispose();
    });

    it("line with BOTH error and warning keywords classifies as FATAL (fatal rules checked first)", () => {
      const bus = createBus();
      const h = wireStderrErrorSurface({ bus });
      const c = h.classify("error: turned warning into error");
      expect(c.cls).toBe("fatal");
      expect(c.matchedKeyword).toBe("error");
      bus.dispose();
    });
  });

  describe("warning classification", () => {
    it("line containing 'warning' is classified warn with matchedKeyword='warning'", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const h = wireStderrErrorSurface({ bus });
      h.ingest("warning: slow response time\n");
      expect(errors).toEqual(["stderr-warn: warning: slow response time"]);
      expect(h.isFatal()).toBe(false);
      expect(h.classify("warning: x").matchedKeyword).toBe("warning");
      bus.dispose();
    });

    it("line containing 'deprecated' classifies warn", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const h = wireStderrErrorSurface({ bus });
      h.ingest("deprecated: --opus flag removed in 2.2.0\n");
      expect(errors).toHaveLength(1);
      expect(errors[0].startsWith("stderr-warn:")).toBe(true);
      expect(h.classify("deprecated").matchedKeyword).toBe("deprecated");
      bus.dispose();
    });

    it("'info' and 'notice' lines classify warn (low-severity surfacing, not dropped)", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const h = wireStderrErrorSurface({ bus });
      h.ingest("info: using cached auth token\n");
      h.ingest("notice: rate limit approaching\n");
      expect(errors).toHaveLength(2);
      for (const msg of errors) {
        expect(msg.startsWith("stderr-warn:")).toBe(true);
      }
      expect(h.isFatal()).toBe(false);
      bus.dispose();
    });

    it("uppercase 'WARN' classifies warn (case-insensitive)", () => {
      const bus = createBus();
      const h = wireStderrErrorSurface({ bus });
      const c = h.classify("WARN: stale cache");
      expect(c.cls).toBe("warn");
      expect(c.matchedKeyword).toBe("warn");
      bus.dispose();
    });
  });

  describe("ambiguous (backward-compat with Sub-AC 2 of AC 8)", () => {
    it("unclassified line routes with 'stderr:' prefix (Sub-AC 2 of AC 8 compatibility)", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const h = wireStderrErrorSurface({ bus });
      h.ingest("session xxx-yyy started\n");
      expect(errors).toEqual(["stderr: session xxx-yyy started"]);
      expect(h.classify("session started").cls).toBe("ambiguous");
      expect(h.classify("session started").matchedKeyword).toBeNull();
      bus.dispose();
    });

    it("ambiguous line does NOT set isFatal()", () => {
      const bus = createBus();
      const h = wireStderrErrorSurface({ bus });
      h.ingest("debug: here we go\n");
      expect(h.isFatal()).toBe(false);
      bus.dispose();
    });
  });

  describe("empty / whitespace handling (noise suppression)", () => {
    it("empty chunk emits nothing and increments droppedEmptyLines by 0 (short-circuit)", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const h = wireStderrErrorSurface({ bus });
      h.ingest("");
      expect(errors).toEqual([]);
      // Empty chunk hits the early-return zero-length branch — it's not a
      // dropped LINE (no split happened).  Stats reflect that.
      expect(h.stats().linesEmitted).toBe(0);
      bus.dispose();
    });

    it("whitespace-only chunk emits nothing", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const h = wireStderrErrorSurface({ bus });
      h.ingest("\n");
      h.ingest("   \t  ");
      h.ingest("\n\n\n");
      expect(errors).toEqual([]);
      expect(h.stats().linesEmitted).toBe(0);
      bus.dispose();
    });

    it("mixed chunk (blank lines + real lines) only emits for the real lines", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const h = wireStderrErrorSurface({ bus });
      h.ingest("\n\nwarning: x\n\n   \nerror: y\n\n");
      expect(errors).toEqual([
        "stderr-warn: warning: x",
        "stderr-fatal: error: y",
      ]);
      bus.dispose();
    });
  });

  describe("multi-line chunks", () => {
    it("multi-line chunk with mixed classes emits one event per line, class-correct", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const h = wireStderrErrorSurface({ bus });
      h.ingest(
        "info: starting claude\nwarning: old config\nerror: bad token\nsession id=abc123\n",
      );
      expect(errors).toEqual([
        "stderr-warn: info: starting claude",
        "stderr-warn: warning: old config",
        "stderr-fatal: error: bad token",
        "stderr: session id=abc123",
      ]);
      const s = h.stats();
      expect(s.linesEmitted).toBe(4);
      expect(s.fatalEmitted).toBe(1);
      expect(s.warnEmitted).toBe(2);
      expect(s.ambiguousEmitted).toBe(1);
      bus.dispose();
    });

    it("trailing newline-less line is still emitted (no line drop at chunk boundary)", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const h = wireStderrErrorSurface({ bus });
      h.ingest("error: first line\nwarning: second line (no trailing \\n)");
      expect(errors).toEqual([
        "stderr-fatal: error: first line",
        "stderr-warn: warning: second line (no trailing \\n)",
      ]);
      bus.dispose();
    });
  });

  describe("truncation (bounded preview)", () => {
    it("line longer than maxLinePreview is truncated with '…(N more chars)' marker, classifier still matches", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const h = wireStderrErrorSurface({ bus, maxLinePreview: 40 });
      const longLine = "error: " + "X".repeat(100);
      h.ingest(longLine + "\n");
      expect(errors).toHaveLength(1);
      expect(errors[0].startsWith("stderr-fatal:")).toBe(true);
      expect(errors[0]).toContain("…(");
      expect(errors[0]).toContain("more chars)");
      // The truncated preview is <= prefix + max + marker; keep it short.
      expect(errors[0].length).toBeLessThan(longLine.length + 30);
      bus.dispose();
    });

    it("keyword at the TAIL of a long line still classifies correctly (match runs before truncation)", () => {
      const bus = createBus();
      const h = wireStderrErrorSurface({ bus, maxLinePreview: 20 });
      const long = "A".repeat(200) + " EPIPE";
      const c = h.classify(long);
      expect(c.cls).toBe("fatal");
      expect(c.matchedKeyword).toBe("EPIPE");
      bus.dispose();
    });
  });

  describe("ANSI escape handling", () => {
    it("ANSI-colored 'error' still classifies fatal (escape codes stripped from classifier probe)", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const h = wireStderrErrorSurface({ bus });
      // \x1b[31m = red, \x1b[0m = reset
      // eslint-disable-next-line no-control-regex
      const line = "\x1b[31merror:\x1b[0m ansi-colored failure";
      h.ingest(line + "\n");
      expect(errors).toHaveLength(1);
      expect(errors[0].startsWith("stderr-fatal:")).toBe(true);
      // Bus message preserves the original ANSI bytes for debug visibility.
      // eslint-disable-next-line no-control-regex
      expect(errors[0]).toContain("\x1b[31m");
      bus.dispose();
    });

    it("ANSI sequences on a warning line still classify warn", () => {
      const bus = createBus();
      const h = wireStderrErrorSurface({ bus });
      // eslint-disable-next-line no-control-regex
      const c = h.classify("\x1b[33mwarning:\x1b[0m deprecated flag");
      expect(c.cls).toBe("warn");
      expect(c.matchedKeyword).toBe("warning");
      bus.dispose();
    });
  });

  describe("non-string chunk coercion (Buffer support)", () => {
    it("Buffer chunk is coerced via String() and classified correctly", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const h = wireStderrErrorSurface({ bus });
      const buf = Buffer.from("error: from buffer\n", "utf8");
      h.ingest(buf);
      expect(errors).toEqual(["stderr-fatal: error: from buffer"]);
      bus.dispose();
    });

    it("unusual object with custom toString() coerces cleanly", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const h = wireStderrErrorSurface({ bus });
      const obj = {
        toString(): string {
          return "warning: from object";
        },
      };
      h.ingest(obj);
      expect(errors).toEqual(["stderr-warn: warning: from object"]);
      bus.dispose();
    });
  });

  describe("dispose semantics", () => {
    it("dispose() is idempotent and marks stats().disposed = true", () => {
      const bus = createBus();
      const h = wireStderrErrorSurface({ bus });
      h.dispose();
      expect(() => h.dispose()).not.toThrow();
      expect(h.stats().disposed).toBe(true);
      bus.dispose();
    });

    it("ingest() after dispose emits ambiguous 'ingest after dispose — ignored' (no silent swallow)", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const h = wireStderrErrorSurface({ bus });
      h.dispose();
      h.ingest("error: too late\n");
      h.ingest("warning: also too late\n");
      expect(errors).toEqual([
        "stderr: ingest after dispose — ignored",
        "stderr: ingest after dispose — ignored",
      ]);
      // Fatal counter does NOT tick — post-dispose drops are ambiguous.
      expect(h.isFatal()).toBe(false);
      expect(h.stats().ambiguousEmitted).toBe(2);
      expect(h.stats().fatalEmitted).toBe(0);
      bus.dispose();
    });
  });

  describe("never-throws contract", () => {
    it("every pathological input class is a bus emit — harness never throws to caller", () => {
      const bus = createBus();
      const h = wireStderrErrorSurface({ bus });
      expect(() => h.ingest("")).not.toThrow();
      expect(() => h.ingest("\n\n")).not.toThrow();
      expect(() => h.ingest("error\n")).not.toThrow();
      expect(() => h.ingest("warn\n")).not.toThrow();
      expect(() => h.ingest("random\n")).not.toThrow();
      expect(() => h.ingest(Buffer.from("E\n"))).not.toThrow();
      expect(() => h.ingest(12345 as unknown)).not.toThrow();
      expect(() => h.ingest(null as unknown)).not.toThrow();
      expect(() => h.ingest(undefined as unknown)).not.toThrow();
      expect(() => h.dispose()).not.toThrow();
      expect(() => h.ingest("after dispose")).not.toThrow();
      bus.dispose();
    });

    it("bus handler that throws does NOT crash the harness (bus-level isolation partner)", () => {
      const bus = createBus();
      const sink = vi.fn(() => {
        throw new Error("handler exploded");
      });
      bus.on("session.error", sink);
      const h = wireStderrErrorSurface({ bus });
      expect(() => h.ingest("error: probe\n")).not.toThrow();
      expect(sink).toHaveBeenCalledTimes(1);
      bus.dispose();
    });
  });

  describe("prefix invariants (policy contract)", () => {
    it("every emitted message starts with exactly one of the three policy prefixes", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const h = wireStderrErrorSurface({ bus });
      const fixtures = [
        "error: A\n",
        "FATAL: B\n",
        "warning: C\n",
        "info: D\n",
        "freeform text E\n",
        "crash: F\n",
        "500 bad gateway\n",
      ];
      for (const f of fixtures) h.ingest(f);
      expect(errors).toHaveLength(fixtures.length);
      for (const m of errors) {
        const prefixOk =
          m.startsWith("stderr-fatal: ") ||
          m.startsWith("stderr-warn: ") ||
          m.startsWith("stderr: ");
        expect(prefixOk).toBe(true);
      }
      bus.dispose();
    });

    it("Sub-AC 2 of AC 8 passthrough: ambiguous line still uses the exact legacy 'stderr:' prefix", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const h = wireStderrErrorSurface({ bus });
      h.ingest("hello from claude CLI\n");
      expect(errors).toEqual(["stderr: hello from claude CLI"]);
      bus.dispose();
    });

    it("differential — same text classifies identically across calls (deterministic)", () => {
      const bus = createBus();
      const h = wireStderrErrorSurface({ bus });
      const c1 = h.classify("error: x");
      const c2 = h.classify("error: x");
      const c3 = h.classify("error: x");
      expect(c1).toEqual(c2);
      expect(c2).toEqual(c3);
      expect(c1.cls).toBe("fatal");
      bus.dispose();
    });

    it("differential — fatal vs warn vs ambiguous on the SAME three-line chunk produces exactly 1/1/1 distribution", () => {
      const bus = createBus();
      const errors = collectSessionErrors(bus);
      const h = wireStderrErrorSurface({ bus });
      h.ingest("error: red\nwarning: yellow\nplain line\n");
      const fatal = errors.filter((m) => m.startsWith("stderr-fatal:")).length;
      const warn = errors.filter((m) => m.startsWith("stderr-warn:")).length;
      const ambig = errors.filter(
        (m) => m.startsWith("stderr: ") && !m.startsWith("stderr-"),
      ).length;
      expect(fatal).toBe(1);
      expect(warn).toBe(1);
      expect(ambig).toBe(1);
      bus.dispose();
    });
  });

  describe("integration with production createBus", () => {
    it("multiple subscribers each receive every classified line in order", () => {
      const bus = createBus();
      const a: string[] = [];
      const b: string[] = [];
      bus.on("session.error", (e) => a.push(e.message));
      bus.on("session.error", (e) => b.push(e.message));
      const h = wireStderrErrorSurface({ bus });
      h.ingest("error: 1\nwarning: 2\nplain: 3\n");
      expect(a).toEqual(b);
      expect(a).toHaveLength(3);
      bus.dispose();
    });

    it("classifier accessor is safe to call after dispose", () => {
      const bus = createBus();
      const h = wireStderrErrorSurface({ bus });
      h.dispose();
      const c = h.classify("error: post-dispose probe");
      expect(c.cls).toBe("fatal");
      expect(c.matchedKeyword).toBe("error");
      bus.dispose();
    });
  });
});
