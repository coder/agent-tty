#!/usr/bin/env bash
set -euo pipefail
export AGENT_TERMINAL_HOME="$(mktemp -d)"
CLI=(node --import tsx ./src/cli/main.ts)
SCENARIO_SCRIPT='printf "Loading\n"; sleep 1; printf "3 items\n"; sleep 1; printf "Ready\n"; exec cat'
CREATE_OUTPUT="$(${CLI[@]} create --json -- /bin/sh -c "$SCENARIO_SCRIPT")"
SESSION_ID="$({ printf '%s' "$CREATE_OUTPUT" | node -e 'let data=""; process.stdin.on("data", (chunk) => data += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(data).result.sessionId));'; })"
${CLI[@]} inspect "$SESSION_ID" --json
${CLI[@]} wait "$SESSION_ID" --text Ready --screen-stable-ms 500 --timeout 20000 --json
${CLI[@]} type "$SESSION_ID" "typed from post-hardening dogfood" --json
${CLI[@]} wait "$SESSION_ID" --regex 'typed.+dogfood' --timeout 20000 --json
${CLI[@]} snapshot "$SESSION_ID" --format structured --json
${CLI[@]} snapshot "$SESSION_ID" --format text --json
${CLI[@]} screenshot "$SESSION_ID" --json
${CLI[@]} screenshot "$SESSION_ID" --profile reference-light --json
${CLI[@]} doctor --json
${CLI[@]} destroy "$SESSION_ID" --force --json
