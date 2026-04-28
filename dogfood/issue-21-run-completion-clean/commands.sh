#!/usr/bin/env bash
# Reproduce the issue-21 run-completion-clean dogfood bundle.
# All paths use an isolated AGENT_TTY_HOME under /tmp; nothing writes to ~/.agent-tty.
set -euo pipefail

DOGFOOD_HOME=$(mktemp -d -t agent-tty-issue21-dogfood-XXXXXX)
ARTIFACTS_DIR="$(pwd)/dogfood/issue-21-run-completion-clean"
mkdir -p "$ARTIFACTS_DIR"

CLI=(npx tsx src/cli/main.ts --home "$DOGFOOD_HOME")

# 1. Create an interactive bash session
"${CLI[@]}" create --json -- bash --noprofile --norc \
  | tee "$ARTIFACTS_DIR/01-create.json"
SESSION_ID=$(jq -r '.result.sessionId' "$ARTIFACTS_DIR/01-create.json")

# 2. Run a waited command with recognizable user output
"${CLI[@]}" run --json --timeout 10000 "$SESSION_ID" \
  'printf "before-clean-marker-proof\n"; sleep 0.2; printf "after-clean-marker-proof\n"' \
  | tee "$ARTIFACTS_DIR/02-run.json"

# 3. Capture artifacts
"${CLI[@]}" snapshot --json "$SESSION_ID"   > "$ARTIFACTS_DIR/03-snapshot.json"
"${CLI[@]}" screenshot --json "$SESSION_ID" > "$ARTIFACTS_DIR/04-screenshot.json"
cp "$(jq -r '.result.artifactPath' "$ARTIFACTS_DIR/04-screenshot.json")" \
   "$ARTIFACTS_DIR/04-screenshot.png"
"${CLI[@]}" record export --json "$SESSION_ID" --format asciicast \
  --out "$ARTIFACTS_DIR/05-recording.cast" > "$ARTIFACTS_DIR/05-asciicast.json"
"${CLI[@]}" record export --json "$SESSION_ID" --format webm --timing accelerated \
  --out "$ARTIFACTS_DIR/06-recording.webm" > "$ARTIFACTS_DIR/06-webm.json"

# 4. Copy the canonical event log for cleanliness inspection
cp "$DOGFOOD_HOME/sessions/$SESSION_ID/events.jsonl" "$ARTIFACTS_DIR/07-events.jsonl"

# 5. Tear down
"${CLI[@]}" destroy --json "$SESSION_ID" > "$ARTIFACTS_DIR/08-destroy.json"
rm -rf "$DOGFOOD_HOME"
