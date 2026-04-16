/**
 * Sub-AC 3 of AC 8 — Stream-parse error-surface contract.
 *
 * Scope: wire JSONL parse error, partial event, and UnknownEvent handling in
 * the stream-json parser to route through the ErrorSurface policy
 * (`bus.emit({kind:'session.error', message})`) without crashing the stream.
 * Phase 3's `src/webview/session/session-controller.ts` will embed this
 * contract alongside the child_process error surface pinned by Sub-AC 2 of
 * AC 8; this iteration locks the **parser-layer** behavioral envelope so
 * Phase 3's implementation cannot silently regress.
 *
 * Phase-gate compliance: The runtime `SessionController` class lives on the
 * Phase 3 file allowlist, so we MUST NOT add
 * `src/webview/session/session-controller.ts` in Phase 2.  Instead, the
 * contract is captured by a test-local reference harness
 * (`wireStreamParseErrorSurface`) defined below.  When Phase 3 lands, its
 * SessionController implementation is required to exhibit every behavior
 * pinned by this file.  The harness uses the PRODUCTION `LineBuffer`,
 * production `parseLine`, and production `Bus` — only the glue that joins
 * them is test-local.
 *
 * Error-surface-discipline (parser-layer slice):
 *   - Invalid JSON (non-object / no `type` / malformed)  → `session.error`
 *     with message starting "parse error:" + truncated raw preview; the
 *     stream CONTINUES — subsequent valid lines still reach `stream.event`.
 *   - Unterminated tail at EOF (child exited mid-line)  → `session.error`
 *     with message starting "partial event:" + truncated tail; emitted
 *     exactly once per stream lifetime.
 *   - UnknownEvent wrapper (parser preserved, unknown `type`)  → routed as
 *     `stream.event` (NOT `session.error` — not an error, it's schema
 *     drift the renderer surfaces via the collapsed-JSON dump card).
 *   - parseLine NEVER throws, and the harness NEVER throws to the caller
 *     (every failure class becomes a bus emit, never an exception up).
 *
 * Namespace-isolation partner: console error namespacing is governed by
 * `event-bus.ts` and verified by `bus-error-surface.test.ts` — no need to
 * re-verify here.
 *
 * Assertion style: behavioral counts + payload-field checks on the bus
 * capture arrays only.  No HTML / JSON snapshots.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createBus, type Bus, type BusEvent } from "../../src/webview/event-bus";
import { LineBuffer } from "../../src/webview/parser/line-buffer";
import { parseLine } from "../../src/webview/parser/stream-json-parser";
import type {
  AssistantEvent,
  StreamEvent,
  UnknownEvent,
} from "../../src/webview/parser/types";

// ---------------------------------------------------------------------------
// Reference harness — wireStreamParseErrorSurface.
//
// This is the Phase 3 SessionController parser-layer error-surface contract
// in functional form.  Phase 3's class implementation MUST preserve every
// invariant exercised below; the test file is the living spec for it.
// ---------------------------------------------------------------------------

export interface HarnessOptions {
  readonly bus: Bus;
  /** LineBuffer instance; callers may share it with a live child_process. */
  readonly lineBuffer: LineBuffer;
  /**
   * Max raw characters embedded in a `session.error` message before
   * truncation.  Keeps bus traffic bounded on giant malformed lines.
   */
  readonly maxRawPreview?: number;
}

export interface HarnessResult {
  /** Feed a stdout chunk through LineBuffer → parseLine → bus. */
  feedChunk(chunk: string): void;
  /**
   * EOF signal: flush any residual tail and, if it still fails to parse,
   * emit a single `session.error` with the "partial event:" prefix.
   * Idempotent — calling twice must not double-emit the partial-event error.
   */
  finalizeStream(): void;
  /** Pure bookkeeping for evidence / tests — does not affect behavior. */
  stats(): HarnessStats;
}

export interface HarnessStats {
  readonly chunksFed: number;
  readonly parserInvocations: number;
  readonly streamEventsEmitted: number;
  readonly parseErrorsEmitted: number;
  readonly partialEventsEmitted: number;
  readonly unknownEventsEmitted: number;
  readonly finalized: boolean;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `…(${s.length - max} more chars)`;
}

function wireStreamParseErrorSurface(opts: HarnessOptions): HarnessResult {
  const { bus, lineBuffer } = opts;
  const maxRawPreview = opts.maxRawPreview ?? 120;
  let chunksFed = 0;
  let parserInvocations = 0;
  let streamEventsEmitted = 0;
  let parseErrorsEmitted = 0;
  let partialEventsEmitted = 0;
  let unknownEventsEmitted = 0;
  let finalized = false;

  const dispatchLine = (line: string): void => {
    parserInvocations += 1;
    try {
      const r = parseLine(line);
      if (r.ok) {
        if (r.event.type === "__unknown__") {
          unknownEventsEmitted += 1;
        }
        streamEventsEmitted += 1;
        bus.emit({ kind: "stream.event", event: r.event });
        return;
      }
      // parser returned {ok:false} — JSON parse / schema reject.  Surface
      // as session.error with a bounded preview of the raw line.
      parseErrorsEmitted += 1;
      const preview = truncate(r.raw, maxRawPreview);
      bus.emit({
        kind: "session.error",
        message: `parse error: ${preview}`,
      });
    } catch (err: unknown) {
      // parseLine MUST NEVER throw; if it does (future regression), catch
      // so the stream does not crash and surface the class as parse error.
      parseErrorsEmitted += 1;
      const msg = err instanceof Error ? err.message : String(err);
      bus.emit({
        kind: "session.error",
        message: `parse error: parser threw: ${truncate(msg, maxRawPreview)}`,
      });
    }
  };

  return {
    feedChunk(chunk: string): void {
      chunksFed += 1;
      if (finalized) {
        // Post-finalize chunks are dropped — the child is dead.  Surface
        // as a parse error so debug users notice (never a silent swallow).
        parseErrorsEmitted += 1;
        bus.emit({
          kind: "session.error",
          message: `parse error: chunk after finalize dropped (${chunk.length} chars)`,
        });
        return;
      }
      let lines: string[];
      try {
        lines = lineBuffer.feed(chunk);
      } catch (err: unknown) {
        parseErrorsEmitted += 1;
        const msg = err instanceof Error ? err.message : String(err);
        bus.emit({
          kind: "session.error",
          message: `parse error: line-buffer threw: ${truncate(msg, maxRawPreview)}`,
        });
        return;
      }
      for (const line of lines) {
        dispatchLine(line);
      }
    },
    finalizeStream(): void {
      if (finalized) return;
      finalized = true;
      const tail = lineBuffer.flush();
      if (tail === null || tail.length === 0) return;
      // Try parsing the residual tail.  If it parses cleanly, treat as a
      // normal final line.  If not, emit the "partial event" error.
      parserInvocations += 1;
      const r = parseLine(tail);
      if (r.ok) {
        if (r.event.type === "__unknown__") {
          unknownEventsEmitted += 1;
        }
        streamEventsEmitted += 1;
        bus.emit({ kind: "stream.event", event: r.event });
        return;
      }
      partialEventsEmitted += 1;
      bus.emit({
        kind: "session.error",
        message: `partial event: stream ended mid-JSON: ${truncate(r.raw, maxRawPreview)}`,
      });
    },
    stats(): HarnessStats {
      return {
        chunksFed,
        parserInvocations,
        streamEventsEmitted,
        parseErrorsEmitted,
        partialEventsEmitted,
        unknownEventsEmitted,
        finalized,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CaptureBuckets {
  readonly streamEvents: StreamEvent[];
  readonly errors: string[];
}

function attachCaptures(bus: Bus): CaptureBuckets {
  const streamEvents: StreamEvent[] = [];
  const errors: string[] = [];
  bus.on("stream.event", (e: Extract<BusEvent, { kind: "stream.event" }>) =>
    streamEvents.push(e.event),
  );
  bus.on("session.error", (e: Extract<BusEvent, { kind: "session.error" }>) =>
    errors.push(e.message),
  );
  return { streamEvents, errors };
}

function assistantJson(id: string, text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
    },
    session_id: "sess-A",
    uuid: `uuid-${id}`,
  });
}

const ROOT = resolve(__dirname, "..", "..");
const FIXTURE_DIR = join(ROOT, "test", "fixtures", "stream-json");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Sub-AC 3 of AC 8 — JSONL parse/partial/unknown error-surface contract", () => {
  describe("happy path — well-formed JSONL reaches stream.event lane", () => {
    it("single valid assistant line fed in one chunk emits exactly one stream.event and zero errors", () => {
      const bus = createBus();
      const { streamEvents, errors } = attachCaptures(bus);
      const h = wireStreamParseErrorSurface({ bus, lineBuffer: new LineBuffer() });
      h.feedChunk(assistantJson("m1", "hello") + "\n");
      expect(streamEvents).toHaveLength(1);
      expect(errors).toEqual([]);
      expect(streamEvents[0].type).toBe("assistant");
      bus.dispose();
    });

    it("multi-line chunk produces one stream.event per line in order", () => {
      const bus = createBus();
      const { streamEvents, errors } = attachCaptures(bus);
      const h = wireStreamParseErrorSurface({ bus, lineBuffer: new LineBuffer() });
      const payload =
        assistantJson("m1", "one") +
        "\n" +
        assistantJson("m2", "two") +
        "\n" +
        assistantJson("m3", "three") +
        "\n";
      h.feedChunk(payload);
      expect(streamEvents).toHaveLength(3);
      expect(errors).toEqual([]);
      const ids = streamEvents
        .filter((e): e is AssistantEvent => e.type === "assistant")
        .map((e) => e.message.id);
      expect(ids).toEqual(["m1", "m2", "m3"]);
      bus.dispose();
    });

    it("JSON split across two chunks assembles correctly — no parse error from mid-line split", () => {
      const bus = createBus();
      const { streamEvents, errors } = attachCaptures(bus);
      const h = wireStreamParseErrorSurface({ bus, lineBuffer: new LineBuffer() });
      const full = assistantJson("m-split", "split-payload") + "\n";
      const midpoint = Math.floor(full.length / 2);
      h.feedChunk(full.slice(0, midpoint));
      // After first chunk: line not yet terminated, no events.
      expect(streamEvents).toEqual([]);
      expect(errors).toEqual([]);
      h.feedChunk(full.slice(midpoint));
      expect(streamEvents).toHaveLength(1);
      expect(errors).toEqual([]);
      bus.dispose();
    });

    it("CRLF line endings are normalized identically to LF", () => {
      const bus = createBus();
      const { streamEvents, errors } = attachCaptures(bus);
      const h = wireStreamParseErrorSurface({ bus, lineBuffer: new LineBuffer() });
      h.feedChunk(assistantJson("m-crlf", "crlf") + "\r\n");
      expect(streamEvents).toHaveLength(1);
      expect(errors).toEqual([]);
      bus.dispose();
    });
  });

  describe("parse error — invalid JSON routes through session.error with prefix 'parse error:'", () => {
    it("non-JSON line emits single session.error starting 'parse error:' and no stream.event", () => {
      const bus = createBus();
      const { streamEvents, errors } = attachCaptures(bus);
      const h = wireStreamParseErrorSurface({ bus, lineBuffer: new LineBuffer() });
      h.feedChunk("this is not json at all\n");
      expect(streamEvents).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0].startsWith("parse error:")).toBe(true);
      expect(errors[0]).toContain("this is not json");
      bus.dispose();
    });

    it("JSON without `type` field becomes 'parse error:' (schema-reject lane)", () => {
      const bus = createBus();
      const { streamEvents, errors } = attachCaptures(bus);
      const h = wireStreamParseErrorSurface({ bus, lineBuffer: new LineBuffer() });
      h.feedChunk(JSON.stringify({ subtype: "x", foo: 1 }) + "\n");
      expect(streamEvents).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0].startsWith("parse error:")).toBe(true);
      bus.dispose();
    });

    it("JSON with `type: null` becomes 'parse error:' (type must be non-empty string)", () => {
      const bus = createBus();
      const { streamEvents, errors } = attachCaptures(bus);
      const h = wireStreamParseErrorSurface({ bus, lineBuffer: new LineBuffer() });
      h.feedChunk(JSON.stringify({ type: null }) + "\n");
      expect(streamEvents).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0].startsWith("parse error:")).toBe(true);
      bus.dispose();
    });

    it("stream CONTINUES after parse error — subsequent valid line still reaches stream.event", () => {
      const bus = createBus();
      const { streamEvents, errors } = attachCaptures(bus);
      const h = wireStreamParseErrorSurface({ bus, lineBuffer: new LineBuffer() });
      h.feedChunk("garbage line one\n");
      h.feedChunk(assistantJson("m-after", "after-garbage") + "\n");
      h.feedChunk("more garbage\n");
      h.feedChunk(assistantJson("m-final", "final") + "\n");
      expect(errors).toHaveLength(2);
      expect(errors.every((m) => m.startsWith("parse error:"))).toBe(true);
      expect(streamEvents).toHaveLength(2);
      expect(streamEvents[0].type).toBe("assistant");
      expect(streamEvents[1].type).toBe("assistant");
      bus.dispose();
    });

    it("extremely long malformed line is truncated in the error message (bounded bus traffic)", () => {
      const bus = createBus();
      const { errors } = attachCaptures(bus);
      const h = wireStreamParseErrorSurface({
        bus,
        lineBuffer: new LineBuffer(),
        maxRawPreview: 60,
      });
      const giant = "X".repeat(5000);
      h.feedChunk(giant + "\n");
      expect(errors).toHaveLength(1);
      // The error message carries a truncation marker; the raw size must
      // not blow past the preview limit by more than the marker suffix.
      expect(errors[0].length).toBeLessThan(200);
      expect(errors[0]).toContain("more chars");
      bus.dispose();
    });

    it("feedChunk NEVER throws — bad input is absorbed into session.error", () => {
      const bus = createBus();
      const h = wireStreamParseErrorSurface({ bus, lineBuffer: new LineBuffer() });
      expect(() => h.feedChunk("garbage\n")).not.toThrow();
      expect(() => h.feedChunk("{\n")).not.toThrow();
      expect(() => h.feedChunk("")).not.toThrow();
      expect(() => h.feedChunk("null\n")).not.toThrow();
      expect(() => h.feedChunk("[1,2,3]\n")).not.toThrow();
      expect(() => h.feedChunk('"bare"\n')).not.toThrow();
      bus.dispose();
    });
  });

  describe("partial event — unterminated tail at EOF routes through session.error with prefix 'partial event:'", () => {
    it("finalizeStream with unterminated malformed tail emits single 'partial event:' error", () => {
      const bus = createBus();
      const { streamEvents, errors } = attachCaptures(bus);
      const h = wireStreamParseErrorSurface({ bus, lineBuffer: new LineBuffer() });
      // Feed an opening brace with no newline — child died mid-line.
      h.feedChunk('{"type":"assistant","messag');
      h.finalizeStream();
      expect(streamEvents).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0].startsWith("partial event:")).toBe(true);
      expect(errors[0]).toContain('"type":"assistant"');
      bus.dispose();
    });

    it("finalizeStream with NO tail is a silent no-op (clean EOF after final newline)", () => {
      const bus = createBus();
      const { streamEvents, errors } = attachCaptures(bus);
      const h = wireStreamParseErrorSurface({ bus, lineBuffer: new LineBuffer() });
      h.feedChunk(assistantJson("m-clean", "clean") + "\n");
      h.finalizeStream();
      expect(streamEvents).toHaveLength(1);
      expect(errors).toEqual([]);
      bus.dispose();
    });

    it("finalizeStream with unterminated BUT parseable tail emits stream.event (not partial error)", () => {
      const bus = createBus();
      const { streamEvents, errors } = attachCaptures(bus);
      const h = wireStreamParseErrorSurface({ bus, lineBuffer: new LineBuffer() });
      // Valid JSON with no trailing newline — LineBuffer.flush() will
      // return the tail and parseLine will accept it.
      h.feedChunk(assistantJson("m-no-newline", "no-newline"));
      h.finalizeStream();
      expect(streamEvents).toHaveLength(1);
      expect(errors).toEqual([]);
      bus.dispose();
    });

    it("finalizeStream is idempotent — calling twice does NOT double-emit partial-event", () => {
      const bus = createBus();
      const { errors } = attachCaptures(bus);
      const h = wireStreamParseErrorSurface({ bus, lineBuffer: new LineBuffer() });
      h.feedChunk('{"broken');
      h.finalizeStream();
      h.finalizeStream();
      h.finalizeStream();
      const partialErrors = errors.filter((m) => m.startsWith("partial event:"));
      expect(partialErrors).toHaveLength(1);
      bus.dispose();
    });

    it("feedChunk after finalizeStream is dropped with a dedicated parse-error message (no silent swallow)", () => {
      const bus = createBus();
      const { streamEvents, errors } = attachCaptures(bus);
      const h = wireStreamParseErrorSurface({ bus, lineBuffer: new LineBuffer() });
      h.feedChunk(assistantJson("m-before-fin", "ok") + "\n");
      h.finalizeStream();
      h.feedChunk(assistantJson("m-after-fin", "late") + "\n");
      expect(streamEvents).toHaveLength(1); // only the pre-finalize event
      expect(errors.some((m) => m.includes("chunk after finalize dropped"))).toBe(true);
      bus.dispose();
    });
  });

  describe("UnknownEvent — preserved through the stream.event lane, NOT emitted as error", () => {
    it("unknown top-level type routes through stream.event (NOT session.error)", () => {
      const bus = createBus();
      const { streamEvents, errors } = attachCaptures(bus);
      const h = wireStreamParseErrorSurface({ bus, lineBuffer: new LineBuffer() });
      h.feedChunk(
        JSON.stringify({ type: "future_schema_drift", payload: 42 }) + "\n",
      );
      expect(streamEvents).toHaveLength(1);
      expect(errors).toEqual([]);
      expect(streamEvents[0].type).toBe("__unknown__");
      const u = streamEvents[0] as UnknownEvent;
      expect(u.originalType).toBe("future_schema_drift");
      expect(u.raw.payload).toBe(42);
      bus.dispose();
    });

    it("unknown event preserves raw JSON fields (schema-drift transparency)", () => {
      const bus = createBus();
      const { streamEvents } = attachCaptures(bus);
      const h = wireStreamParseErrorSurface({ bus, lineBuffer: new LineBuffer() });
      h.feedChunk(
        JSON.stringify({
          type: "novel_event",
          nested: { deep: { value: "preserve-me" } },
          array: [1, 2, 3],
        }) + "\n",
      );
      const u = streamEvents[0] as UnknownEvent;
      expect(u.raw.nested).toEqual({ deep: { value: "preserve-me" } });
      expect(u.raw.array).toEqual([1, 2, 3]);
      bus.dispose();
    });

    it("mixed stream: unknown events interleave with valid events and parse errors", () => {
      const bus = createBus();
      const { streamEvents, errors } = attachCaptures(bus);
      const h = wireStreamParseErrorSurface({ bus, lineBuffer: new LineBuffer() });
      h.feedChunk(assistantJson("m1", "valid-1") + "\n");
      h.feedChunk(JSON.stringify({ type: "novel_event", n: 1 }) + "\n");
      h.feedChunk("garbage in the middle\n");
      h.feedChunk(JSON.stringify({ type: "novel_event", n: 2 }) + "\n");
      h.feedChunk(assistantJson("m2", "valid-2") + "\n");
      expect(streamEvents).toHaveLength(4);
      expect(errors).toHaveLength(1);
      expect(errors[0].startsWith("parse error:")).toBe(true);
      const kinds = streamEvents.map((e) =>
        e.type === "__unknown__" ? `__unknown__:${e.originalType}` : e.type,
      );
      expect(kinds).toEqual([
        "assistant",
        "__unknown__:novel_event",
        "__unknown__:novel_event",
        "assistant",
      ]);
      bus.dispose();
    });
  });

  describe("harness stats — bookkeeping for evidence JSON", () => {
    it("stats reflect per-class counters after a representative mixed stream", () => {
      const bus = createBus();
      const h = wireStreamParseErrorSurface({ bus, lineBuffer: new LineBuffer() });
      h.feedChunk(assistantJson("m1", "ok") + "\n"); // stream.event +1
      h.feedChunk("garbage\n"); // parseError +1
      h.feedChunk(JSON.stringify({ type: "novel" }) + "\n"); // stream.event +1, unknown +1
      h.feedChunk('{"trunc');
      h.finalizeStream(); // partialEvent +1
      const s = h.stats();
      expect(s.chunksFed).toBe(4);
      expect(s.streamEventsEmitted).toBe(2);
      expect(s.parseErrorsEmitted).toBe(1);
      expect(s.partialEventsEmitted).toBe(1);
      expect(s.unknownEventsEmitted).toBe(1);
      expect(s.finalized).toBe(true);
      expect(s.parserInvocations).toBe(4); // 3 feedChunk + 1 finalize (non-empty tail)
      bus.dispose();
    });
  });

  describe("fixture regression — all 8 canonical fixtures produce 0 parse errors / 0 partial events through the harness", () => {
    const FIXTURES = [
      "edit.jsonl",
      "hello.jsonl",
      "permission.jsonl",
      "plan-mode.jsonl",
      "resume.jsonl",
      "slash-compact.jsonl",
      "slash-mcp.jsonl",
      "todo.jsonl",
    ];

    it.each(FIXTURES)(
      "%s — harness feedChunk over full file emits 0 session.error and >=1 stream.event",
      (fixture) => {
        const bus = createBus();
        const { streamEvents, errors } = attachCaptures(bus);
        const h = wireStreamParseErrorSurface({
          bus,
          lineBuffer: new LineBuffer(),
        });
        const raw = readFileSync(join(FIXTURE_DIR, fixture), "utf8");
        // Feed in 512-byte chunks to force mid-line splits.
        const CHUNK = 512;
        for (let i = 0; i < raw.length; i += CHUNK) {
          h.feedChunk(raw.slice(i, i + CHUNK));
        }
        h.finalizeStream();
        expect(errors).toEqual([]);
        expect(streamEvents.length).toBeGreaterThan(0);
        const stats = h.stats();
        expect(stats.parseErrorsEmitted).toBe(0);
        expect(stats.partialEventsEmitted).toBe(0);
        expect(stats.unknownEventsEmitted).toBe(0);
        bus.dispose();
      },
    );
  });

  describe("parser-layer error NEVER cascades to bus-handler cascade (coexistence hygiene)", () => {
    it("a handler throwing on stream.event does not derail subsequent emits (bus-level isolation)", () => {
      const bus = createBus();
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const seen: StreamEvent[] = [];
        bus.on("stream.event", () => {
          throw new Error("downstream handler blew up");
        });
        bus.on("stream.event", (e) => {
          seen.push(e.event);
        });
        const h = wireStreamParseErrorSurface({
          bus,
          lineBuffer: new LineBuffer(),
        });
        expect(() =>
          h.feedChunk(assistantJson("m-handler-crash", "crash") + "\n"),
        ).not.toThrow();
        expect(seen).toHaveLength(1);
        // Bus logs the handler crash under [claude-webview] namespace.
        const logs = errSpy.mock.calls.map((c) => String(c[0]));
        expect(logs.some((l) => l.startsWith("[claude-webview]"))).toBe(true);
      } finally {
        errSpy.mockRestore();
        bus.dispose();
      }
    });
  });

  describe("error-never-escapes — every failure class becomes a session.error, never a throw", () => {
    it("sweep of pathological inputs: parser absorbs, never throws, never crashes the stream", () => {
      const bus = createBus();
      const { streamEvents, errors } = attachCaptures(bus);
      const h = wireStreamParseErrorSurface({
        bus,
        lineBuffer: new LineBuffer(),
      });
      const pathological = [
        "",
        "\n",
        "\r\n",
        "{\n",
        "}\n",
        "null\n",
        "[]\n",
        "true\n",
        "42\n",
        '"bare string"\n',
        '{"type":\n',
        "{\"malformed unicode \\uZZZZ\"}\n",
      ];
      for (const chunk of pathological) {
        expect(() => h.feedChunk(chunk)).not.toThrow();
      }
      // After the pathological sweep a well-formed line STILL reaches
      // the stream.event lane — the stream was never crashed.
      h.feedChunk(assistantJson("m-final", "still-alive") + "\n");
      expect(streamEvents).toHaveLength(1);
      expect(streamEvents[0].type).toBe("assistant");
      // Every recorded error carries the policy prefix.
      expect(
        errors.every(
          (m) =>
            m.startsWith("parse error:") || m.startsWith("partial event:"),
        ),
      ).toBe(true);
      bus.dispose();
    });
  });
});
