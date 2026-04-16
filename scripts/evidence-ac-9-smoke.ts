// Generate artifacts/phase-5b/ac-9-smoke-evidence.json from the actual
// artifacts produced by scripts/smoke-claude-p.sh.
//
// AC 9 contract: "Single real `claude -p` smoke test passes with UUID
// session_id + version field + duration > 100ms".
//
// This script READS (does not re-spawn) the 3-file evidence design
// (smoke-claude-p.log, smoke-claude-p.exit, smoke-claude-p.version) and
// emits a cross-referencable evidence JSON. Re-spawning claude would cost
// money and racily overwrite the forensic log — we parse it instead.

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const ROOT = path.resolve(__dirname, "..");
const PHASE_DIR = path.join(ROOT, "artifacts", "phase-5b");
const LOG_FILE = path.join(PHASE_DIR, "smoke-claude-p.log");
const EXIT_FILE = path.join(PHASE_DIR, "smoke-claude-p.exit");
const VERDICT_FILE = path.join(PHASE_DIR, "smoke-claude-p.verdict");
const VERSION_FILE = path.join(PHASE_DIR, "smoke-claude-p.version");
const OUT_FILE = path.join(PHASE_DIR, "ac-9-smoke-evidence.json");

function mustRead(p: string): string {
  if (!fs.existsSync(p)) {
    throw new Error(`missing artifact: ${path.relative(ROOT, p)}`);
  }
  return fs.readFileSync(p, "utf8");
}

const logRaw = mustRead(LOG_FILE);
const exitRaw = mustRead(EXIT_FILE).trim();
const verdictRaw = mustRead(VERDICT_FILE).trim();
const versionRaw = mustRead(VERSION_FILE).trim();

const lines = logRaw.split(/\r?\n/).filter((l) => l.length > 0);
const parsed: Array<Record<string, unknown>> = [];
for (const l of lines) {
  try {
    parsed.push(JSON.parse(l) as Record<string, unknown>);
  } catch {
    // Raw lines in the log that don't parse are forensic detail only. The
    // smoke contract requires >=3 VALID JSONL events so a few malformed
    // lines would fail the gate below — no silent swallow.
  }
}

const initEvent = parsed.find(
  (e) => e.type === "system" && (e as { subtype?: unknown }).subtype === "init",
) as { session_id?: unknown } | undefined;
const resultEvent = parsed.find((e) => e.type === "result") as
  | { duration_ms?: unknown; result?: unknown; is_error?: unknown }
  | undefined;

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sessionId =
  initEvent && typeof initEvent.session_id === "string" ? initEvent.session_id : null;
const uuidOk = sessionId !== null && uuidRe.test(sessionId);

const durationMs =
  resultEvent && typeof resultEvent.duration_ms === "number"
    ? resultEvent.duration_ms
    : -1;
const durationOk = durationMs > 100;

// Version line looks like: "2.1.110 (Claude Code)". Require `<major>.<minor>`.
const versionOk = /^\s*[0-9]+\.[0-9]+/m.test(versionRaw);
const versionNumber = (versionRaw.match(/^\s*([0-9]+\.[0-9]+\.?[0-9]*)/m) ?? [])[1] ?? null;

const exitOk = exitRaw === "0";
const verdictOk = verdictRaw === "SMOKE_OK";

// 5b-7 anti-forgery: session_id must not appear in ANY stream-json fixture.
const fixtureDir = path.join(ROOT, "test", "fixtures", "stream-json");
const fixtureFiles = fs.existsSync(fixtureDir) ? fs.readdirSync(fixtureDir) : [];
const fixtureContents = fixtureFiles.map((f) =>
  fs.readFileSync(path.join(fixtureDir, f), "utf8"),
);
const fixtureCollision =
  sessionId === null
    ? false
    : fixtureContents.some((c) => c.includes(sessionId));
const antiForgeryOk = !fixtureCollision;

// sha256 of full log for forensic anchor
const logSha256 = crypto.createHash("sha256").update(logRaw, "utf8").digest("hex");

const ac9ContractPass = uuidOk && versionOk && durationOk;
const fullSmokePass =
  ac9ContractPass && verdictOk && exitOk && parsed.length >= 3 && antiForgeryOk;

const evidence = {
  id: "AC-9",
  generatedBy: "scripts/evidence-ac-9-smoke.ts",
  generatedAt: new Date().toISOString(),
  phase: "5b",
  sourceArtifacts: {
    log: "artifacts/phase-5b/smoke-claude-p.log",
    exit: "artifacts/phase-5b/smoke-claude-p.exit",
    verdict: "artifacts/phase-5b/smoke-claude-p.verdict",
    version: "artifacts/phase-5b/smoke-claude-p.version",
  },
  logSha256,
  parsedEventCount: parsed.length,
  parsedEventTypes: parsed.map((e) => {
    const sub = (e as { subtype?: unknown }).subtype;
    return typeof sub === "string" ? `${String(e.type)}:${sub}` : String(e.type);
  }),
  ac9Contract: {
    uuidSessionId: {
      required: true,
      pass: uuidOk,
      value: sessionId,
      regex: uuidRe.source,
    },
    versionField: {
      required: true,
      pass: versionOk,
      raw: versionRaw,
      parsed: versionNumber,
    },
    durationGt100ms: {
      required: true,
      pass: durationOk,
      value: durationMs,
      threshold: 100,
    },
  },
  ac9ContractPass,
  additionalChecks: {
    smokeVerdict: { pass: verdictOk, value: verdictRaw },
    exitCode: { pass: exitOk, value: exitRaw },
    parsedCountGe3: { pass: parsed.length >= 3, value: parsed.length },
    sessionIdNotInFixtures: { pass: antiForgeryOk, collision: fixtureCollision },
  },
  fullSmokePass,
  resultPreview:
    resultEvent && typeof resultEvent.result === "string"
      ? String(resultEvent.result).slice(0, 80)
      : null,
  resultIsError:
    resultEvent && typeof resultEvent.is_error === "boolean"
      ? resultEvent.is_error
      : null,
};

fs.mkdirSync(PHASE_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(evidence, null, 2) + "\n", "utf8");
console.log(`[ac-9-evidence] wrote ${path.relative(ROOT, OUT_FILE)}`);
console.log(
  `[ac-9-evidence] ac9ContractPass=${ac9ContractPass} fullSmokePass=${fullSmokePass} uuid=${uuidOk} version=${versionOk} duration_ms=${durationMs}(>100:${durationOk})`,
);
if (!ac9ContractPass) {
  console.error("[ac-9-evidence] AC 9 contract NOT met");
  process.exit(1);
}
