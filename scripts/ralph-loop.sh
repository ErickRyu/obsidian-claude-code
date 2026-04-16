#!/usr/bin/env bash
# Traditional Ralph Loop — headless `claude -p` 기반
# 사용법: bash scripts/ralph-loop.sh [MAX_ITERATIONS]
# 기본 MAX=10. COMPLETION_PHRASE 나오거나 MAX 도달 시 종료.

set -uo pipefail

# PATH 보강 — claude 바이너리 위치 명시 (symlink: ~/.local/bin/claude)
export PATH="$HOME/.local/bin:$PATH"
if ! command -v claude >/dev/null 2>&1; then
  echo "[ralph] STOP — claude 바이너리 없음. 예상 경로: ~/.local/bin/claude" >&2
  exit 127
fi
CLAUDE_VERSION="$(claude --version 2>/dev/null || echo unknown)"
echo "[ralph] claude: $CLAUDE_VERSION"

MAX="${1:-10}"
COMPLETION_PHRASE="V0.6.0_WEBVIEW_FOUNDATION_COMPLETE"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$REPO_ROOT/logs/ralph"
mkdir -p "$LOG_DIR"

# 안전 가드: main/master 에서 실행 차단
BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" == "main" || "$BRANCH" == "master" ]]; then
  echo "[ralph] STOP — main/master 브랜치에서 실행 불가. 현재: $BRANCH" >&2
  exit 1
fi

# HUMAN_ACTION_REQUIRED 차단
if [[ -f "$REPO_ROOT/HUMAN_ACTION_REQUIRED.md" ]]; then
  SIGNOFF=$(grep -c '^signoff: rkggmdii@gmail.com' "$REPO_ROOT/HUMAN_ACTION_REQUIRED.md" 2>/dev/null || echo 0)
  if [[ "$SIGNOFF" -eq 0 ]]; then
    echo "[ralph] STOP — HUMAN_ACTION_REQUIRED.md 존재 + 미서명. 사용자 개입 필요." >&2
    exit 2
  fi
fi

PROMPT='Read RALPH_PROMPT.md fully, then RALPH_PLAN.md fully, then PROGRESS.md, then execute exactly ONE iteration of STEP 0 → STEP 1 → STEP 2 → STEP 3 → STEP 4 as defined. Determine current phase from PROGRESS.md, do only that phase in this iteration, update PROGRESS.md, create phase-N-complete git tag when phase verification matrix all passes. If all completion conditions met, emit <promise>V0.6.0_WEBVIEW_FOUNDATION_COMPLETE</promise>. Do NOT exceed one phase in this iteration.'

ALLOWED_TOOLS="Read,Write,Edit,Bash,Glob,Grep,Task,TodoWrite"
PERM_MODE="acceptEdits"

echo "[ralph] start — branch=$BRANCH max=$MAX logs=$LOG_DIR"
echo "[ralph] completion phrase: $COMPLETION_PHRASE"

for i in $(seq 1 "$MAX"); do
  TS=$(date +%Y%m%d-%H%M%S)
  LOG="$LOG_DIR/iter-${i}-${TS}.jsonl"
  SUMMARY="$LOG_DIR/iter-${i}-${TS}.summary.txt"

  echo ""
  echo "[ralph] ==================================="
  echo "[ralph] iteration $i / $MAX  (log: $(basename "$LOG"))"
  echo "[ralph] ==================================="

  # HUMAN_ACTION_REQUIRED 재체크 (iteration 간 생성될 수 있음)
  if [[ -f "$REPO_ROOT/HUMAN_ACTION_REQUIRED.md" ]]; then
    SIGNOFF=$(grep -c '^signoff: rkggmdii@gmail.com' "$REPO_ROOT/HUMAN_ACTION_REQUIRED.md" 2>/dev/null || echo 0)
    if [[ "$SIGNOFF" -eq 0 ]]; then
      echo "[ralph] STOP — HUMAN_ACTION_REQUIRED.md 감지, 사용자 서명 대기. 루프 종료." >&2
      exit 2
    fi
  fi

  # claude -p 실행 (timeout 없이, 각 iteration 가 Phase 완료에 필요한 만큼)
  # - `--input-format stream-json` + `</dev/null` 조합은 stdin 대기로 hang → 빼야 함
  # - prompt 는 `-p "..."` 인자로 전달 (첫 user message 가 됨)
  (cd "$REPO_ROOT" && claude -p "$PROMPT" \
    --output-format stream-json \
    --verbose \
    --permission-mode "$PERM_MODE" \
    --allowedTools "$ALLOWED_TOOLS" \
    >"$LOG" 2>&1) &

  CLAUDE_PID=$!

  # live tail — 사용자가 진행 상황 볼 수 있도록
  (tail -f "$LOG" 2>/dev/null | head -n 200) &
  TAIL_PID=$!

  wait "$CLAUDE_PID"
  EXIT=$?
  kill "$TAIL_PID" 2>/dev/null || true

  # result 이벤트 추출 → summary
  LAST_RESULT=$(tail -n 500 "$LOG" | grep -E '"type":"result"' | tail -n 1 || true)
  {
    echo "iteration=$i exit=$EXIT"
    echo "log=$LOG"
    echo "timestamp=$(date -u +%FT%TZ)"
    echo "last_result=$LAST_RESULT"
    echo "git_tags=$(git -C "$REPO_ROOT" tag --list 'phase-*-complete' | tr '\n' ' ')"
    echo "test_count=$(cd "$REPO_ROOT" && npm run test --silent 2>&1 | grep -E 'Tests' | tail -1)"
  } > "$SUMMARY"

  cat "$SUMMARY"

  # Completion 감지
  if grep -q "$COMPLETION_PHRASE" "$LOG"; then
    echo ""
    echo "[ralph] 🎉 COMPLETION — $COMPLETION_PHRASE"
    echo "[ralph] final log: $LOG"
    exit 0
  fi

  # 비정상 종료 감지
  if [[ "$EXIT" -ne 0 ]]; then
    echo "[ralph] WARN — iteration $i exit=$EXIT. 계속 진행 (다음 iteration 재시도)."
  fi

  # HUMAN_ACTION_REQUIRED 생성 감지
  if [[ -f "$REPO_ROOT/HUMAN_ACTION_REQUIRED.md" ]]; then
    SIGNOFF=$(grep -c '^signoff: rkggmdii@gmail.com' "$REPO_ROOT/HUMAN_ACTION_REQUIRED.md" 2>/dev/null || echo 0)
    if [[ "$SIGNOFF" -eq 0 ]]; then
      echo "[ralph] PAUSE — HUMAN_ACTION_REQUIRED.md 생성됨. 루프 종료."
      echo "[ralph] 사용자 확인 후 signoff line 추가, 커밋, 재실행."
      exit 2
    fi
  fi
done

echo ""
echo "[ralph] MAX=$MAX 도달. completion 미달성."
echo "[ralph] PROGRESS.md 확인 후 추가 iteration 고려."
exit 3
