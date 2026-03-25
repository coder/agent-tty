#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"

BUNDLE_DIR="dogfood/20260325-week8-contract-locks"
LOG_DIR="$BUNDLE_DIR/logs"
SCREENSHOT_DIR="$BUNDLE_DIR/screenshots"
RECORDING_DIR="$BUNDLE_DIR/recordings"
VIDEO_DIR="$BUNDLE_DIR/videos"
SNAPSHOT_DIR="$BUNDLE_DIR/snapshots"
STATUS_FILE="$BUNDLE_DIR/command-status.tsv"

mkdir -p "$LOG_DIR" "$SCREENSHOT_DIR" "$RECORDING_DIR" "$VIDEO_DIR" "$SNAPSHOT_DIR"
find "$LOG_DIR" "$SCREENSHOT_DIR" "$RECORDING_DIR" "$VIDEO_DIR" "$SNAPSHOT_DIR" \
  -mindepth 1 \
  -maxdepth 1 \
  ! -name '.gitkeep' \
  -exec rm -rf {} +

for dir in "$SCREENSHOT_DIR" "$RECORDING_DIR" "$VIDEO_DIR" "$SNAPSHOT_DIR"; do
  : > "$dir/.gitkeep"
done

printf 'step\tcommand\texit_code\tstatus\n' > "$STATUS_FILE"

record_status() {
  local step="$1"
  local command_text="$2"
  local exit_code="$3"
  local status="ok"
  if [[ "$exit_code" -ne 0 ]]; then
    status="failed"
  fi
  printf '%s\t%s\t%s\t%s\n' "$step" "$command_text" "$exit_code" "$status" >> "$STATUS_FILE"
}

run_capture() {
  local step="$1"
  local stdout_path="$2"
  local stderr_path="$3"
  shift 3
  local exit_code=0
  if "$@" >"$stdout_path" 2>"$stderr_path"; then
    exit_code=0
  else
    exit_code=$?
  fi
  record_status "$step" "$*" "$exit_code"
  return "$exit_code"
}

RAW_JSON="$LOG_DIR/.01-golden-envelopes.raw.json"
run_capture \
  '01' \
  "$RAW_JSON" \
  "$LOG_DIR/01-golden-envelopes.stderr.txt" \
  npx vitest run test/unit/commands/golden-envelopes.test.ts --reporter=json

node --input-type=module -e 'import { readFileSync, writeFileSync } from "node:fs"; const input = process.argv[1]; const output = process.argv[2]; const parsed = JSON.parse(readFileSync(input, "utf8")); writeFileSync(output, JSON.stringify(parsed, null, 2) + "\n");' \
  "$RAW_JSON" \
  "$LOG_DIR/01-golden-envelopes.json"
record_status '02' 'node --input-type=module -e <pretty-print-vitest-json> dogfood/20260325-week8-contract-locks/logs/.01-golden-envelopes.raw.json dogfood/20260325-week8-contract-locks/logs/01-golden-envelopes.json' '0'
cp "$LOG_DIR/01-golden-envelopes.json" "$SNAPSHOT_DIR/01-golden-envelopes.json"
record_status '03' 'cp dogfood/20260325-week8-contract-locks/logs/01-golden-envelopes.json dogfood/20260325-week8-contract-locks/snapshots/01-golden-envelopes.json' '0'
rm -f "$RAW_JSON"

run_capture \
  '04' \
  "$LOG_DIR/02-golden-envelopes.txt" \
  "$LOG_DIR/02-golden-envelopes.stderr.txt" \
  npx vitest run test/unit/commands/golden-envelopes.test.ts
