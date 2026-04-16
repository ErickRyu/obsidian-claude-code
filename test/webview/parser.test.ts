import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replayFixture, eventCountByType } from "../../src/webview/parser/fixture-replay";

const FIXTURE_DIR = join(__dirname, "..", "fixtures", "stream-json");

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

describe("stream-json parser — 8 fixtures", () => {
  it.each(FIXTURES)("%s parses with rawSkipped === 0", (fixture) => {
    const result = replayFixture(join(FIXTURE_DIR, fixture));
    expect(result.rawSkipped).toBe(0);
    expect(result.events.length).toBeGreaterThan(0);
  });

  it("hello.jsonl has exactly 1 assistant event and at least 1 result", () => {
    const result = replayFixture(join(FIXTURE_DIR, "hello.jsonl"));
    const counts = eventCountByType(result.events);
    expect(counts.assistant).toBe(1);
    expect(counts.result).toBeGreaterThanOrEqual(1);
  });

  it("edit.jsonl has >=2 assistant and >=1 user (differential from hello)", () => {
    const result = replayFixture(join(FIXTURE_DIR, "edit.jsonl"));
    const counts = eventCountByType(result.events);
    expect(counts.assistant ?? 0).toBeGreaterThanOrEqual(2);
    expect(counts.user ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("parserInvocationCount matches non-empty line count for each fixture", () => {
    for (const fixture of FIXTURES) {
      const raw = readFileSync(join(FIXTURE_DIR, fixture), "utf8");
      const nonEmptyLines = raw.split(/\r?\n/).filter((l) => l.length > 0).length;
      const result = replayFixture(join(FIXTURE_DIR, fixture));
      expect(result.parserInvocationCount).toBe(nonEmptyLines);
    }
  });
});
