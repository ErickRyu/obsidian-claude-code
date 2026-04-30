/**
 * Sub-AC 3 of AC 1 — error/stderr surfacing & MH-07/08/09 contract preview.
 *
 * The event-bus module wires up three kinds of signals that MH-07/MH-08/MH-09
 * all depend on but that only materialize once Phase 3/4b/5a renderers &
 * controllers land:
 *
 *   - `stream.event`   (parser → registry dispatch; foundation for all rendering)
 *   - `session.error`  (controller / parser → UI; the ONLY error-surface channel
 *                       — never silent swallowing per error-surface-discipline)
 *   - `ui.send`        (input-bar → controller; this is what MH-08 routes the
 *                       user's textarea submission through)
 *
 * Sub-AC 3 of AC 1 scope is the **contract** correctness: bus kinds exist with
 * the right discriminants, emit propagates to every subscriber, a handler
 * throwing is isolated from sibling handlers (no cascade), dispose() truly
 * drops every listener (no unmounted-leaf subscription leaks across the
 * plugin lifetime), and an `emit` after `dispose` is a silent no-op (not a
 * throw).
 *
 * These semantics are what keeps an unmounted ClaudeWebviewView from
 * corrupting the legacy ClaudeTerminalView's console / error surface — i.e.
 * the namespace-isolation half of the coexistence guarantee.
 *
 * Assertions are behavioral (counts / payload fields / throw boundaries).
 * No HTML / JSON snapshots — per constraint "No HTML snapshot testing — key-
 * field assertions only".
 */
import { describe, it, expect, vi } from "vitest";
import { createBus, type Bus, type BusEvent } from "../../src/webview/event-bus";
import type {
  AssistantEvent,
  StreamEvent,
  ResultEvent,
} from "../../src/webview/parser/types";

// ---- Helpers --------------------------------------------------------------

function streamEventOf(event: StreamEvent): Extract<BusEvent, { kind: "stream.event" }> {
  return { kind: "stream.event", event };
}

function fakeAssistant(id: string, text: string): AssistantEvent {
  return {
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
    },
    session_id: "sess-A",
    uuid: `uuid-${id}`,
  };
}

function fakeResult(is_error: boolean, subtype: string): ResultEvent {
  return {
    type: "result",
    subtype,
    is_error,
    session_id: "sess-A",
    uuid: "uuid-result",
  };
}

// ---- Tests ----------------------------------------------------------------

describe("event-bus — error-surface-discipline + MH-07/08/09 contract", () => {
  describe("kind discriminants (MH-07 / MH-08 / MH-09 preparatory contract)", () => {
    it("supports `stream.event` delivery (foundation for all renderers)", () => {
      const bus = createBus();
      const received: StreamEvent[] = [];
      bus.on("stream.event", (e) => received.push(e.event));
      bus.emit(streamEventOf(fakeAssistant("m1", "hi")));
      bus.emit(streamEventOf(fakeResult(false, "success")));
      expect(received).toHaveLength(2);
      expect(received[0].type).toBe("assistant");
      expect(received[1].type).toBe("result");
    });

    it("supports `session.error` delivery (MH-08/MH-09 error channel — EPIPE, spawn failure, stderr surfacing)", () => {
      const bus = createBus();
      const messages: string[] = [];
      bus.on("session.error", (e) => messages.push(e.message));
      bus.emit({ kind: "session.error", message: "claude CLI exited with code 1" });
      bus.emit({ kind: "session.error", message: "EPIPE — stdin write after child destroyed" });
      expect(messages).toEqual([
        "claude CLI exited with code 1",
        "EPIPE — stdin write after child destroyed",
      ]);
    });

    it("supports `ui.send` delivery (MH-08 input-bar → controller contract)", () => {
      const bus = createBus();
      const payloads: string[] = [];
      bus.on("ui.send", (e) => payloads.push(e.text));
      bus.emit({ kind: "ui.send", text: "hello claude" });
      bus.emit({ kind: "ui.send", text: "another turn" });
      expect(payloads).toEqual(["hello claude", "another turn"]);
    });

    it("discriminated unions are routed strictly by `kind` — mixed emit does not cross-fire handlers", () => {
      const bus = createBus();
      const streamCount = vi.fn();
      const errCount = vi.fn();
      const sendCount = vi.fn();
      bus.on("stream.event", streamCount);
      bus.on("session.error", errCount);
      bus.on("ui.send", sendCount);

      bus.emit(streamEventOf(fakeAssistant("m2", "x")));
      bus.emit({ kind: "session.error", message: "boom" });
      bus.emit({ kind: "ui.send", text: "y" });

      expect(streamCount).toHaveBeenCalledTimes(1);
      expect(errCount).toHaveBeenCalledTimes(1);
      expect(sendCount).toHaveBeenCalledTimes(1);
    });
  });

  describe("multi-subscriber fan-out (parser + archive can both observe stream.event)", () => {
    it("delivers every emit to every registered handler of matching kind", () => {
      const bus = createBus();
      const a = vi.fn();
      const b = vi.fn();
      const c = vi.fn();
      bus.on("stream.event", a);
      bus.on("stream.event", b);
      bus.on("stream.event", c);
      bus.emit(streamEventOf(fakeAssistant("m3", "z")));
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
      expect(c).toHaveBeenCalledTimes(1);
    });

    it("`listenerCount` tracks registration correctly per kind and in aggregate", () => {
      const bus = createBus();
      expect(bus.listenerCount()).toBe(0);
      expect(bus.listenerCount("stream.event")).toBe(0);

      bus.on("stream.event", () => {});
      bus.on("stream.event", () => {});
      bus.on("session.error", () => {});

      expect(bus.listenerCount("stream.event")).toBe(2);
      expect(bus.listenerCount("session.error")).toBe(1);
      expect(bus.listenerCount("ui.send")).toBe(0);
      expect(bus.listenerCount()).toBe(3);
    });
  });

  describe("error isolation — one throwing handler does NOT cascade into siblings", () => {
    it("throw in handler is caught, reported via [claude-webview] namespaced console.error, and siblings still fire", () => {
      const bus = createBus();
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const sibling = vi.fn();
        bus.on("session.error", () => {
          throw new Error("handler blew up");
        });
        bus.on("session.error", sibling);
        // The bus must NOT re-throw — otherwise downstream renderer dispatches
        // would be silently aborted (violating error-surface-discipline).
        expect(() =>
          bus.emit({ kind: "session.error", message: "trigger" }),
        ).not.toThrow();
        expect(sibling).toHaveBeenCalledTimes(1);

        const logs = errSpy.mock.calls.map((c) => String(c[0]));
        expect(logs.some((l) => l.startsWith("[claude-webview]"))).toBe(true);
        expect(
          logs.some((l) => l.includes("bus handler threw") && l.includes("session.error")),
        ).toBe(true);
      } finally {
        errSpy.mockRestore();
      }
    });

    it("non-Error throw (string / number / null) is stringified rather than crashing the bus", () => {
      const bus = createBus();
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        bus.on("ui.send", () => {
          // eslint-disable-next-line no-throw-literal
          throw "not an Error instance";
        });
        expect(() => bus.emit({ kind: "ui.send", text: "probe" })).not.toThrow();
        const logs = errSpy.mock.calls.map((c) => String(c[0]));
        expect(logs.some((l) => l.includes("not an Error instance"))).toBe(true);
      } finally {
        errSpy.mockRestore();
      }
    });
  });

  describe("lifecycle guard — dispose() fully severs subscriptions (coexistence hygiene)", () => {
    it("after dispose, every kind reports zero listeners", () => {
      const bus = createBus();
      bus.on("stream.event", () => {});
      bus.on("session.error", () => {});
      bus.on("ui.send", () => {});
      expect(bus.listenerCount()).toBe(3);
      bus.dispose();
      expect(bus.listenerCount()).toBe(0);
      expect(bus.listenerCount("stream.event")).toBe(0);
      expect(bus.listenerCount("session.error")).toBe(0);
      expect(bus.listenerCount("ui.send")).toBe(0);
    });

    it("emit after dispose is a silent no-op (not a throw) — an unmounted webview cannot crash the plugin", () => {
      const bus = createBus();
      const handler = vi.fn();
      bus.on("stream.event", handler);
      bus.dispose();
      expect(() => bus.emit(streamEventOf(fakeAssistant("m4", "post-dispose")))).not.toThrow();
      expect(handler).not.toHaveBeenCalled();
    });

    it("dispose is idempotent — calling twice does not blow up or leave the bus in a poisoned state", () => {
      const bus = createBus();
      bus.on("session.error", () => {});
      bus.dispose();
      expect(() => bus.dispose()).not.toThrow();
      expect(bus.listenerCount()).toBe(0);
      // Re-adding subscriptions on a disposed bus is not contractually supported,
      // but emit must still be a no-op.
      expect(() => bus.emit({ kind: "session.error", message: "post-double-dispose" })).not.toThrow();
    });
  });

  describe("MH-07 preview — hook_* event routing (parser recognizes; default-hidden by settings)", () => {
    it("parser SystemHookStartedEvent flows through `stream.event` channel with correct discriminant", () => {
      const bus = createBus();
      const observed: Array<{ type: string; subtype?: string }> = [];
      bus.on("stream.event", (e) => {
        const ev = e.event;
        if (ev.type === "system") {
          observed.push({ type: ev.type, subtype: ev.subtype });
        } else {
          observed.push({ type: ev.type });
        }
      });
      // Synthesize both hook events — Phase 5a's renderer will branch on
      // subtype and consult settings.showDebugSystemEvents (MH-07). This test
      // asserts the bus contract that carries them is in place today.
      bus.emit(
        streamEventOf({
          type: "system",
          subtype: "hook_started",
          hook_id: "h1",
          hook_name: "PreToolUse",
          hook_event: "PreToolUse",
          uuid: "u1",
          session_id: "s1",
        }),
      );
      bus.emit(
        streamEventOf({
          type: "system",
          subtype: "hook_response",
          hook_id: "h1",
          hook_name: "PreToolUse",
          hook_event: "PreToolUse",
          uuid: "u1",
          session_id: "s1",
          exit_code: 0,
        }),
      );
      expect(observed).toEqual([
        { type: "system", subtype: "hook_started" },
        { type: "system", subtype: "hook_response" },
      ]);
    });
  });

  describe("MH-08 preview — ui.send payload is plain text (JSONL stdin serialization happens in controller)", () => {
    it("round-trips multiline / unicode / empty-string payloads without coercion", () => {
      const bus = createBus();
      const received: string[] = [];
      bus.on("ui.send", (e) => received.push(e.text));
      bus.emit({ kind: "ui.send", text: "line1\nline2" });
      bus.emit({ kind: "ui.send", text: "한국어 테스트" });
      bus.emit({ kind: "ui.send", text: "" });
      expect(received).toEqual(["line1\nline2", "한국어 테스트", ""]);
    });
  });

  describe("emit with no subscribers — zero-handler kinds silently drop (coexistence safety)", () => {
    it("emitting a kind with no subscribers is a no-op, never a throw", () => {
      const bus = createBus();
      expect(() => bus.emit({ kind: "session.error", message: "no one listening" })).not.toThrow();
      expect(() => bus.emit({ kind: "ui.send", text: "no one listening" })).not.toThrow();
      expect(() => bus.emit(streamEventOf(fakeAssistant("m5", "silent")))).not.toThrow();
    });
  });

  describe("bus returns a typed Bus", () => {
    it("createBus() returns an object implementing on / emit / listenerCount / dispose", () => {
      const bus: Bus = createBus();
      expect(typeof bus.on).toBe("function");
      expect(typeof bus.emit).toBe("function");
      expect(typeof bus.listenerCount).toBe("function");
      expect(typeof bus.dispose).toBe("function");
    });
  });
});
