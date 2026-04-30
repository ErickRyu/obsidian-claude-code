#!/usr/bin/env bash
# Phase 0 gate: src/webview/ must not contain unsafe type escapes.
# Bans:
#   - `as any`
#   - @ts-ignore / @ts-expect-error
#   - `as SomeType &` (intersection-cast misuse)
#   - `[key: string]: unknown` (overly-permissive index signature)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$ROOT/src/webview"

if [ ! -d "$TARGET" ]; then
  echo "check-no-any: $TARGET does not exist yet; skipping"
  exit 0
fi

fail=0

while IFS= read -r -d '' file; do
  if grep -nE '\bas any\b|@ts-ignore|@ts-expect-error' "$file" >/dev/null 2>&1; then
    echo "FAIL: unsafe type escape in $file"
    grep -nE '\bas any\b|@ts-ignore|@ts-expect-error' "$file"
    fail=1
  fi
  if grep -nE '\bas\s+[A-Z][A-Za-z0-9_]*\s*&' "$file" >/dev/null 2>&1; then
    echo "FAIL: intersection-cast misuse in $file"
    grep -nE '\bas\s+[A-Z][A-Za-z0-9_]*\s*&' "$file"
    fail=1
  fi
  if grep -nE '\[key:\s*string\]:\s*unknown' "$file" >/dev/null 2>&1; then
    echo "FAIL: overly-permissive index signature in $file"
    grep -nE '\[key:\s*string\]:\s*unknown' "$file"
    fail=1
  fi
done < <(find "$TARGET" -type f -name '*.ts' -print0)

if [ $fail -ne 0 ]; then
  exit 1
fi

echo "check-no-any: OK"
exit 0
