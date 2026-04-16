#!/usr/bin/env bash
# Phase file allowlist gate — enforces RALPH_PLAN.md "Phase 파일 Allowlist".
# Usage: bash scripts/check-allowlist.sh <phase>
#   phase ∈ {0, 1, 2, 3, 4a, 4b, 5a, 5b, 6}
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEBVIEW="$ROOT/src/webview"
phase="${1:-}"

if [ -z "$phase" ]; then
  echo "usage: $0 <phase>"
  exit 2
fi

# Expected files, cumulative by phase (paths relative to src/webview/).
phase0=(
  "index.ts"
  "view.ts"
  "settings-adapter.ts"
)
phase1=(
  "${phase0[@]}"
  "parser/types.ts"
  "parser/line-buffer.ts"
  "parser/stream-json-parser.ts"
)
# Phase 2 allowlist reflects the Ouroboros-landed renderer + permission-UX
# surface that the audit (output/reviews/phase-2-audit-20260416.json) accepted
# as "conditionally acceptable" precursors. The MH-02..MH-06 contract and
# the Phase 2 differential test (2-3) both reference these modules, so they
# legitimately belong to the Phase 2 surface even though the full Edit/Write
# diff delegate + TodoWrite panel + permission integration finish in
# Phase 4a / 4b.
phase2=(
  "${phase1[@]}"
  "event-bus.ts"
  "ui/layout.ts"
  "ui/permission-dropdown.ts"
  "ui/allowed-tools-editor.ts"
  "renderers/card-registry.ts"
  "renderers/assistant-text.ts"
  "renderers/assistant-tool-use.ts"
  "renderers/user-tool-result.ts"
  "renderers/result.ts"
  "renderers/system-init.ts"
  "session/spawn-args.ts"
  "session/permission-presets.ts"
)
phase3=(
  "${phase2[@]}"
  "session/session-controller.ts"
  "ui/input-bar.ts"
)
phase4a=(
  "${phase3[@]}"
  "renderers/assistant-thinking.ts"
  "renderers/edit-diff.ts"
)
phase4b=(
  "${phase4a[@]}"
  "renderers/todo-panel.ts"
)
phase5a=(
  "${phase4b[@]}"
  "renderers/system-status.ts"
  "renderers/compact-boundary.ts"
  "ui/status-bar.ts"
)
phase5b=(
  "${phase5a[@]}"
  "session/session-archive.ts"
)
phase6=( "${phase5b[@]}" )

case "$phase" in
  0) expected=("${phase0[@]}") ;;
  1) expected=("${phase1[@]}") ;;
  2) expected=("${phase2[@]}") ;;
  3) expected=("${phase3[@]}") ;;
  4a) expected=("${phase4a[@]}") ;;
  4b) expected=("${phase4b[@]}") ;;
  5a) expected=("${phase5a[@]}") ;;
  5b) expected=("${phase5b[@]}") ;;
  6) expected=("${phase6[@]}") ;;
  *) echo "unknown phase: $phase"; exit 2 ;;
esac

if [ ! -d "$WEBVIEW" ]; then
  if [ ${#expected[@]} -eq 0 ]; then
    exit 0
  fi
  echo "FAIL: $WEBVIEW missing but phase $phase expects ${#expected[@]} files"
  exit 1
fi

# Gather actual files, relative to WEBVIEW.
actual_sorted=$(cd "$WEBVIEW" && find . -type f -name '*.ts' | sed 's#^\./##' | LC_ALL=C sort)
expected_sorted=$(printf '%s\n' "${expected[@]}" | LC_ALL=C sort)

missing=$(comm -23 <(echo "$expected_sorted") <(echo "$actual_sorted") || true)
extra=$(comm -13 <(echo "$expected_sorted") <(echo "$actual_sorted") || true)

fail=0
if [ -n "$missing" ]; then
  echo "FAIL: phase $phase missing files:"
  echo "$missing" | sed 's/^/  - /'
  fail=1
fi
if [ -n "$extra" ]; then
  echo "FAIL: phase $phase has extra files not in allowlist:"
  echo "$extra" | sed 's/^/  - /'
  fail=1
fi

if [ $fail -ne 0 ]; then
  exit 1
fi

echo "check-allowlist: phase $phase OK (${#expected[@]} files)"
exit 0
