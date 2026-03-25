#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"
if command -v mise >/dev/null 2>&1; then
  mise trust >/dev/null 2>&1 || true
fi

BUNDLE_DIR="dogfood/20260325-week8-inspect-runtime"
LOG_DIR="$BUNDLE_DIR/logs"
JSON_DIR="$BUNDLE_DIR/json"
SCREENSHOT_DIR="$BUNDLE_DIR/screenshots"
SNAPSHOT_DIR="$BUNDLE_DIR/snapshots"
RECORDING_DIR="$BUNDLE_DIR/recordings"
VIDEO_DIR="$BUNDLE_DIR/videos"
STATUS_TSV="$BUNDLE_DIR/command-status.tsv"

mkdir -p "$LOG_DIR" "$JSON_DIR" "$SCREENSHOT_DIR" "$SNAPSHOT_DIR" "$RECORDING_DIR" "$VIDEO_DIR"
find "$LOG_DIR" "$JSON_DIR" "$SCREENSHOT_DIR" "$SNAPSHOT_DIR" "$RECORDING_DIR" "$VIDEO_DIR" -mindepth 1 -maxdepth 1 -type f -delete
rm -f "$BUNDLE_DIR/agent-terminal-home.txt" "$BUNDLE_DIR/session-id.txt" "$STATUS_TSV"
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

  if [ "$exit_code" -ne 0 ]; then
    return "$exit_code"
  fi
}

publish_json_output() {
  local source_path="$1"
  local output_path="$2"
  cp "$source_path" "$output_path"
}

TMP_HOME=$(mktemp -d)
export AGENT_TERMINAL_HOME="$TMP_HOME"
printf '%s\n' "$AGENT_TERMINAL_HOME" > "$BUNDLE_DIR/agent-terminal-home.txt"
printf 'step\tcommand\texit_code\tstatus\n' > "$STATUS_TSV"

cleanup() {
  if [ -n "${SESSION_ID:-}" ]; then
    if [ -f "$LOG_DIR/03-destroy.json" ]; then
      :
    else
      set +e
      npx tsx src/cli/main.ts destroy "$SESSION_ID" --json >"$LOG_DIR/99-cleanup-destroy.json" 2>"$LOG_DIR/99-cleanup-destroy.stderr.txt"
      cleanup_exit=$?
      set -e
      if [ -s "$LOG_DIR/99-cleanup-destroy.json" ]; then
        pretty_json "$LOG_DIR/99-cleanup-destroy.json"
      fi
      record_status '99-cleanup-destroy' "npx tsx src/cli/main.ts destroy $SESSION_ID --json" "$cleanup_exit" "$([ "$cleanup_exit" -eq 0 ] && printf pass || printf fail)"
    fi
  fi
  rm -rf "$TMP_HOME"
}
trap cleanup EXIT

run_json_step '01-create' 'npx tsx src/cli/main.ts create --json -- node --import tsx test/fixtures/apps/hello-prompt/main.ts'
SESSION_ID=$(node -e "const fs=require('fs'); const value=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); const sessionId=value?.result?.sessionId; if (typeof sessionId !== 'string' || sessionId.length === 0) { throw new Error('create output did not include result.sessionId'); } process.stdout.write(sessionId);" "$LOG_DIR/01-create.json")
printf '%s\n' "$SESSION_ID" > "$BUNDLE_DIR/session-id.txt"
sleep 2

run_json_step '02-inspect-live' "npx tsx src/cli/main.ts inspect $SESSION_ID --json"
publish_json_output "$LOG_DIR/02-inspect-live.json" "$JSON_DIR/inspect-live.json"
run_json_step '03-destroy' "npx tsx src/cli/main.ts destroy $SESSION_ID --json"
run_json_step '04-inspect-offline' "npx tsx src/cli/main.ts inspect $SESSION_ID --json"
publish_json_output "$LOG_DIR/04-inspect-offline.json" "$JSON_DIR/inspect-offline.json"
