#!/usr/bin/env bash
set -euo pipefail

# Issue 64: Share screenshot capture and artifact persistence.
#
# This script captures four screenshot scenarios:
#
# 1. Live (running session) screenshot, default cursor.
# 2. Live (running session) screenshot, --show-cursor.
# 3. Offline (destroyed session) screenshot, default cursor.
# 4. Offline (destroyed session) screenshot, --show-cursor.
#
# It records each screenshot's JSON envelope, the captured PNG, and the
# session's artifact manifest entry so a reviewer can compare the live and
# offline paths field-by-field. Run twice — once on the refactor branch and
# once on the parent commit — to compare before/after parity:
#
#   bash dogfood/issue-64-share-screenshot-capture/commands.sh refactor
#   bash dogfood/issue-64-share-screenshot-capture/commands.sh main
#
# Each invocation writes to the corresponding sub-directory under the bundle.

BUNDLE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$BUNDLE/../.." && pwd)"
LABEL="${1:-after}"
OUT="$BUNDLE/$LABEL"
mkdir -p "$OUT"

export AGENT_TTY_HOME="$(mktemp -d)"
printf '%s\n' "$AGENT_TTY_HOME" > "$OUT/agent-tty-home.txt"

cd "$REPO"
exec > >(tee "$OUT/transcript.txt") 2>&1
printf 'Running with label: %s\nRepo HEAD: %s\n' "$LABEL" "$(git rev-parse HEAD)"

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
  if [[ -n "${LIVE_SESSION_ID:-}" ]]; then
    npx tsx src/cli/main.ts destroy "$LIVE_SESSION_ID" --json > "$OUT/99-destroy-live.json" || true
  fi
  if [[ -n "${OFFLINE_SESSION_ID:-}" ]]; then
    npx tsx src/cli/main.ts destroy "$OFFLINE_SESSION_ID" --json > "$OUT/98-destroy-offline.json" || true
  fi
  if [[ -n "${AGENT_TTY_HOME:-}" ]]; then
    rm -rf "$AGENT_TTY_HOME"
  fi
}
trap cleanup EXIT

# --- Live session: capture screenshots while it is still running. ---
run_json "$OUT/01-create-live.json" \
  npx tsx src/cli/main.ts create --json --name issue-64-live -- /bin/sh -c 'printf "live screenshot fixture\n"; sleep 60'
LIVE_SESSION_ID="$(json_field "$OUT/01-create-live.json" 'envelope.result.sessionId')"
printf '%s\n' "$LIVE_SESSION_ID" > "$OUT/live-session-id.txt"

# Wait for the prompt to settle so the rendered output is deterministic.
run_json "$OUT/02-wait-live.json" \
  npx tsx src/cli/main.ts wait "$LIVE_SESSION_ID" --text 'live screenshot fixture' --timeout 5000 --json

run_json "$OUT/03-screenshot-live-default.json" \
  npx tsx src/cli/main.ts screenshot "$LIVE_SESSION_ID" --json
LIVE_DEFAULT_PATH="$(json_field "$OUT/03-screenshot-live-default.json" 'envelope.result.artifactPath')"
cp "$LIVE_DEFAULT_PATH" "$OUT/screenshot-live-default.png"

run_json "$OUT/04-screenshot-live-show-cursor.json" \
  npx tsx src/cli/main.ts screenshot "$LIVE_SESSION_ID" --show-cursor --json
LIVE_CURSOR_PATH="$(json_field "$OUT/04-screenshot-live-show-cursor.json" 'envelope.result.artifactPath')"
cp "$LIVE_CURSOR_PATH" "$OUT/screenshot-live-show-cursor.png"

LIVE_SESSION_DIR="$AGENT_TTY_HOME/sessions/$LIVE_SESSION_ID"
cp "$LIVE_SESSION_DIR/artifacts/manifest.json" "$OUT/manifest-live.json"

# --- Offline session: capture screenshots after the session has exited. ---
run_json "$OUT/10-create-offline.json" \
  npx tsx src/cli/main.ts create --json --name issue-64-offline -- /bin/sh -c 'printf "offline screenshot fixture\n"'
OFFLINE_SESSION_ID="$(json_field "$OUT/10-create-offline.json" 'envelope.result.sessionId')"
printf '%s\n' "$OFFLINE_SESSION_ID" > "$OUT/offline-session-id.txt"

# Wait for the short-lived session to exit so subsequent screenshot RPCs
# fall through to the offline replay path.
run_json "$OUT/11-wait-offline.json" \
  npx tsx src/cli/main.ts wait "$OFFLINE_SESSION_ID" --exit --timeout 10000 --json

run_json "$OUT/12-screenshot-offline-default.json" \
  npx tsx src/cli/main.ts screenshot "$OFFLINE_SESSION_ID" --json
OFFLINE_DEFAULT_PATH="$(json_field "$OUT/12-screenshot-offline-default.json" 'envelope.result.artifactPath')"
cp "$OFFLINE_DEFAULT_PATH" "$OUT/screenshot-offline-default.png"

run_json "$OUT/13-screenshot-offline-show-cursor.json" \
  npx tsx src/cli/main.ts screenshot "$OFFLINE_SESSION_ID" --show-cursor --json
OFFLINE_CURSOR_PATH="$(json_field "$OUT/13-screenshot-offline-show-cursor.json" 'envelope.result.artifactPath')"
cp "$OFFLINE_CURSOR_PATH" "$OUT/screenshot-offline-show-cursor.png"

OFFLINE_SESSION_DIR="$AGENT_TTY_HOME/sessions/$OFFLINE_SESSION_ID"
cp "$OFFLINE_SESSION_DIR/artifacts/manifest.json" "$OUT/manifest-offline.json"

# Record SHA-256 sums for quick visual diffing across before/after runs.
{
  printf 'screenshot-live-default.png:\n'
  json_field "$OUT/03-screenshot-live-default.json" 'envelope.result.sha256'
  printf 'screenshot-live-show-cursor.png:\n'
  json_field "$OUT/04-screenshot-live-show-cursor.json" 'envelope.result.sha256'
  printf 'screenshot-offline-default.png:\n'
  json_field "$OUT/12-screenshot-offline-default.json" 'envelope.result.sha256'
  printf 'screenshot-offline-show-cursor.png:\n'
  json_field "$OUT/13-screenshot-offline-show-cursor.json" 'envelope.result.sha256'
} > "$OUT/sha256-summary.txt"
cat "$OUT/sha256-summary.txt"
