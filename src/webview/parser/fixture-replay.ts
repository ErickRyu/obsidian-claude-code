import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { LineBuffer } from "./line-buffer";
import { parseLine } from "./stream-json-parser";
import type { StreamEvent } from "./types";

export interface ReplayResult {
  events: StreamEvent[];
  rawSkipped: number;
  unknownEventCount: number;
  firstLineSha256: string;
  parserInvocationCount: number;
}

/**
 * Replay a JSONL fixture file through the LineBuffer + parseLine pipeline.
 * Returns accumulated events plus bookkeeping fields used by fixture assertions
 * and Phase 1 evidence JSON.
 */
export function replayFixture(path: string): ReplayResult {
  const raw = readFileSync(path, "utf8");
  const buf = new LineBuffer();
  const events: StreamEvent[] = [];
  let rawSkipped = 0;
  let unknownEventCount = 0;
  let parserInvocationCount = 0;

  const lines = buf.feed(raw);
  const tail = buf.flush();
  const allLines = tail !== null ? [...lines, tail] : lines;

  let firstLineSha256 = "";
  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];
    if (i === 0) {
      firstLineSha256 = createHash("sha256").update(line).digest("hex");
    }
    parserInvocationCount++;
    const result = parseLine(line);
    if (!result.ok) {
      rawSkipped++;
      continue;
    }
    if (result.event.type === "__unknown__") {
      unknownEventCount++;
    }
    events.push(result.event);
  }

  return {
    events,
    rawSkipped,
    unknownEventCount,
    firstLineSha256,
    parserInvocationCount,
  };
}

/**
 * Count events by top-level `type` field (UnknownEvent uses its `originalType`).
 */
export function eventCountByType(events: StreamEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const ev of events) {
    const key = ev.type === "__unknown__" ? `__unknown__:${ev.originalType}` : ev.type;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
