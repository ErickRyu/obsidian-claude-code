import { describe, it, expect } from "vitest";
import { parseLine } from "../../src/webview/parser/stream-json-parser";
import type { UnknownEvent, AssistantEvent } from "../../src/webview/parser/types";

describe("parseLine — schema validation", () => {
  it("returns {ok:false} on non-JSON line", () => {
    const r = parseLine("this is not json");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.raw).toBe("this is not json");
    }
  });

  it("returns {ok:false} on JSON without `type` field", () => {
    const r = parseLine(JSON.stringify({ subtype: "x", foo: 1 }));
    expect(r.ok).toBe(false);
  });

  it("returns {ok:false} when `type` is null", () => {
    const r = parseLine(JSON.stringify({ type: null }));
    expect(r.ok).toBe(false);
  });

  it("returns UnknownEvent for unrecognised top-level type (not {ok:false})", () => {
    const r = parseLine(JSON.stringify({ type: "brand_new_event_type", payload: 1 }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.event.type).toBe("__unknown__");
      const u = r.event as UnknownEvent;
      expect(u.originalType).toBe("brand_new_event_type");
      expect(u.raw.payload).toBe(1);
    }
  });

  it("returns UnknownEvent for system without subtype (preserves raw)", () => {
    const r = parseLine(JSON.stringify({ type: "system", foo: "bar" }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.event.type).toBe("__unknown__");
      const u = r.event as UnknownEvent;
      expect(u.originalType).toBe("system");
    }
  });

  it("preserves parent_tool_use_id on assistant events (sub-agent tracking)", () => {
    const r = parseLine(
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_x",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
        },
        parent_tool_use_id: "tool_parent_123",
        session_id: "session-abc",
        uuid: "uuid-1",
      })
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.event.type).toBe("assistant");
      const ae = r.event as AssistantEvent;
      expect(ae.parent_tool_use_id).toBe("tool_parent_123");
    }
  });

  it("never throws on malformed input (graceful fallback)", () => {
    const inputs = [
      "",
      " ",
      "{",
      "}",
      "null",
      "[]",
      "true",
      "42",
      '"bare string"',
      '{"type":',
    ];
    for (const input of inputs) {
      expect(() => parseLine(input)).not.toThrow();
    }
  });
});
