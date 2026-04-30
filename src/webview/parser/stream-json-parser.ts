import type {
  StreamEvent,
  SystemEvent,
  AssistantEvent,
  UserEvent,
  RateLimitEvent,
  ResultEvent,
  UnknownEvent,
} from "./types";

export type ParseResult =
  | { ok: true; event: StreamEvent }
  | { ok: false; raw: string };

const KNOWN_TOP_LEVEL = new Set([
  "system",
  "user",
  "assistant",
  "rate_limit_event",
  "result",
]);

/**
 * Parse a single JSONL line into a StreamEvent.
 *
 * Error policy:
 * - Invalid JSON or non-object root → {ok: false, raw}  (increments rawSkipped)
 * - Missing `type` field, or non-string `type` → {ok: false, raw}
 * - Unknown `type` string → wrap in UnknownEvent (preserved for renderer)
 * - Known `type` but missing required subtype (for `system`) → UnknownEvent
 *
 * This function NEVER throws.
 */
export function parseLine(line: string): ParseResult {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return { ok: false, raw: line };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, raw: line };
  }
  if (!isObject(parsed)) {
    return { ok: false, raw: line };
  }
  const type = parsed.type;
  if (typeof type !== "string" || type.length === 0) {
    return { ok: false, raw: line };
  }

  if (!KNOWN_TOP_LEVEL.has(type)) {
    return { ok: true, event: wrapUnknown(type, parsed) };
  }

  if (type === "system") {
    const subtype = parsed.subtype;
    if (typeof subtype !== "string" || subtype.length === 0) {
      return { ok: true, event: wrapUnknown(type, parsed) };
    }
    return { ok: true, event: parsed as unknown as SystemEvent };
  }

  // For user / assistant / rate_limit_event / result, we cast with minimal
  // runtime checks — the TypeScript union is structural and the renderer
  // layer is responsible for defensive block-level inspection.
  switch (type) {
    case "assistant":
      return { ok: true, event: parsed as unknown as AssistantEvent };
    case "user":
      return { ok: true, event: parsed as unknown as UserEvent };
    case "rate_limit_event":
      return { ok: true, event: parsed as unknown as RateLimitEvent };
    case "result":
      return { ok: true, event: parsed as unknown as ResultEvent };
    default:
      // Shouldn't reach — KNOWN_TOP_LEVEL gated above.
      return { ok: true, event: wrapUnknown(type, parsed) };
  }
}

function wrapUnknown(originalType: string, raw: Record<string, unknown>): UnknownEvent {
  return {
    type: "__unknown__",
    originalType,
    raw,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
