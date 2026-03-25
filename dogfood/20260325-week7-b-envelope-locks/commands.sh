#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"

BUNDLE="dogfood/20260325-week7-b-envelope-locks"
LOGS="$BUNDLE/logs"
STATUS="$BUNDLE/command-status.tsv"

mkdir -p "$LOGS" "$BUNDLE/screenshots"
: > "$BUNDLE/screenshots/.gitkeep"
printf 'step	command	exit_code	status
' > "$STATUS"

run_and_record() {
  local step="$1"
  local stdout_path="$2"
  local stderr_path="$3"
  local optional="$4"
  shift 4

  local exit_code=0
  if "$@" >"$stdout_path" 2>"$stderr_path"; then
    exit_code=0
  else
    exit_code=$?
  fi

  local status="ok"
  if [[ $exit_code -ne 0 ]]; then
    if [[ "$optional" == "optional" ]]; then
      status="optional-failed"
    else
      status="failed"
    fi
  fi

  printf '%s	%s	%s	%s
' "$step" "$*" "$exit_code" "$status" >> "$STATUS"
}

mise trust mise.toml
npm ci

run_and_record   '01'   "$LOGS/01-vitest-verbose.txt"   "$LOGS/01-vitest-verbose.stderr.txt"   required   npx vitest run test/unit/commands/golden-envelopes.test.ts --reporter=verbose

run_and_record   '02'   "$LOGS/02-vitest-json.json"   "$LOGS/02-vitest-json.stderr.txt"   optional   npx vitest run test/unit/commands/golden-envelopes.test.ts --reporter=json

run_and_record   '03'   "$LOGS/03-test-source.txt"   "$LOGS/03-test-source.stderr.txt"   required   cat test/unit/commands/golden-envelopes.test.ts

npx prettier --write "$BUNDLE"
npx prettier --check "$BUNDLE"
