#!/usr/bin/env bash
set -u -o pipefail

ROOT_DIR="$(git rev-parse --show-toplevel)"
BUNDLE_DIR="$ROOT_DIR/dogfood/20260326-week9-release-readiness"
LOG_DIR="$BUNDLE_DIR/logs"
SCREENSHOT_DIR="$BUNDLE_DIR/screenshots"
RECORDING_DIR="$BUNDLE_DIR/recordings"
VIDEO_DIR="$BUNDLE_DIR/videos"
SNAPSHOT_DIR="$BUNDLE_DIR/snapshots"
STATUS_FILE="$BUNDLE_DIR/command-status.tsv"
CLI=("$ROOT_DIR/node_modules/.bin/tsx" src/cli/main.ts)
REVIEW=("$ROOT_DIR/node_modules/.bin/tsx" src/tools/review-bundle.ts)
VALIDATE=("$ROOT_DIR/node_modules/.bin/tsx" src/tools/validate-bundle.ts)

mkdir -p "$LOG_DIR" "$SCREENSHOT_DIR" "$RECORDING_DIR" "$VIDEO_DIR" "$SNAPSHOT_DIR"
find "$LOG_DIR" "$SCREENSHOT_DIR" "$RECORDING_DIR" "$VIDEO_DIR" "$SNAPSHOT_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
rm -f "$BUNDLE_DIR"/session-id.txt "$BUNDLE_DIR"/isolated-home.txt "$BUNDLE_DIR"/index.html
printf 'step\tcommand\texit_code\tstatus\n' > "$STATUS_FILE"

record_status() {
  local step="$1"
  local cmd="$2"
  local exit_code="$3"
  local status="$4"
  printf '%s\t%s\t%s\t%s\n' "$step" "$cmd" "$exit_code" "$status" >> "$STATUS_FILE"
}

run_capture() {
  local step="$1"
  local timeout_secs="$2"
  local stdout_path="$3"
  local stderr_path="$4"
  local cmd_text="$5"
  shift 5
  local exit_code=0
  if timeout --preserve-status "${timeout_secs}s" "$@" >"$stdout_path" 2>"$stderr_path"; then
    exit_code=0
  else
    exit_code=$?
  fi
  local status='ok'
  if [[ "$exit_code" -ne 0 ]]; then
    status='failed'
  fi
  record_status "$step" "$cmd_text" "$exit_code" "$status"
  return 0
}

json_field() {
  local file="$1"
  local expr="$2"
  node - "$file" "$expr" <<'NODE'
const fs = require('fs');
const [file, expr] = process.argv.slice(2);
try {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const value = Function('data', `return (${expr});`)(data);
  if (value === undefined || value === null) {
    process.exit(2);
  }
  if (typeof value === 'string') {
    process.stdout.write(value);
  } else {
    process.stdout.write(JSON.stringify(value));
  }
} catch {
  process.exit(1);
}
NODE
}

mark_last_status() {
  local new_status="$1"
  python3 - "$STATUS_FILE" "$new_status" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
new_status = sys.argv[2]
lines = path.read_text().splitlines()
parts = lines[-1].split('\t')
parts[3] = new_status
lines[-1] = '\t'.join(parts)
path.write_text('\n'.join(lines) + '\n')
PY
}

skip_step() {
  local step="$1"
  local cmd="$2"
  record_status "$step" "$cmd" '125' 'skipped'
}

ISOLATED_HOME="$(mktemp -d "${TMPDIR:-/tmp}/agent-terminal-week9-home.XXXXXX")"
printf '%s\n' "$ISOLATED_HOME" > "$BUNDLE_DIR/isolated-home.txt"
SESSION_ID=''

run_capture '01' 120 "$LOG_DIR/01-doctor.json" "$LOG_DIR/01-doctor.stderr.txt" \
  "./node_modules/.bin/tsx src/cli/main.ts doctor --json --home \"$ISOLATED_HOME\"" \
  "${CLI[@]}" doctor --json --home "$ISOLATED_HOME"
if [[ -f "$LOG_DIR/01-doctor.json" ]] && [[ "$(json_field "$LOG_DIR/01-doctor.json" 'data.result?.ok === true' || true)" != 'true' ]]; then
  mark_last_status 'warning'
fi
if [[ -f "$LOG_DIR/01-doctor.json" ]]; then
  cp "$LOG_DIR/01-doctor.json" "$SNAPSHOT_DIR/01-doctor.json"
  record_status '01a' 'cp dogfood/20260326-week9-release-readiness/logs/01-doctor.json dogfood/20260326-week9-release-readiness/snapshots/01-doctor.json' '0' 'ok'
fi

run_capture '02' 60 "$LOG_DIR/02-create.json" "$LOG_DIR/02-create.stderr.txt" \
  "./node_modules/.bin/tsx src/cli/main.ts create --json --home \"$ISOLATED_HOME\" -- /bin/bash" \
  "${CLI[@]}" create --json --home "$ISOLATED_HOME" -- /bin/bash
if [[ -f "$LOG_DIR/02-create.json" ]]; then
  SESSION_ID="$(json_field "$LOG_DIR/02-create.json" 'data.result.sessionId' || true)"
fi
printf '%s\n' "$SESSION_ID" > "$BUNDLE_DIR/session-id.txt"

if [[ -n "$SESSION_ID" ]]; then
  run_capture '03' 60 "$LOG_DIR/03-create-inspect.json" "$LOG_DIR/03-create-inspect.stderr.txt" \
    "./node_modules/.bin/tsx src/cli/main.ts inspect \"$SESSION_ID\" --json --home \"$ISOLATED_HOME\"" \
    "${CLI[@]}" inspect "$SESSION_ID" --json --home "$ISOLATED_HOME"

  run_capture '04' 60 "$LOG_DIR/04-run-echo.json" "$LOG_DIR/04-run-echo.stderr.txt" \
    "./node_modules/.bin/tsx src/cli/main.ts run \"$SESSION_ID\" 'echo \"Week 9 release readiness proof\"' --json --home \"$ISOLATED_HOME\"" \
    "${CLI[@]}" run "$SESSION_ID" 'echo "Week 9 release readiness proof"' --json --home "$ISOLATED_HOME"

  run_capture '05' 60 "$LOG_DIR/05-run-sysinfo.json" "$LOG_DIR/05-run-sysinfo.stderr.txt" \
    "./node_modules/.bin/tsx src/cli/main.ts run \"$SESSION_ID\" 'uname -a && node --version' --json --home \"$ISOLATED_HOME\"" \
    "${CLI[@]}" run "$SESSION_ID" 'uname -a && node --version' --json --home "$ISOLATED_HOME"

  run_capture '06' 30 "$LOG_DIR/06-wait-stable.json" "$LOG_DIR/06-wait-stable.stderr.txt" \
    "./node_modules/.bin/tsx src/cli/main.ts wait \"$SESSION_ID\" --screen-stable-ms 1000 --timeout 5000 --json --home \"$ISOLATED_HOME\"" \
    "${CLI[@]}" wait "$SESSION_ID" --screen-stable-ms 1000 --timeout 5000 --json --home "$ISOLATED_HOME"

  run_capture '07' 120 "$LOG_DIR/07-screenshot.json" "$LOG_DIR/07-screenshot.stderr.txt" \
    "./node_modules/.bin/tsx src/cli/main.ts screenshot \"$SESSION_ID\" --json --home \"$ISOLATED_HOME\"" \
    "${CLI[@]}" screenshot "$SESSION_ID" --json --home "$ISOLATED_HOME"
  SCREENSHOT_PATH="$(json_field "$LOG_DIR/07-screenshot.json" 'data.result.artifactPath' || true)"
  if [[ -n "$SCREENSHOT_PATH" && -f "$SCREENSHOT_PATH" ]]; then
    cp "$SCREENSHOT_PATH" "$SCREENSHOT_DIR/01-after-run.png"
    record_status '07a' 'cp <screenshot artifact> dogfood/20260326-week9-release-readiness/screenshots/01-after-run.png' '0' 'ok'
  else
    record_status '07a' 'cp <screenshot artifact> dogfood/20260326-week9-release-readiness/screenshots/01-after-run.png' '1' 'failed'
  fi

  run_capture '08' 120 "$LOG_DIR/08-snapshot.json" "$LOG_DIR/08-snapshot.stderr.txt" \
    "./node_modules/.bin/tsx src/cli/main.ts snapshot \"$SESSION_ID\" --json --home \"$ISOLATED_HOME\"" \
    "${CLI[@]}" snapshot "$SESSION_ID" --json --home "$ISOLATED_HOME"
  if [[ -f "$LOG_DIR/08-snapshot.json" ]]; then
    cp "$LOG_DIR/08-snapshot.json" "$SNAPSHOT_DIR/02-post-run-structured.json"
    record_status '08a' 'cp dogfood/20260326-week9-release-readiness/logs/08-snapshot.json dogfood/20260326-week9-release-readiness/snapshots/02-post-run-structured.json' '0' 'ok'
  fi

  run_capture '09' 120 "$LOG_DIR/09-export-asciicast.json" "$LOG_DIR/09-export-asciicast.stderr.txt" \
    "./node_modules/.bin/tsx src/cli/main.ts record export \"$SESSION_ID\" --format asciicast --json --home \"$ISOLATED_HOME\"" \
    "${CLI[@]}" record export "$SESSION_ID" --format asciicast --json --home "$ISOLATED_HOME"
  ASCIICAST_PATH="$(json_field "$LOG_DIR/09-export-asciicast.json" 'data.result.artifactPath' || true)"
  if [[ -n "$ASCIICAST_PATH" && -f "$ASCIICAST_PATH" ]]; then
    cp "$ASCIICAST_PATH" "$RECORDING_DIR/week9.cast"
    record_status '09a' 'cp <asciicast artifact> dogfood/20260326-week9-release-readiness/recordings/week9.cast' '0' 'ok'
  else
    record_status '09a' 'cp <asciicast artifact> dogfood/20260326-week9-release-readiness/recordings/week9.cast' '1' 'failed'
  fi

  run_capture '10' 300 "$LOG_DIR/10-export-webm.json" "$LOG_DIR/10-export-webm.stderr.txt" \
    "./node_modules/.bin/tsx src/cli/main.ts record export \"$SESSION_ID\" --format webm --json --home \"$ISOLATED_HOME\"" \
    "${CLI[@]}" record export "$SESSION_ID" --format webm --json --home "$ISOLATED_HOME"
  WEBM_PATH="$(json_field "$LOG_DIR/10-export-webm.json" 'data.result.artifactPath' || true)"
  if [[ -n "$WEBM_PATH" && -f "$WEBM_PATH" ]]; then
    cp "$WEBM_PATH" "$VIDEO_DIR/week9.webm"
    record_status '10a' 'cp <webm artifact> dogfood/20260326-week9-release-readiness/videos/week9.webm' '0' 'ok'
  else
    record_status '10a' 'cp <webm artifact> dogfood/20260326-week9-release-readiness/videos/week9.webm' '1' 'failed'
  fi

  run_capture '11' 60 "$LOG_DIR/11-final-inspect.json" "$LOG_DIR/11-final-inspect.stderr.txt" \
    "./node_modules/.bin/tsx src/cli/main.ts inspect \"$SESSION_ID\" --json --home \"$ISOLATED_HOME\"" \
    "${CLI[@]}" inspect "$SESSION_ID" --json --home "$ISOLATED_HOME"
  if [[ -f "$LOG_DIR/11-final-inspect.json" ]]; then
    cp "$LOG_DIR/11-final-inspect.json" "$SNAPSHOT_DIR/03-final-inspect.json"
    record_status '11a' 'cp dogfood/20260326-week9-release-readiness/logs/11-final-inspect.json dogfood/20260326-week9-release-readiness/snapshots/03-final-inspect.json' '0' 'ok'
  fi

  run_capture '12' 60 "$LOG_DIR/12-destroy.json" "$LOG_DIR/12-destroy.stderr.txt" \
    "./node_modules/.bin/tsx src/cli/main.ts destroy \"$SESSION_ID\" --json --home \"$ISOLATED_HOME\"" \
    "${CLI[@]}" destroy "$SESSION_ID" --json --home "$ISOLATED_HOME"
else
  skip_step '03' 'inspect skipped because create did not return a session ID'
  skip_step '04' 'run echo skipped because create did not return a session ID'
  skip_step '05' 'run sysinfo skipped because create did not return a session ID'
  skip_step '06' 'wait skipped because create did not return a session ID'
  skip_step '07' 'screenshot skipped because create did not return a session ID'
  skip_step '07a' 'copy screenshot skipped because screenshot did not produce an artifact'
  skip_step '08' 'snapshot skipped because create did not return a session ID'
  skip_step '09' 'record export asciicast skipped because create did not return a session ID'
  skip_step '09a' 'copy asciicast skipped because export did not produce an artifact'
  skip_step '10' 'record export webm skipped because create did not return a session ID'
  skip_step '10a' 'copy webm skipped because export did not produce an artifact'
  skip_step '11' 'final inspect skipped because create did not return a session ID'
  skip_step '12' 'destroy skipped because create did not return a session ID'
fi

rm -rf "$ISOLATED_HOME"
record_status '12a' 'rm -rf <isolated home>' '0' 'ok'

run_capture '13' 120 "$LOG_DIR/13-review-bundle.txt" "$LOG_DIR/13-review-bundle.stderr.txt" \
  "./node_modules/.bin/tsx src/tools/review-bundle.ts dogfood/20260326-week9-release-readiness" \
  "${REVIEW[@]}" "$BUNDLE_DIR"

run_capture '14' 120 "$LOG_DIR/14-validate-bundle.txt" "$LOG_DIR/14-validate-bundle.stderr.txt" \
  "./node_modules/.bin/tsx src/tools/validate-bundle.ts dogfood/20260326-week9-release-readiness --profile interactive-renderer" \
  "${VALIDATE[@]}" "$BUNDLE_DIR" --profile interactive-renderer

run_capture '15' 60 "$LOG_DIR/15-reviewer-checks.txt" "$LOG_DIR/15-reviewer-checks.stderr.txt" \
  "./node_modules/.bin/prettier --check dogfood/20260326-week9-release-readiness/manifest.json dogfood/20260326-week9-release-readiness/notes.md && bash -n dogfood/20260326-week9-release-readiness/commands.sh" \
  env PRETTIER="$ROOT_DIR/node_modules/.bin/prettier" MANIFEST="$BUNDLE_DIR/manifest.json" NOTES="$BUNDLE_DIR/notes.md" SCRIPT="$BUNDLE_DIR/commands.sh" bash -lc '$PRETTIER --check "$MANIFEST" "$NOTES" && bash -n "$SCRIPT"'
