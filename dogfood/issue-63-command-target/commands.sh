#!/usr/bin/env bash
set -euo pipefail

BUNDLE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$BUNDLE/../.." && pwd)"
export AGENT_TTY_HOME="$(mktemp -d)"
printf '%s\n' "$AGENT_TTY_HOME" > "$BUNDLE/agent-tty-home.txt"

cd "$REPO"
exec > >(tee "$BUNDLE/transcript.txt") 2>&1

run_json() {
  local output="$1"
  shift
  printf '+'
  for argument in "$@"; do
    printf ' %q' "$argument"
  done
  printf '\n'
  "$@" > "$output"
  cat "$output"
  printf '\n'
}

json_field() {
  local file="$1"
  local expression="$2"
  node -e "const fs = require('node:fs'); const envelope = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); console.log($expression);" "$file"
}

cleanup() {
  if [[ -n "${MAIN_SESSION_ID:-}" ]]; then
    npx tsx src/cli/main.ts destroy "$MAIN_SESSION_ID" --json > "$BUNDLE/99-destroy-main.json" || true
  fi
  if [[ -n "${SIGNAL_SESSION_ID:-}" ]]; then
    npx tsx src/cli/main.ts destroy "$SIGNAL_SESSION_ID" --json > "$BUNDLE/98-destroy-signal.json" || true
  fi
  if [[ -n "${AGENT_TTY_HOME:-}" ]]; then
    rm -rf "$AGENT_TTY_HOME"
  fi
}
trap cleanup EXIT

run_json "$BUNDLE/01-create-main.json" \
  npx tsx src/cli/main.ts create --json --name issue-63-command-target -- /bin/bash --noprofile --norc
MAIN_SESSION_ID="$(json_field "$BUNDLE/01-create-main.json" 'envelope.result.sessionId')"
printf '%s\n' "$MAIN_SESSION_ID" > "$BUNDLE/main-session-id.txt"

run_json "$BUNDLE/02-run.json" \
  npx tsx src/cli/main.ts run "$MAIN_SESSION_ID" "printf 'hello issue 63\\n'" --json
run_json "$BUNDLE/03-type.json" \
  npx tsx src/cli/main.ts type "$MAIN_SESSION_ID" "echo typed issue 63" --append-newline --json
run_json "$BUNDLE/04-wait-typed.json" \
  npx tsx src/cli/main.ts wait "$MAIN_SESSION_ID" --text "typed issue 63" --timeout 10000 --json
run_json "$BUNDLE/05-paste.json" \
  npx tsx src/cli/main.ts paste "$MAIN_SESSION_ID" "echo pasted issue 63" --json
run_json "$BUNDLE/06-send-keys.json" \
  npx tsx src/cli/main.ts send-keys "$MAIN_SESSION_ID" Enter --json
run_json "$BUNDLE/07-wait-pasted.json" \
  npx tsx src/cli/main.ts wait "$MAIN_SESSION_ID" --text "pasted issue 63" --timeout 10000 --json
run_json "$BUNDLE/08-mark.json" \
  npx tsx src/cli/main.ts mark "$MAIN_SESSION_ID" issue-63-proof --json
run_json "$BUNDLE/09-resize.json" \
  npx tsx src/cli/main.ts resize "$MAIN_SESSION_ID" --cols 100 --rows 30 --json
run_json "$BUNDLE/10-wait-stable.json" \
  npx tsx src/cli/main.ts wait "$MAIN_SESSION_ID" --screen-stable-ms 300 --timeout 10000 --json

run_json "$BUNDLE/11-create-signal.json" \
  npx tsx src/cli/main.ts create --json --name issue-63-signal -- /bin/sh -c 'trap "echo got-sigusr1" USR1; while :; do sleep 1; done'
SIGNAL_SESSION_ID="$(json_field "$BUNDLE/11-create-signal.json" 'envelope.result.sessionId')"
printf '%s\n' "$SIGNAL_SESSION_ID" > "$BUNDLE/signal-session-id.txt"
run_json "$BUNDLE/12-signal.json" \
  npx tsx src/cli/main.ts signal "$SIGNAL_SESSION_ID" SIGUSR1 --json

run_json "$BUNDLE/13-snapshot-text.json" \
  npx tsx src/cli/main.ts snapshot "$MAIN_SESSION_ID" --format text --json
run_json "$BUNDLE/14-screenshot.json" \
  npx tsx src/cli/main.ts screenshot "$MAIN_SESSION_ID" --hide-cursor --json
SCREENSHOT_PATH="$(json_field "$BUNDLE/14-screenshot.json" 'envelope.result.artifactPath')"
cp "$SCREENSHOT_PATH" "$BUNDLE/screenshot.png"

run_json "$BUNDLE/15-record-asciicast.json" \
  npx tsx src/cli/main.ts record export "$MAIN_SESSION_ID" --format asciicast --out "$BUNDLE/session.cast" --json
run_json "$BUNDLE/16-record-webm.json" \
  npx tsx src/cli/main.ts record export "$MAIN_SESSION_ID" --format webm --timing max-speed --out "$BUNDLE/session.webm" --json

SESSION_DIR="$AGENT_TTY_HOME/sessions/$MAIN_SESSION_ID"
cp "$SESSION_DIR/session.json" "$BUNDLE/main-session-manifest.json"
cp "$SESSION_DIR/events.jsonl" "$BUNDLE/main-session-events.jsonl"

cat > "$BUNDLE/README.md" <<README
# Issue 63 command-target dogfood

This bundle was generated with an isolated \`AGENT_TTY_HOME\` recorded in \`agent-tty-home.txt\`.

## Refactored command-target commands exercised

- \`run\`: \`02-run.json\`
- \`type\`: \`03-type.json\`
- \`paste\`: \`05-paste.json\`
- \`send-keys\`: \`06-send-keys.json\`
- \`mark\`: \`08-mark.json\`
- \`resize\`: \`09-resize.json\`
- \`signal\`: \`12-signal.json\` against a disposable signal session

## Review artifacts

- Command transcript: \`transcript.txt\`
- Text snapshot: \`13-snapshot-text.json\`
- Screenshot JSON: \`14-screenshot.json\`
- Screenshot image: \`screenshot.png\`
- Asciicast export: \`session.cast\` with JSON envelope \`15-record-asciicast.json\`
- WebM export: \`session.webm\` with JSON envelope \`16-record-webm.json\`
- Main session manifest/event log copies: \`main-session-manifest.json\`, \`main-session-events.jsonl\`
README
