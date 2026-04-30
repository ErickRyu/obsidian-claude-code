#!/usr/bin/env tsx
/**
 * Phase 5b archive evidence generator (5b-2 / SH-07).
 *
 * Pipes the `hello.jsonl` fixture through the production `parseLine`
 * parser and writes the resulting `StreamEvent[]` to the production
 * `SessionArchive` against real `node:fs` under
 * `<repo>/.webview-test-archives/<sid>.jsonl`. Phase 5b matrix row 5b-2
 * reads the first line of that file and asserts the `archive_meta`
 * header shape (type === "archive_meta", version === 1, non-empty
 * `session_id` / `saved_at`).
 *
 * Side-car JSON at `artifacts/phase-5b/archive-evidence.json` satisfies
 * the 8-point `scripts/check-evidence.sh` cross-validation:
 *   1. `generatedBy` resolves to this script.
 *   2. `generatedAt` is ISO8601 within ±1d.
 *   3. `fixtures[0].fixture` is `hello.jsonl` (exists).
 *   4. `fixtures[0].firstLineSha256` matches the real first-line sha256.
 *   5. `subprocessPid` is `process.pid` of this tsx invocation.
 *   6. `parserInvocationCount` >= `hello.jsonl` non-empty line count.
 *   7. `assertions[].id === "SH-07"`.
 *   8. This file imports `parser/stream-json-parser` (grep anchor below).
 *
 * Idempotency: the `.webview-test-archives/` directory is wiped on each
 * run to avoid accumulating stale headers from prior SID collisions.
 * The side-car JSON is always overwritten.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { SessionArchive } from "../src/webview/session/session-archive";
// Direct import so `check-evidence.sh` condition 8 (grep anchor) is met
// even though the parseLine call happens transitively through parser.
import { parseLine } from "../src/webview/parser/stream-json-parser";
import type { StreamEvent } from "../src/webview/parser/types";

const ROOT = resolve(__dirname, "..");
const ARCHIVE_DIR = join(ROOT, ".webview-test-archives");
const FIXTURE_DIR = join(ROOT, "test", "fixtures", "stream-json");
const FIXTURE_NAME = "hello.jsonl";
// Fixed SID so a reader can diff consecutive runs without a file churn.
// UUID shape enforced by SessionArchive at write time.
const SID = "ddddeeee-1111-2222-3333-444455556666";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function main(): void {
  // Clean slate — stale headers from prior runs would confuse both the
  // 5b-2 node -e reader and a developer inspecting the file.
  if (existsSync(ARCHIVE_DIR)) {
    rmSync(ARCHIVE_DIR, { recursive: true, force: true });
  }
  mkdirSync(ARCHIVE_DIR, { recursive: true });

  const fixturePath = join(FIXTURE_DIR, FIXTURE_NAME);
  const raw = readFileSync(fixturePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  const firstLine = lines[0] ?? "";
  const firstLineSha256 = sha256(firstLine);

  const events: StreamEvent[] = [];
  let parserInvocationCount = 0;
  let rawSkipped = 0;
  for (const line of lines) {
    parserInvocationCount++;
    const parsed = parseLine(line);
    if (parsed.ok) events.push(parsed.event);
    else rawSkipped++;
  }

  const archive = new SessionArchive({
    baseDir: ARCHIVE_DIR,
    clock: () => new Date("2026-04-17T02:45:00.000Z"),
  });
  for (const ev of events) {
    archive.append(SID, ev);
  }

  // Header self-check — fail the generator BEFORE the 5b-2 CMD reads a
  // malformed file.
  const files = readdirSync(ARCHIVE_DIR).filter((f) => f.endsWith(".jsonl"));
  if (files.length !== 1) {
    throw new Error(`[phase-5b-evidence] expected 1 archive file, got ${files.length}`);
  }
  const archivePath = join(ARCHIVE_DIR, files[0]);
  const archiveRaw = readFileSync(archivePath, "utf8");
  const archiveLines = archiveRaw.split("\n").filter((l) => l.length > 0);
  if (archiveLines.length < 2) {
    throw new Error(
      `[phase-5b-evidence] archive has only ${archiveLines.length} lines`,
    );
  }
  const meta = JSON.parse(archiveLines[0]) as Record<string, unknown>;
  const headerOk =
    meta.type === "archive_meta" &&
    meta.version === 1 &&
    typeof meta.session_id === "string" &&
    (meta.session_id as string).length > 0 &&
    typeof meta.saved_at === "string" &&
    (meta.saved_at as string).length > 0;
  if (!headerOk) {
    throw new Error(
      `[phase-5b-evidence] archive_meta malformed: ${JSON.stringify(meta)}`,
    );
  }

  // Round-trip — construct a new SessionArchive instance and reload.
  // This is the production SH-07 path exercised by `resume-fallback`.
  const loaded = new SessionArchive({
    baseDir: ARCHIVE_DIR,
    clock: () => new Date("2026-04-17T02:45:00.000Z"),
  }).load(SID);
  if (loaded.length !== events.length) {
    throw new Error(
      `[phase-5b-evidence] round-trip mismatch: wrote ${events.length}, loaded ${loaded.length}`,
    );
  }

  const outDir = join(ROOT, "artifacts", "phase-5b");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "archive-evidence.json"),
    JSON.stringify(
      {
        generatedBy: "scripts/evidence-phase-5b-archive.ts",
        generatedAt: new Date().toISOString(),
        subprocessPid: process.pid,
        parserInvocationCount,
        fixtures: [
          {
            fixture: FIXTURE_NAME,
            firstLineSha256,
            rawSkipped,
            eventCount: events.length,
          },
        ],
        archiveRelPath: archivePath.replace(ROOT + "/", ""),
        archiveHeader: meta,
        archiveEventLineCount: archiveLines.length - 1,
        roundTripLoadedCount: loaded.length,
        assertions: [
          {
            id: "SH-07",
            desc: "SessionArchive round-trip: append N → new instance → load → N events",
            actual: loaded.length,
            pass: loaded.length === events.length && headerOk,
          },
        ],
      },
      null,
      2,
    ) + "\n",
  );

  // Retain the `parseLine` import symbol at runtime — grep anchor only
  // guarantees textual presence in the source; this `void` keeps
  // `@typescript-eslint/no-unused-vars` quiet.
  void parseLine;

  // eslint-disable-next-line no-console
  console.log(
    `[phase-5b-evidence] OK — ${events.length} events archived under ${ARCHIVE_DIR}, round-trip loaded ${loaded.length}`,
  );
}

main();
