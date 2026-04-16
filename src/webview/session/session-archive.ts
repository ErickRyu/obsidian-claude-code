/**
 * SessionArchive — Phase 5b (SH-07).
 *
 * Directly-owned JSONL store for every `StreamEvent` that the
 * SessionController parsed off `claude -p` stdout. Used when `--resume
 * <sid>` fails (CLI "session not found" / expired server-side state) so
 * the webview can still rehydrate the prior conversation from local disk
 * instead of showing an empty leaf.
 *
 * On-disk layout:
 *   <baseDir>/<session_id>.jsonl
 *     line 0: {type:"archive_meta", version:1, session_id, saved_at}
 *     line N: JSON of StreamEvent N (as emitted by stream-json-parser)
 *
 * The `archive_meta` header is written on the FIRST `append(sid, ev)`
 * call per session id within an instance lifetime; on subsequent calls
 * the header is not rewritten (in-memory `initialized` guard). If the
 * file existed prior to the instance being constructed, the header is
 * NOT re-emitted either — the caller is responsible for ensuring the
 * file was produced by a prior SessionArchive.
 *
 * Design rules:
 *   - **Node-only, no DOM / no Obsidian** — `session/*` layer contract.
 *     The default impl binds to `node:fs`; tests inject an in-memory
 *     `ArchiveFsImpl` so `vitest` under happy-dom stays hermetic.
 *   - **UUID defense-in-depth** — `session_id` is user-derived (from
 *     `settings.lastSessionId` which the CLI emitted originally). We
 *     validate the 8-4-4-4-12 hex shape at BOTH `append` and `load` to
 *     prevent a malformed settings file from addressing a path like
 *     `../../../etc/passwd.jsonl`. Argv-style `spawn` already blocks
 *     shell injection, but the archive is a FS write path.
 *   - **Quiet failure on corrupt header** — `load()` returns `[]` when
 *     the file is missing, the first line is non-JSON, `version !== 1`,
 *     the session id in the header mismatches the requested one, or any
 *     surface error occurs during read. The caller (view.ts resume
 *     fallback) treats an empty load as "no archive" and leaves the
 *     leaf in its default state. A noisy error surface would force the
 *     user to reason about a second failure mode on top of the primary
 *     `claude -p --resume` failure — explicitly out of scope for Beta.
 *   - **Malformed JSONL lines skipped, not fatal** — a partial crash
 *     mid-append can leave a truncated line; we parse each non-header
 *     line via the production `parseLine` so unrecoverable entries drop
 *     out silently (matches the stdout stream-parser contract).
 *
 * Allowlist: this module is the Phase 5b +1 file per
 * `scripts/check-allowlist.sh 5b`.
 */
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { parseLine } from "../parser/stream-json-parser";
import type { StreamEvent } from "../parser/types";

/**
 * Minimal filesystem surface the archive needs.  `node:fs` satisfies
 * this structurally; tests pass an in-memory `Map<path,string>` impl so
 * there is no tmp-dir churn or worker-race risk.  Only the methods used
 * below are declared — keeping the surface tight prevents a future
 * `rmSync` call from slipping past review.
 */
export interface ArchiveFsImpl {
  mkdirSync(p: string, opts?: { recursive?: boolean }): unknown;
  existsSync(p: string): boolean;
  readFileSync(p: string, encoding: "utf8"): string;
  appendFileSync(p: string, data: string): void;
}

/**
 * Header written as line 0 of every archive file.  `version` is a
 * literal `1` so a future `2` can be rejected explicitly by `load()`
 * (forward-compat: a later build that reads an older file can branch
 * on the number; a current build that sees `version !== 1` returns `[]`
 * and the user loses that archive — accepted Beta behavior).
 */
export interface ArchiveMeta {
  readonly type: "archive_meta";
  readonly version: 1;
  readonly session_id: string;
  readonly saved_at: string;
}

export interface SessionArchiveOptions {
  /**
   * Absolute directory under which `<session_id>.jsonl` is written.
   * The wireWebview production path resolves this from the Obsidian
   * plugin data dir; tests pass a synthetic POSIX path.
   */
  readonly baseDir: string;
  /** Injected FS impl — defaults to `node:fs`. */
  readonly fs?: ArchiveFsImpl;
  /** Injected clock — defaults to `() => new Date()`. */
  readonly clock?: () => Date;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SessionArchive {
  private readonly fs: ArchiveFsImpl;
  private readonly clock: () => Date;
  private readonly baseDir: string;
  private readonly initialized = new Set<string>();
  private dirEnsured = false;

  constructor(opts: SessionArchiveOptions) {
    this.baseDir = opts.baseDir;
    this.fs = opts.fs ?? (nodeFs as ArchiveFsImpl);
    this.clock = opts.clock ?? (() => new Date());
  }

  /**
   * Append `event` to `<baseDir>/<sessionId>.jsonl`.  Writes the
   * `archive_meta` header on first use per session id.  Idempotent on
   * the header within an instance; across instances relies on
   * `existsSync(path) === false` to suppress duplicate headers.
   */
  append(sessionId: string, event: StreamEvent): void {
    this.validateSessionId(sessionId);
    const path = this.pathFor(sessionId);

    if (!this.initialized.has(sessionId)) {
      this.ensureDir();
      if (!this.fs.existsSync(path)) {
        const meta: ArchiveMeta = {
          type: "archive_meta",
          version: 1,
          session_id: sessionId,
          saved_at: this.clock().toISOString(),
        };
        this.fs.appendFileSync(path, JSON.stringify(meta) + "\n");
      }
      this.initialized.add(sessionId);
    }

    this.fs.appendFileSync(path, JSON.stringify(event) + "\n");
  }

  /**
   * Read `<baseDir>/<sessionId>.jsonl`, validate the header, and return
   * the subsequent events parsed through the production `parseLine`.
   * Any error or header mismatch yields `[]` (see module docstring).
   */
  load(sessionId: string): StreamEvent[] {
    this.validateSessionId(sessionId);
    const path = this.pathFor(sessionId);
    if (!this.fs.existsSync(path)) return [];

    let raw: string;
    try {
      raw = this.fs.readFileSync(path, "utf8");
    } catch {
      return [];
    }

    const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines.length === 0) return [];

    let metaParsed: unknown;
    try {
      metaParsed = JSON.parse(lines[0]);
    } catch {
      return [];
    }
    if (!isObject(metaParsed)) return [];
    if (metaParsed.type !== "archive_meta") return [];
    if (metaParsed.version !== 1) return [];
    if (metaParsed.session_id !== sessionId) return [];

    const events: StreamEvent[] = [];
    for (let i = 1; i < lines.length; i++) {
      const parsed = parseLine(lines[i]);
      if (parsed.ok) events.push(parsed.event);
    }
    return events;
  }

  private ensureDir(): void {
    if (this.dirEnsured) return;
    this.fs.mkdirSync(this.baseDir, { recursive: true });
    this.dirEnsured = true;
  }

  private pathFor(sessionId: string): string {
    return join(this.baseDir, `${sessionId}.jsonl`);
  }

  private validateSessionId(sessionId: string): void {
    if (!UUID_RE.test(sessionId)) {
      throw new Error(
        `[claude-webview] SessionArchive: session_id must be a UUID (received "${sessionId}")`,
      );
    }
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
