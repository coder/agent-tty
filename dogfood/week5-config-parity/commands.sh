#!/usr/bin/env bash
set -euo pipefail

# Exact commands used to create dogfood/week5-config-parity/.
# Note: `npx tsx src/cli/main.ts ...` was blocked in this workspace by tsx's
# interaction with an untrusted local `mise.toml`, so the run used the
# equivalent local loader invocation below instead.

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
