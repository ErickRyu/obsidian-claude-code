/**
 * Phase 5b Task 6 — SessionArchive write/load round-trip (SH-07 / 5b-1 / 5b-2).
 *
 * Contract exercised:
 *   - `append(sessionId, event)` writes an `archive_meta` header on first
 *     touch and then one JSONL line per subsequent event. The meta line
 *     carries `{type:"archive_meta", version:1, session_id, saved_at}` —
 *     the evidence script (Phase 5b 5b-2) parses it directly.
 *   - `append()` is idempotent on the header: a second append for the
 *     same session id does NOT rewrite the header, it only appends the
 *     event. Tests inspect the raw file content to confirm the header
 *     appears exactly once.
 *   - `load(sessionId)` reads the file, validates the header
 *     (`version===1`, session_id matches, first line is `archive_meta`),
 *     and returns the subsequent events parsed through the production
 *     `parseLine`. Malformed header or missing file → `[]` (Beta: we
 *     treat any corruption as "no archive" and fall through — surfacing
 *     a friendly error to the user is Phase 6's completion-gate job).
 *   - Round-trip: feeding the archive N events then constructing a NEW
 *     archive instance and calling `load` yields the same N events, in
 *     the same order, as discriminated StreamEvent objects.
 *   - Non-UUID session ids are rejected at the boundary with a
 *     `[claude-webview]` namespaced error — defense-in-depth against
 *     path traversal (the `<baseDir>/<id>.jsonl` filename cannot carry a
 *     `../..` if the id shape is enforced here).
 *
 * FS abstraction: the archive takes an `ArchiveFsImpl` option, and this
 * test passes an in-memory Map-backed impl so there is no tmp-dir churn
 * and no race with parallel vitest workers. The production wiring
 * (Phase 5b wireWebview) passes `node:fs` directly.
 */
import { describe, it, expect } from "vitest";
import {
  SessionArchive,
  type ArchiveFsImpl,
  type ArchiveMeta,
} from "../../src/webview/session/session-archive";
import type { StreamEvent } from "../../src/webview/parser/types";

function makeFakeFs(): ArchiveFsImpl & {
  files: Map<string, string>;
  dirs: Set<string>;
} {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    mkdirSync(p: string): void {
      dirs.add(p);
    },
    existsSync(p: string): boolean {
      return files.has(p) || dirs.has(p);
    },
    readFileSync(p: string, _encoding: "utf8"): string {
      const content = files.get(p);
      if (content === undefined) {
        throw new Error(`ENOENT: ${p}`);
      }
      return content;
    },
    appendFileSync(p: string, data: string): void {
      const prev = files.get(p) ?? "";
      files.set(p, prev + data);
    },
  };
}

const FROZEN_CLOCK = () => new Date("2026-04-17T02:00:00.000Z");
const SID = "aaaa1111-2222-3333-4444-555555555555";

function fx(): {
  fs: ReturnType<typeof makeFakeFs>;
  archive: SessionArchive;
  baseDir: string;
} {
  const fs = makeFakeFs();
  const baseDir = "/vault/.obsidian/plugins/claude-webview/archives";
  const archive = new SessionArchive({
    baseDir,
    fs,
    clock: FROZEN_CLOCK,
  });
  return { fs, archive, baseDir };
}

function makeAssistantEvent(text: string, id: string): StreamEvent {
  return {
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
    },
    session_id: SID,
    uuid: `uu-${id}`,
  };
}

function makeResultEvent(duration: number): StreamEvent {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: duration,
    result: "done",
    session_id: SID,
    uuid: "uu-result",
  };
}

describe("SessionArchive — header + append + load (Phase 5b SH-07)", () => {
  it("writes archive_meta header on first append and appends event line", () => {
    const { fs, archive, baseDir } = fx();
    const ev = makeAssistantEvent("hi", "m-1");
    archive.append(SID, ev);

    const path = `${baseDir}/${SID}.jsonl`;
    const raw = fs.files.get(path);
    expect(raw).toBeTruthy();
    const lines = raw!.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(2);

    const meta = JSON.parse(lines[0]) as ArchiveMeta;
    expect(meta.type).toBe("archive_meta");
    expect(meta.version).toBe(1);
    expect(meta.session_id).toBe(SID);
    expect(typeof meta.saved_at).toBe("string");
    expect(meta.saved_at).toBe("2026-04-17T02:00:00.000Z");

    const evJson = JSON.parse(lines[1]) as { type: string };
    expect(evJson.type).toBe("assistant");
  });

  it("does not rewrite header on subsequent appends (same archive instance)", () => {
    const { fs, archive, baseDir } = fx();
    archive.append(SID, makeAssistantEvent("a", "m-1"));
    archive.append(SID, makeAssistantEvent("b", "m-2"));
    archive.append(SID, makeResultEvent(42));

    const path = `${baseDir}/${SID}.jsonl`;
    const raw = fs.files.get(path)!;
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(4);

    const headerCount = lines.filter((l) => l.includes('"archive_meta"')).length;
    expect(headerCount).toBe(1);
  });

  it("round-trip: append N events → new archive → load returns same events", () => {
    const { fs, archive } = fx();
    const events: StreamEvent[] = [
      makeAssistantEvent("one", "m-1"),
      makeAssistantEvent("two", "m-2"),
      makeResultEvent(123),
    ];
    for (const ev of events) archive.append(SID, ev);

    const baseDir = "/vault/.obsidian/plugins/claude-webview/archives";
    const fresh = new SessionArchive({ baseDir, fs, clock: FROZEN_CLOCK });
    const loaded = fresh.load(SID);
    expect(loaded.length).toBe(3);
    expect(loaded[0].type).toBe("assistant");
    expect(loaded[2].type).toBe("result");

    const first = loaded[0];
    if (first.type === "assistant") {
      const block = first.message.content[0];
      expect(block.type).toBe("text");
      if (block.type === "text") {
        expect(block.text).toBe("one");
      }
    }
  });

  it("load on missing file returns empty array", () => {
    const { archive } = fx();
    const loaded = archive.load(SID);
    expect(loaded).toEqual([]);
  });

  it("load on file with wrong session_id in header returns empty array", () => {
    const { fs, baseDir } = fx();
    const otherSid = "bbbb1111-2222-3333-4444-555555555555";
    const path = `${baseDir}/${SID}.jsonl`;
    fs.mkdirSync(baseDir);
    fs.appendFileSync(
      path,
      JSON.stringify({
        type: "archive_meta",
        version: 1,
        session_id: otherSid,
        saved_at: "x",
      }) + "\n",
    );
    fs.appendFileSync(
      path,
      JSON.stringify(makeAssistantEvent("x", "m-1")) + "\n",
    );

    const archive = new SessionArchive({ baseDir, fs, clock: FROZEN_CLOCK });
    const loaded = archive.load(SID);
    expect(loaded).toEqual([]);
  });

  it("load on file whose first line is not JSON returns empty array", () => {
    const { fs, baseDir } = fx();
    const path = `${baseDir}/${SID}.jsonl`;
    fs.mkdirSync(baseDir);
    fs.appendFileSync(path, "not-json\n");
    fs.appendFileSync(
      path,
      JSON.stringify(makeAssistantEvent("x", "m-1")) + "\n",
    );

    const archive = new SessionArchive({ baseDir, fs, clock: FROZEN_CLOCK });
    const loaded = archive.load(SID);
    expect(loaded).toEqual([]);
  });

  it("load on file with wrong version in header returns empty array", () => {
    const { fs, baseDir } = fx();
    const path = `${baseDir}/${SID}.jsonl`;
    fs.mkdirSync(baseDir);
    fs.appendFileSync(
      path,
      JSON.stringify({
        type: "archive_meta",
        version: 2,
        session_id: SID,
        saved_at: "x",
      }) + "\n",
    );
    fs.appendFileSync(
      path,
      JSON.stringify(makeAssistantEvent("x", "m-1")) + "\n",
    );

    const archive = new SessionArchive({ baseDir, fs, clock: FROZEN_CLOCK });
    const loaded = archive.load(SID);
    expect(loaded).toEqual([]);
  });

  it("append rejects non-UUID session id (defense-in-depth)", () => {
    const { archive } = fx();
    expect(() =>
      archive.append("../../../etc/passwd", makeAssistantEvent("x", "m-1")),
    ).toThrow(/\[claude-webview\]/);
    expect(() =>
      archive.append("short", makeAssistantEvent("x", "m-1")),
    ).toThrow(/\[claude-webview\]/);
  });

  it("load rejects non-UUID session id (defense-in-depth)", () => {
    const { archive } = fx();
    expect(() => archive.load("../../../etc/passwd")).toThrow(
      /\[claude-webview\]/,
    );
  });

  it("malformed JSONL lines inside archive are skipped, not fatal", () => {
    const { fs, baseDir } = fx();
    const path = `${baseDir}/${SID}.jsonl`;
    fs.mkdirSync(baseDir);
    fs.appendFileSync(
      path,
      JSON.stringify({
        type: "archive_meta",
        version: 1,
        session_id: SID,
        saved_at: "x",
      }) + "\n",
    );
    fs.appendFileSync(path, "garbled-line-no-json\n");
    fs.appendFileSync(
      path,
      JSON.stringify(makeAssistantEvent("ok", "m-1")) + "\n",
    );

    const archive = new SessionArchive({ baseDir, fs, clock: FROZEN_CLOCK });
    const loaded = archive.load(SID);
    expect(loaded.length).toBe(1);
    expect(loaded[0].type).toBe("assistant");
  });
});
