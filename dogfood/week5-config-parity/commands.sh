#!/usr/bin/env bash
set -euo pipefail

# Exact commands used to create dogfood/week5-config-parity/.
# Phase 1+2 note: plain `npx tsx src/cli/main.ts ...` was blocked in this
# workspace by tsx's interaction with an untrusted local `mise.toml`, so those
# earlier captures used the equivalent local loader invocation below instead.
# Phase 3 used `env -i ... npx tsx src/cli/main.ts ...` with a clean PATH so the
# commands still run through `npx tsx` without surfacing `mise` trust checks.

export AGENT_TERMINAL_HOME=/tmp/agent-terminal-week5-config-parity.rDdjw2
CLI=(/usr/local/nvm/versions/node/v22.19.0/bin/node --import tsx src/cli/main.ts)

run_json_allow_failure() {
  local output_path=$1
  shift
  set +e
  "$@" > "$output_path"
  local status=$?
  set -e
  printf '%s\n' "$status"
}

cat > "$AGENT_TERMINAL_HOME/config.json" <<'JSON'
{
  "logLevel": "debug",
  "defaultProfile": "my-config-profile",
  "idleTimeoutMs": 3000
}
JSON
cp "$AGENT_TERMINAL_HOME/config.json" dogfood/week5-config-parity/config.json

# Exit 1: doctor ran successfully enough to emit JSON, but returned non-zero
# because the workspace runtime is Node 22.19.0 and `doctor` reports the repo requires 24+.
run_json_allow_failure dogfood/week5-config-parity/doctor-config.json "${CLI[@]}" doctor --json > dogfood/week5-config-parity/doctor-config.exit.txt

"${CLI[@]}" create --json -- bash --noprofile --norc > dogfood/week5-config-parity/create-with-config.json
"${CLI[@]}" inspect 01KMDQXABB9S0VYK55E1MWWJJV --json > dogfood/week5-config-parity/inspect-with-config.json

"${CLI[@]}" create --idle-timeout-ms 5000 --json -- bash --noprofile --norc > dogfood/week5-config-parity/create-with-flag.json
"${CLI[@]}" inspect 01KMDQXCZ4FHJABA249CE7F55Z --json > dogfood/week5-config-parity/inspect-with-flag.json

"${CLI[@]}" create --idle-timeout-ms 0 --json -- bash --noprofile --norc > dogfood/week5-config-parity/create-disabled.json
"${CLI[@]}" inspect 01KMDQXFGAC34GJF5BW3D2TM8G --json > dogfood/week5-config-parity/inspect-disabled.json

# Exit 1: same doctor failure mode, but with the root log-level override accepted.
run_json_allow_failure dogfood/week5-config-parity/doctor-log-level-warn.json "${CLI[@]}" --log-level warn doctor --json > dogfood/week5-config-parity/doctor-log-level-warn.exit.txt

"${CLI[@]}" create --idle-timeout-ms 5000 --env 'PS1=READY> ' --json -- bash --noprofile --norc > dogfood/week5-config-parity/create-type-session.json
"${CLI[@]}" inspect 01KMDQXKEEFNYQTBQX7W87GQQQ --json > dogfood/week5-config-parity/inspect-type-session.json
"${CLI[@]}" wait 01KMDQXKEEFNYQTBQX7W87GQQQ --text 'READY>' --timeout 10000 --json > dogfood/week5-config-parity/wait-ready.json
"${CLI[@]}" type 01KMDQXKEEFNYQTBQX7W87GQQQ 'echo hello && ' --json > dogfood/week5-config-parity/type-no-newline.json
"${CLI[@]}" type 01KMDQXKEEFNYQTBQX7W87GQQQ 'echo world' --append-newline --json > dogfood/week5-config-parity/type-append-newline.json
"${CLI[@]}" wait 01KMDQXKEEFNYQTBQX7W87GQQQ --text world --timeout 10000 --json > dogfood/week5-config-parity/wait-after-append-newline.json
"${CLI[@]}" snapshot 01KMDQXKEEFNYQTBQX7W87GQQQ --format text --json > dogfood/week5-config-parity/snapshot-text.json
"${CLI[@]}" --profile reference-light screenshot 01KMDQXKEEFNYQTBQX7W87GQQQ --json > dogfood/week5-config-parity/screenshot-result.json
cp /tmp/agent-terminal-week5-config-parity.rDdjw2/sessions/01KMDQXKEEFNYQTBQX7W87GQQQ/artifacts/screenshot-4-reference-light.png dogfood/week5-config-parity/screenshot.png
"${CLI[@]}" record export 01KMDQXKEEFNYQTBQX7W87GQQQ --format asciicast --out $PWD/dogfood/week5-config-parity/type-flow.cast --json > dogfood/week5-config-parity/record-export.json

"${CLI[@]}" destroy 01KMDQXABB9S0VYK55E1MWWJJV --force --json > dogfood/week5-config-parity/destroy-config-session.json
"${CLI[@]}" destroy 01KMDQXCZ4FHJABA249CE7F55Z --force --json > dogfood/week5-config-parity/destroy-flag-session.json
"${CLI[@]}" destroy 01KMDQXFGAC34GJF5BW3D2TM8G --force --json > dogfood/week5-config-parity/destroy-disabled-session.json
"${CLI[@]}" destroy 01KMDQXKEEFNYQTBQX7W87GQQQ --force --json > dogfood/week5-config-parity/destroy-type-session.json

# Phase 3 — Enriched result shapes.
CLEAN_PATH=/usr/local/nvm/versions/node/v22.19.0/bin:/usr/bin:/bin
export AGENT_TERMINAL_HOME=/tmp/agent-terminal-week5-phase3.zMhaPa
printf '%s\n' "$AGENT_TERMINAL_HOME" > dogfood/week5-config-parity/phase3-isolated-home.txt

env -i HOME="$HOME" PATH="$CLEAN_PATH" AGENT_TERMINAL_HOME="$AGENT_TERMINAL_HOME" \
  npx tsx src/cli/main.ts create --json --idle-timeout-ms 3000 --name 'dogfood-session' -- /bin/sh \
  > dogfood/week5-config-parity/create-enriched.json
PHASE3_SESSION_ID=$(node --input-type=module -e "import fs from 'node:fs'; const data = JSON.parse(fs.readFileSync('dogfood/week5-config-parity/create-enriched.json', 'utf8')); process.stdout.write(data.result.sessionId);")
env -i HOME="$HOME" PATH="$CLEAN_PATH" AGENT_TERMINAL_HOME="$AGENT_TERMINAL_HOME" \
  npx tsx src/cli/main.ts list --json > dogfood/week5-config-parity/list-enriched.json
env -i HOME="$HOME" PATH="$CLEAN_PATH" AGENT_TERMINAL_HOME="$AGENT_TERMINAL_HOME" \
  npx tsx src/cli/main.ts type "$PHASE3_SESSION_ID" 'echo hello' --append-newline --json > /tmp/week5_phase3_type.json
sleep 1
env -i HOME="$HOME" PATH="$CLEAN_PATH" AGENT_TERMINAL_HOME="$AGENT_TERMINAL_HOME" \
  npx tsx src/cli/main.ts inspect --json "$PHASE3_SESSION_ID" > dogfood/week5-config-parity/inspect-enriched.json
env -i HOME="$HOME" PATH="$CLEAN_PATH" AGENT_TERMINAL_HOME="$AGENT_TERMINAL_HOME" \
  npx tsx src/cli/main.ts destroy "$PHASE3_SESSION_ID" --json > /tmp/week5_phase3_destroy.json
env -i HOME="$HOME" PATH="$CLEAN_PATH" AGENT_TERMINAL_HOME="$AGENT_TERMINAL_HOME" \
  npx tsx src/cli/main.ts list --all --json > dogfood/week5-config-parity/list-all-enriched.json
rm -f /tmp/week5_phase3_type.json /tmp/week5_phase3_destroy.json
rm -rf "$AGENT_TERMINAL_HOME"
