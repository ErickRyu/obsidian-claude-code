/**
 * Sub-AC 4 of AC 1 — MH-10 / MH-11 readiness + 8-fixture replay contract +
 * single real `claude -p` smoke verdict validation.
 *
 * This suite locks the "Phase 5b / Phase 6 finalization" contract this
 * sub-AC delivers:
 *
 *   1. MH-10 (uiMode toggle, Phase 0 gate) — `DEFAULT_WEBVIEW_SETTINGS.uiMode`
 *      is `"terminal"`, both preset values round-trip through the settings
 *      adapter, and Object.assign migration over a v0.5.x payload (no
 *      webview fields) preserves `uiMode === "terminal"` (opt-in safety).
 *   2. MH-11 (view-lifecycle guard readiness, Phase 3 gate) — the view
 *      surface (`view.ts`) exposes `onOpen` / `onClose` entry points, and
 *      the bus surface (`event-bus.ts`) exposes `dispose()` that clears all
 *      listeners without throwing.  The runtime spawn integration lands in
 *      Phase 3; this sub-AC locks the DOM + listener teardown primitives
 *      that Phase 3's `SessionController` plugs into.
 *   3. Eight-fixture replay contract — every JSONL fixture under
 *      `test/fixtures/stream-json/` parses with `rawSkipped === 0` AND
 *      `unknownEventCount === 0`; per-fixture `firstLineSha256` matches the
 *      on-disk bytes (tamper-evidence); NO two fixtures share a
 *      `system.init.session_id` (cross-fixture isolation).
 *   4. Smoke verdict — if `artifacts/phase-5b/smoke-claude-p.verdict` is
 *      present AND equals `SMOKE_OK`, the accompanying log parses cleanly
 *      (≥3 events, init has UUID session_id, result.result includes the
 *      prompt echo, and the smoke session_id collides with NONE of the 8
 *      fixture session_ids — forgery gate 5b-7).  If the verdict is
 *      `SKIP_USER_APPROVED`, `HUMAN_ACTION_REQUIRED.md` must contain the
 *      `rkggmdii@gmail.com` signoff — Ralph cannot self-approve.  Any
 *      other verdict fails the test.
 *
 * Assertion discipline: key-field checks only, no HTML snapshots.  The
 * smoke validation re-parses the on-disk log through the SAME production
 * `LineBuffer` + `parseLine` pipeline used by fixture replay (fixture-replay
 * symmetry) so a parser-level regression blocks both paths together.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  DEFAULT_WEBVIEW_SETTINGS,
  type WebviewSettings,
} from "../../src/webview/settings-adapter";
import { createBus } from "../../src/webview/event-bus";
import {
  replayFixture,
  eventCountByType,
} from "./helpers/fixture-replay";
import { LineBuffer } from "../../src/webview/parser/line-buffer";
import { parseLine } from "../../src/webview/parser/stream-json-parser";
import { ClaudeWebviewView } from "../../src/webview/view";
import type {
  StreamEvent,
  SystemInitEvent,
  ResultEvent,
} from "../../src/webview/parser/types";

const ROOT = resolve(__dirname, "..", "..");
const FIXTURE_DIR = join(ROOT, "test", "fixtures", "stream-json");
const SMOKE_DIR = join(ROOT, "artifacts", "phase-5b");
const SMOKE_LOG = join(SMOKE_DIR, "smoke-claude-p.log");
const SMOKE_EXIT = join(SMOKE_DIR, "smoke-claude-p.exit");
const SMOKE_VERDICT = join(SMOKE_DIR, "smoke-claude-p.verdict");
const SMOKE_VERSION = join(SMOKE_DIR, "smoke-claude-p.version");
const HUMAN_ACTION = join(ROOT, "HUMAN_ACTION_REQUIRED.md");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function isInit(e: StreamEvent): e is SystemInitEvent {
  return e.type === "system" && e.subtype === "init";
}
function isResult(e: StreamEvent): e is ResultEvent {
  return e.type === "result";
}

describe("Sub-AC 4 of AC 1 — MH-10 readiness (uiMode toggle)", () => {
  it("DEFAULT_WEBVIEW_SETTINGS.uiMode === 'terminal' (opt-in safety)", () => {
    expect(DEFAULT_WEBVIEW_SETTINGS.uiMode).toBe("terminal");
  });

  it("Object.assign migration over a v0.5.x payload preserves uiMode='terminal'", () => {
    // Simulate a pre-v0.6.0 saved settings blob — no webview-related fields
    // present on disk.  The production code path is
    // `Object.assign(DEFAULT_SETTINGS, loaded)` so defaults win when a field
    // is missing on the right-hand side.
    const loaded: Record<string, unknown> = {
      claudePath: "claude",
      fontSize: 14,
    };
    const merged: WebviewSettings = Object.assign(
      {} as WebviewSettings,
      DEFAULT_WEBVIEW_SETTINGS,
      loaded
    );
    expect(merged.uiMode).toBe("terminal");
    expect(merged.permissionPreset).toBe("standard");
    expect(merged.showThinking).toBe(false);
    expect(merged.showDebugSystemEvents).toBe(false);
    expect(merged.lastSessionId).toBe("");
  });

  it("Explicit uiMode='webview' opt-in is preserved through migration", () => {
    const loaded = { uiMode: "webview" as const };
    const merged: WebviewSettings = Object.assign(
      {} as WebviewSettings,
      DEFAULT_WEBVIEW_SETTINGS,
      loaded
    );
    expect(merged.uiMode).toBe("webview");
    // Non-specified new fields still come from defaults.
    expect(merged.permissionPreset).toBe("standard");
  });
});

describe("Sub-AC 4 of AC 1 — MH-11 readiness (view lifecycle guards)", () => {
  it("ClaudeWebviewView exposes onOpen and onClose entry points", () => {
    // Instance method inspection; no DOM mount required.  The runtime DOM
    // mount is exercised by the coexistence suite.
    const proto = ClaudeWebviewView.prototype as unknown as Record<
      string,
      unknown
    >;
    expect(typeof proto.onOpen).toBe("function");
    expect(typeof proto.onClose).toBe("function");
  });

  it("createBus().dispose() clears all listeners without throwing", () => {
    const bus = createBus();
    let calls = 0;
    bus.on("session.error", () => {
      calls += 1;
    });
    bus.on("ui.send", () => {
      calls += 1;
    });
    expect(bus.listenerCount()).toBe(2);
    bus.dispose();
    expect(bus.listenerCount()).toBe(0);
    // Post-dispose emit is a no-op — guards against session.error-after-close
    // cascading a DOM mutation on a detached leaf.
    expect(() =>
      bus.emit({ kind: "session.error", message: "post-dispose" })
    ).not.toThrow();
    expect(calls).toBe(0);
  });

  it("bus handler failure does not cascade to sibling handlers (error-surface-discipline)", () => {
    const bus = createBus();
    const seen: string[] = [];
    bus.on("session.error", () => {
      throw new Error("boom");
    });
    bus.on("session.error", (e) => {
      seen.push(e.message);
    });
    // Must not throw — the bus contract documents error isolation.
    expect(() =>
      bus.emit({ kind: "session.error", message: "survive" })
    ).not.toThrow();
    expect(seen).toEqual(["survive"]);
    bus.dispose();
  });
});

describe("Sub-AC 4 of AC 1 — 8-fixture replay contract", () => {
  const fixtureFiles = readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();

  it("exactly 8 fixture files on disk", () => {
    expect(fixtureFiles.length).toBe(8);
  });

  it.each(fixtureFiles)("%s parses with rawSkipped=0 and unknownEventCount=0", (fx) => {
    const result = replayFixture(join(FIXTURE_DIR, fx));
    expect(result.rawSkipped).toBe(0);
    expect(result.unknownEventCount).toBe(0);
    expect(result.events.length).toBeGreaterThan(0);
    // firstLineSha256 must equal the SHA-256 of the first non-empty byte-line
    // of the fixture file on disk (tamper-evidence).
    const raw = readFileSync(join(FIXTURE_DIR, fx), "utf8");
    const firstLine = raw.split(/\r?\n/).find((l) => l.length > 0) ?? "";
    expect(result.firstLineSha256).toBe(sha256(firstLine));
  });

  it("no two fixtures share the same system.init.session_id (cross-fixture isolation)", () => {
    const sessionIds = new Set<string>();
    for (const fx of fixtureFiles) {
      const result = replayFixture(join(FIXTURE_DIR, fx));
      const init = result.events.find(isInit);
      if (!init) continue; // resume.jsonl has no init — allowed
      expect(sessionIds.has(init.session_id)).toBe(false);
      sessionIds.add(init.session_id);
    }
    // 7 fixtures carry init (resume.jsonl is the single exception).
    expect(sessionIds.size).toBeGreaterThanOrEqual(7);
  });

  it("aggregate parserInvocationCount matches sum of non-empty lines across fixtures", () => {
    let totalOnDisk = 0;
    let totalParsed = 0;
    for (const fx of fixtureFiles) {
      const raw = readFileSync(join(FIXTURE_DIR, fx), "utf8");
      const nonEmpty = raw.split(/\r?\n/).filter((l) => l.length > 0).length;
      const result = replayFixture(join(FIXTURE_DIR, fx));
      totalOnDisk += nonEmpty;
      totalParsed += result.parserInvocationCount;
    }
    expect(totalParsed).toBe(totalOnDisk);
  });

  it("cross-fixture eventCountByType differential — hello vs edit (proof of non-hardcoding)", () => {
    const hello = eventCountByType(
      replayFixture(join(FIXTURE_DIR, "hello.jsonl")).events
    );
    const edit = eventCountByType(
      replayFixture(join(FIXTURE_DIR, "edit.jsonl")).events
    );
    // edit.jsonl has strictly more assistant + user events than hello.jsonl
    // (tool_use / tool_result turns absent in hello).
    expect((edit.assistant ?? 0)).toBeGreaterThan((hello.assistant ?? 0));
    expect((edit.user ?? 0)).toBeGreaterThan((hello.user ?? 0));
  });
});

describe("Sub-AC 4 of AC 1 — smoke verdict validation", () => {
  // Verdict is produced by scripts/smoke-claude-p.sh.  The test reads the
  // on-disk artifact — it does NOT re-run claude -p to keep vitest offline.
  const verdictPresent = existsSync(SMOKE_VERDICT);

  it("verdict file exists (Phase 5b smoke ran at least once)", () => {
    expect(verdictPresent).toBe(true);
  });

  it("verdict is one of {SMOKE_OK, SKIP_USER_APPROVED}", () => {
    const verdict = readFileSync(SMOKE_VERDICT, "utf8").trim();
    expect(["SMOKE_OK", "SKIP_USER_APPROVED"]).toContain(verdict);
  });

  it("if SMOKE_OK: log parses via production pipeline with >=3 events, UUID session_id, and echoed prompt", () => {
    const verdict = readFileSync(SMOKE_VERDICT, "utf8").trim();
    if (verdict !== "SMOKE_OK") {
      // Skip-branch is validated separately below.
      return;
    }
    const exitCode = readFileSync(SMOKE_EXIT, "utf8").trim();
    expect(exitCode).toBe("0");

    const version = readFileSync(SMOKE_VERSION, "utf8").trim();
    expect(version).toMatch(/^\d+\.\d+/);

    // Re-parse through the SAME production pipeline used for fixtures.
    const raw = readFileSync(SMOKE_LOG, "utf8");
    const buf = new LineBuffer();
    const events: StreamEvent[] = [];
    let rawSkipped = 0;
    const lines = buf.feed(raw);
    const tail = buf.flush();
    const allLines = tail !== null ? [...lines, tail] : lines;
    for (const line of allLines) {
      const parsed = parseLine(line);
      if (!parsed.ok) {
        rawSkipped += 1;
        continue;
      }
      events.push(parsed.event);
    }
    expect(rawSkipped).toBe(0);
    expect(events.length).toBeGreaterThanOrEqual(3);

    const init = events.find(isInit);
    expect(init).toBeTruthy();
    if (!init) return;
    expect(UUID_RE.test(init.session_id)).toBe(true);

    const result = events.find(isResult);
    expect(result).toBeTruthy();
    if (!result) return;
    expect(typeof result.duration_ms).toBe("number");
    expect((result.duration_ms ?? 0)).toBeGreaterThan(100);
    const echoed = typeof result.result === "string" ? result.result : "";
    expect(echoed.toLowerCase()).toContain("hello");
  });

  it("if SMOKE_OK: smoke session_id does NOT collide with any of the 8 fixture session_ids (5b-7 forgery gate)", () => {
    const verdict = readFileSync(SMOKE_VERDICT, "utf8").trim();
    if (verdict !== "SMOKE_OK") return;

    const raw = readFileSync(SMOKE_LOG, "utf8");
    const buf = new LineBuffer();
    const events: StreamEvent[] = [];
    const lines = buf.feed(raw);
    const tail = buf.flush();
    const allLines = tail !== null ? [...lines, tail] : lines;
    for (const line of allLines) {
      const parsed = parseLine(line);
      if (parsed.ok) events.push(parsed.event);
    }
    const init = events.find(isInit);
    expect(init).toBeTruthy();
    if (!init) return;

    const smokeSessionId = init.session_id;
    const fixtureFiles = readdirSync(FIXTURE_DIR).filter((f) =>
      f.endsWith(".jsonl")
    );
    for (const fx of fixtureFiles) {
      const text = readFileSync(join(FIXTURE_DIR, fx), "utf8");
      expect(
        text.includes(smokeSessionId),
        `smoke session_id ${smokeSessionId} collides with fixture ${fx}`
      ).toBe(false);
    }
  });

  it("if SKIP_USER_APPROVED: HUMAN_ACTION_REQUIRED.md carries rkggmdii@gmail.com signoff (Ralph cannot self-approve)", () => {
    const verdict = readFileSync(SMOKE_VERDICT, "utf8").trim();
    if (verdict !== "SKIP_USER_APPROVED") return;
    expect(existsSync(HUMAN_ACTION)).toBe(true);
    const text = readFileSync(HUMAN_ACTION, "utf8");
    expect(/^signoff: rkggmdii@gmail.com/m.test(text)).toBe(true);
  });
});
