#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"

if command -v mise >/dev/null 2>&1; then
  mise trust >/dev/null
fi

BUNDLE_DIR="dogfood/20260325-week8-capability-inventory"
LOG_DIR="$BUNDLE_DIR/logs"
SCREENSHOT_DIR="$BUNDLE_DIR/screenshots"
SNAPSHOT_DIR="$BUNDLE_DIR/snapshots"
RECORDING_DIR="$BUNDLE_DIR/recordings"
VIDEO_DIR="$BUNDLE_DIR/videos"
STATUS_TSV="$BUNDLE_DIR/command-status.tsv"

mkdir -p "$LOG_DIR" "$SCREENSHOT_DIR" "$SNAPSHOT_DIR" "$RECORDING_DIR" "$VIDEO_DIR"
find "$LOG_DIR" "$SCREENSHOT_DIR" "$SNAPSHOT_DIR" "$RECORDING_DIR" "$VIDEO_DIR" -mindepth 1 -maxdepth 1 -type f -delete
rm -f "$BUNDLE_DIR/agent-terminal-home.txt" "$STATUS_TSV" \
  "$BUNDLE_DIR/01-version.json" "$BUNDLE_DIR/02-doctor.json"
touch "$SCREENSHOT_DIR/.gitkeep" "$SNAPSHOT_DIR/.gitkeep" "$RECORDING_DIR/.gitkeep" "$VIDEO_DIR/.gitkeep"

pretty_json() {
  local path="$1"
  node -e "const fs=require('fs'); const path=process.argv[1]; const text=fs.readFileSync(path,'utf8').trim(); if (text.length === 0) process.exit(0); const value=JSON.parse(text); fs.writeFileSync(path, JSON.stringify(value, null, 2) + '\n');" "$path"
}

record_status() {
  local step="$1"
  local command="$2"
  local exit_code="$3"
  local status="$4"
  printf '%s\t%s\t%s\t%s\n' "$step" "$command" "$exit_code" "$status" >> "$STATUS_TSV"
}

run_json_step() {
  local step="$1"
  local command="$2"
  local allow_failure="$3"
  local stdout_path="$LOG_DIR/$step.json"
  local stderr_path="$LOG_DIR/$step.stderr.txt"
  local exit_code=0

  set +e
  eval "$command" >"$stdout_path" 2>"$stderr_path"
  exit_code=$?
  set -e

  if [ -s "$stdout_path" ]; then
    pretty_json "$stdout_path"
  fi

  local status="pass"
  if [ "$exit_code" -ne 0 ]; then
    status="fail"
  fi
  record_status "$step" "$command" "$exit_code" "$status"

  if [ "$allow_failure" = "true" ] || [ "$exit_code" -eq 0 ]; then
    return 0
  fi
  return "$exit_code"
}

TMP_HOME=$(mktemp -d)
export AGENT_TERMINAL_HOME="$TMP_HOME"
printf '%s\n' "$AGENT_TERMINAL_HOME" > "$BUNDLE_DIR/agent-terminal-home.txt"
printf 'step\tcommand\texit_code\tstatus\n' > "$STATUS_TSV"

cleanup() {
  rm -rf "$TMP_HOME"
}
trap cleanup EXIT

npm ci

run_json_step '01-version' 'npx tsx src/cli/main.ts version --json' 'false'
cp "$LOG_DIR/01-version.json" "$BUNDLE_DIR/01-version.json"

run_json_step '02-doctor' 'npx tsx src/cli/main.ts doctor --json' 'false'
cp "$LOG_DIR/02-doctor.json" "$BUNDLE_DIR/02-doctor.json"
