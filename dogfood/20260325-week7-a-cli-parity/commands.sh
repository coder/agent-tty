#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"

BUNDLE_DIR="dogfood/20260325-week7-a-cli-parity"
LOG_DIR="$BUNDLE_DIR/logs"
SCREENSHOT_DIR="$BUNDLE_DIR/screenshots"
SNAPSHOT_DIR="$BUNDLE_DIR/snapshots"
RECORDING_DIR="$BUNDLE_DIR/recordings"
VIDEO_DIR="$BUNDLE_DIR/videos"
STATUS_TSV="$BUNDLE_DIR/command-status.tsv"

mkdir -p "$LOG_DIR" "$SCREENSHOT_DIR" "$SNAPSHOT_DIR" "$RECORDING_DIR" "$VIDEO_DIR"
find "$LOG_DIR" "$SCREENSHOT_DIR" "$SNAPSHOT_DIR" "$RECORDING_DIR" "$VIDEO_DIR" -mindepth 1 -maxdepth 1 -type f -delete
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

write_snapshot_text() {
  local json_path="$1"
  local output_path="$2"
  node -e "const fs=require('fs'); const value=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); const text=value?.result?.text; if (typeof text !== 'string') { throw new Error('snapshot output did not include result.text'); } fs.writeFileSync(process.argv[2], text + '\n');" "$json_path" "$output_path"
}

copy_screenshot_artifact() {
  local json_path="$1"
  local output_path="$2"
  local source_path
  source_path=$(node -e "const fs=require('fs'); const value=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); const artifactPath=value?.result?.artifactPath; if (typeof artifactPath !== 'string' || artifactPath.length === 0) { throw new Error('screenshot output did not include result.artifactPath'); } process.stdout.write(artifactPath);" "$json_path")
  cp "$source_path" "$output_path"
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

run_json_step '01-doctor' 'npx tsx src/cli/main.ts doctor --json' 'false'
run_json_step '02-version' 'npx tsx src/cli/main.ts version --json' 'false'
run_json_step '03-create' 'npx tsx src/cli/main.ts create --json -- node --import tsx test/fixtures/apps/hello-prompt/main.ts' 'false'

SESSION_ID=$(node -e "const fs=require('fs'); const value=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); const sessionId=value?.result?.sessionId; if (typeof sessionId !== 'string' || sessionId.length === 0) { throw new Error('create output did not include result.sessionId'); } process.stdout.write(sessionId);" "$LOG_DIR/03-create.json")
printf '%s\n' "$SESSION_ID" > "$BUNDLE_DIR/session-id.txt"
sleep 1

run_json_step '04-send-keys' "npx tsx src/cli/main.ts send-keys $SESSION_ID --json Enter" 'false'
run_json_step '05-type' "npx tsx src/cli/main.ts type $SESSION_ID --json \"hello world\"" 'false'
run_json_step '06-paste' "npx tsx src/cli/main.ts paste $SESSION_ID --json \"pasted text\"" 'false'
run_json_step '07-snapshot' "npx tsx src/cli/main.ts snapshot $SESSION_ID --json --format text" 'false'
write_snapshot_text "$LOG_DIR/07-snapshot.json" "$SNAPSHOT_DIR/snapshot-01.txt"
run_json_step '08-screenshot' "npx tsx src/cli/main.ts screenshot $SESSION_ID --json" 'true'
if [ -f "$LOG_DIR/08-screenshot.json" ]; then
  if node -e "const fs=require('fs'); const value=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.exit(value.ok === true ? 0 : 1);" "$LOG_DIR/08-screenshot.json"; then
    copy_screenshot_artifact "$LOG_DIR/08-screenshot.json" "$SCREENSHOT_DIR/screenshot-01.png"
  fi
fi
run_json_step '09-list' 'npx tsx src/cli/main.ts list --json' 'false'
run_json_step '10-inspect' "npx tsx src/cli/main.ts inspect $SESSION_ID --json" 'false'
run_json_step '11-record-export-cast' "npx tsx src/cli/main.ts record export $SESSION_ID --format asciicast --json --out $RECORDING_DIR/recording-01.cast" 'true'
run_json_step '12-record-export-webm' "npx tsx src/cli/main.ts record export $SESSION_ID --format webm --json --out $VIDEO_DIR/video-01.webm" 'true'
run_json_step '13-destroy' "npx tsx src/cli/main.ts destroy $SESSION_ID --json" 'false'
run_json_step '14-list-after-destroy' 'npx tsx src/cli/main.ts list --json' 'false'
