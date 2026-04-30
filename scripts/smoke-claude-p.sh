#!/usr/bin/env bash
# Phase 5b smoke test (single real `claude -p` execution).
#
# Runs once per release — validates the foundation of the webview by spawning
# the actual Claude Code CLI in stream-json mode, capturing stdout as JSONL,
# and recording exit code + verdict separately (3-file design so any one file
# alone cannot be forged — see RALPH_PROMPT PM-2).
#
# Outputs:
#   artifacts/phase-5b/smoke-claude-p.version  — `claude --version` output
#   artifacts/phase-5b/smoke-claude-p.log      — raw stdout JSONL from `claude -p`
#   artifacts/phase-5b/smoke-claude-p.exit     — numeric exit code
#   artifacts/phase-5b/smoke-claude-p.verdict  — SMOKE_OK | SKIP_USER_APPROVED | SKIP_NOT_APPROVED
#
# Verdict rules:
#   SMOKE_OK            — claude -p exit 0, stdout contains system.init with UUID session_id
#                         AND result event with "hello" in result.result, AND >= 3 parsed events.
#   SKIP_USER_APPROVED  — CLAUDE_SMOKE_SKIP=1 AND HUMAN_ACTION_REQUIRED.md has
#                         rkggmdii@gmail.com signoff (user-only escalation).
#   SKIP_NOT_APPROVED   — CLAUDE_SMOKE_SKIP=1 but signoff missing. Ralph is
#                         blocked from self-approving.
#
# Timeout: 30s per RALPH_PLAN constraint.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/artifacts/phase-5b"
mkdir -p "$OUT_DIR"

VERSION_FILE="$OUT_DIR/smoke-claude-p.version"
LOG_FILE="$OUT_DIR/smoke-claude-p.log"
EXIT_FILE="$OUT_DIR/smoke-claude-p.exit"
VERDICT_FILE="$OUT_DIR/smoke-claude-p.verdict"
STDERR_FILE="$OUT_DIR/smoke-claude-p.stderr"

# Resolve the `claude` binary. Accept an absolute path hint via CLAUDE_BIN env
# for environments where it is not on PATH (e.g. ~/.local/bin not exported).
CLAUDE_BIN="${CLAUDE_BIN:-}"
if [ -z "$CLAUDE_BIN" ]; then
  if command -v claude >/dev/null 2>&1; then
    CLAUDE_BIN="$(command -v claude)"
  elif [ -x "$HOME/.local/bin/claude" ]; then
    CLAUDE_BIN="$HOME/.local/bin/claude"
  elif [ -x "$HOME/.claude/local/claude" ]; then
    CLAUDE_BIN="$HOME/.claude/local/claude"
  fi
fi

# --- SKIP branch ------------------------------------------------------------
if [ "${CLAUDE_SMOKE_SKIP:-0}" = "1" ]; then
  echo "[smoke] CLAUDE_SMOKE_SKIP=1 set — checking signoff"
  if [ -f "$ROOT/HUMAN_ACTION_REQUIRED.md" ] \
     && grep -qc '^signoff: rkggmdii@gmail.com' "$ROOT/HUMAN_ACTION_REQUIRED.md"; then
    echo "SKIP_USER_APPROVED" > "$VERDICT_FILE"
    echo "0" > "$EXIT_FILE"
    echo "[smoke] verdict=SKIP_USER_APPROVED"
    exit 0
  fi
  echo "SKIP_NOT_APPROVED" > "$VERDICT_FILE"
  echo "1" > "$EXIT_FILE"
  echo "[smoke] CLAUDE_SMOKE_SKIP requested but HUMAN_ACTION_REQUIRED.md missing rkggmdii@gmail.com signoff"
  exit 1
fi

if [ -z "$CLAUDE_BIN" ] || [ ! -x "$CLAUDE_BIN" ]; then
  echo "[smoke] claude binary not found (CLAUDE_BIN env or PATH)" >&2
  echo "SKIP_NOT_APPROVED" > "$VERDICT_FILE"
  echo "127" > "$EXIT_FILE"
  exit 127
fi

# (a) version
"$CLAUDE_BIN" --version > "$VERSION_FILE" 2>&1 || true

# (b) + (c) + (d) spawn claude -p, capture stdout / stderr / exit
# Use gtimeout if available (brew coreutils), else plain background kill.
TIMEOUT_BIN=""
if command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"
elif command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"
fi

: > "$LOG_FILE"
: > "$STDERR_FILE"

# Arg set per RALPH_PLAN 5b-4 (b). Prompt is passed positionally via -p; stream-json
# is enabled on the output side. We do NOT set --input-format=stream-json because
# that requires piping JSONL on stdin instead of using the -p CLI argument.
if [ -n "$TIMEOUT_BIN" ]; then
  "$TIMEOUT_BIN" 30 "$CLAUDE_BIN" -p "say hello in one word" \
    --output-format stream-json \
    --permission-mode acceptEdits \
    --allowedTools Read \
    --verbose \
    > "$LOG_FILE" 2> "$STDERR_FILE" < /dev/null
  SMOKE_EXIT=$?
else
  # Manual timeout via background + sleep watchdog (portable fallback).
  "$CLAUDE_BIN" -p "say hello in one word" \
    --output-format stream-json \
    --permission-mode acceptEdits \
    --allowedTools Read \
    --verbose \
    > "$LOG_FILE" 2> "$STDERR_FILE" < /dev/null &
  CLAUDE_PID=$!
  ( sleep 30 && kill -0 "$CLAUDE_PID" 2>/dev/null && kill -TERM "$CLAUDE_PID" 2>/dev/null ) &
  WATCH_PID=$!
  wait "$CLAUDE_PID"
  SMOKE_EXIT=$?
  kill -TERM "$WATCH_PID" 2>/dev/null || true
  wait "$WATCH_PID" 2>/dev/null || true
fi

echo "$SMOKE_EXIT" > "$EXIT_FILE"

# (e) parse stdout JSONL → verdict
#
# AC 9 contract: SMOKE_OK requires (i) UUID session_id in system.init,
# (ii) version field present in smoke-claude-p.version,
# (iii) result.duration_ms > 100. The helloOk check is retained as a weak
# semantic sanity signal but is not part of the AC 9 gate.
node - "$LOG_FILE" "$VERDICT_FILE" "$SMOKE_EXIT" "$VERSION_FILE" <<'NODE_EOF'
const fs = require("fs");
const [logFile, verdictFile, smokeExit, versionFile] = process.argv.slice(2);
const raw = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
const lines = raw.split(/\r?\n/).filter(Boolean);
const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const init = parsed.find((e) => e && e.type === "system" && e.subtype === "init");
const result = parsed.find((e) => e && e.type === "result");
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const initOk = !!(init && typeof init.session_id === "string" && uuidRe.test(init.session_id));
const resultStr = result && typeof result.result === "string" ? result.result : "";
const helloOk = /hello/i.test(resultStr);
const parseCountOk = parsed.length >= 3;
const exitOk = String(smokeExit) === "0";
const durationMs = result && typeof result.duration_ms === "number" ? result.duration_ms : -1;
const durationOk = durationMs > 100;
const versionRaw = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, "utf8") : "";
const versionOk = /^\s*[0-9]+\.[0-9]+/m.test(versionRaw);
const ok = initOk && helloOk && parseCountOk && exitOk && durationOk && versionOk;
if (ok) {
  fs.writeFileSync(verdictFile, "SMOKE_OK\n", "utf8");
  console.log(`[smoke] verdict=SMOKE_OK (events=${parsed.length}, session=${init.session_id.slice(0,8)}…, duration_ms=${durationMs}, version='${versionRaw.trim().split(/\s+/)[0]}', result='${resultStr.slice(0,40)}…')`);
} else {
  fs.writeFileSync(verdictFile, "SMOKE_FAIL\n", "utf8");
  console.log(
    `[smoke] verdict=SMOKE_FAIL (exit=${smokeExit} events=${parsed.length} initOk=${initOk} helloOk=${helloOk} durationOk=${durationOk} durationMs=${durationMs} versionOk=${versionOk})`
  );
}
process.exit(ok ? 0 : 1);
NODE_EOF
exit $?
