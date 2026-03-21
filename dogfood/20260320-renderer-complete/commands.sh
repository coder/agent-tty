#!/usr/bin/env bash
# Reference only: exact command sequence used to produce this bundle.
# This is intentionally documentation, not an executable harness.

set -euo pipefail

export AGENT_TERMINAL_HOME="$(mktemp -d)"
CLI=(node --import tsx ./src/cli/main.ts)
BUNDLE="dogfood/20260320-renderer-complete"
SCENARIO_SCRIPT='printf "Loading\n"; sleep 1; printf "3 items\n"; sleep 1; printf "Ready\n"; exec cat'

CREATE_OUTPUT="$(${CLI[@]} create --json -- /bin/sh -c "$SCENARIO_SCRIPT")"
printf '%s\n' "$CREATE_OUTPUT" > "$BUNDLE/create-output.json"

SESSION_ID="$({ printf '%s' "$CREATE_OUTPUT" | node -e 'let data=""; process.stdin.on("data", (chunk) => { data += chunk; }); process.stdin.on("end", () => { process.stdout.write(JSON.parse(data).result.sessionId); });'; })"

${CLI[@]} wait "$SESSION_ID" --text Ready --timeout 15000 --json > "$BUNDLE/wait-text.json"
${CLI[@]} type "$SESSION_ID" "typed from dogfood" --json > "$BUNDLE/type-output.json"
${CLI[@]} wait "$SESSION_ID" --regex 'typed.+dogfood' --timeout 15000 --json > "$BUNDLE/wait-regex.json"
${CLI[@]} snapshot "$SESSION_ID" --format structured --json > "$BUNDLE/snapshot-structured.json"
${CLI[@]} snapshot "$SESSION_ID" --format text --json > "$BUNDLE/snapshot-text.json"
${CLI[@]} screenshot "$SESSION_ID" --json > "$BUNDLE/screenshot-dark.json"
${CLI[@]} screenshot "$SESSION_ID" --profile reference-light --json > "$BUNDLE/screenshot-light.json"
${CLI[@]} doctor --json > "$BUNDLE/doctor.json"

# Read the generated artifact manifest from:
#   "$AGENT_TERMINAL_HOME/sessions/$SESSION_ID/artifacts/manifest.json"
# and save the tracked-artifact excerpt as:
#   "$BUNDLE/manifest-excerpt.json"

${CLI[@]} destroy "$SESSION_ID" --force --json > "$BUNDLE/destroy-output.json"
