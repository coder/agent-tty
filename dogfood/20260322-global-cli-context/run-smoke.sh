#!/usr/bin/env bash
set -euo pipefail

DOGFOOD_DIR=${DOGFOOD_DIR:?}
CLI=(node --import tsx ./src/cli/main.ts)
ENV_HOME=$(mktemp -d)
OVERRIDE_HOME=$(mktemp -d)
SESSION_ID=''
trap 'if [ -n "$SESSION_ID" ]; then AGENT_TERMINAL_HOME="$OVERRIDE_HOME" "${CLI[@]}" destroy "$SESSION_ID" --force --json >/dev/null 2>&1 || true; fi; rm -rf "$ENV_HOME" "$OVERRIDE_HOME"' EXIT

printf '$ %q ' "${CLI[@]}"
printf -- '--no-color version\n'
"${CLI[@]}" --no-color version
printf '\n'

printf '$ AGENT_TERMINAL_HOME=%q ' "$ENV_HOME"
printf '%q ' "${CLI[@]}"
printf -- '--home %q create --json -- /bin/sh -c %q\n' "$OVERRIDE_HOME" 'exec cat'
AGENT_TERMINAL_HOME="$ENV_HOME" "${CLI[@]}" --home "$OVERRIDE_HOME" create --json -- /bin/sh -c 'exec cat' | tee "$DOGFOOD_DIR/create.json"
SESSION_ID=$(node -e "const fs=require('fs');process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],'utf8')).result.sessionId)" "$DOGFOOD_DIR/create.json")
printf 'Created session: %s\n\n' "$SESSION_ID"

printf '$ AGENT_TERMINAL_HOME=%q ' "$ENV_HOME"
printf '%q ' "${CLI[@]}"
printf -- '--home %q inspect %q\n' "$OVERRIDE_HOME" "$SESSION_ID"
AGENT_TERMINAL_HOME="$ENV_HOME" "${CLI[@]}" --home "$OVERRIDE_HOME" inspect "$SESSION_ID"
printf '\n'

printf '$ AGENT_TERMINAL_HOME=%q ' "$ENV_HOME"
printf '%q ' "${CLI[@]}"
printf -- '--home %q list\n' "$OVERRIDE_HOME"
AGENT_TERMINAL_HOME="$ENV_HOME" "${CLI[@]}" --home "$OVERRIDE_HOME" list
printf '\n'

printf '$ AGENT_TERMINAL_HOME=%q ' "$ENV_HOME"
printf '%q ' "${CLI[@]}"
printf -- 'inspect missing-session --json; echo EXIT:$?\n'
set +e
AGENT_TERMINAL_HOME="$ENV_HOME" "${CLI[@]}" inspect missing-session --json
STATUS=$?
set -e
printf 'EXIT:%s\n\n' "$STATUS"

printf '$ AGENT_TERMINAL_HOME=%q ' "$ENV_HOME"
printf '%q ' "${CLI[@]}"
printf -- '--home %q destroy %q --force --json\n' "$OVERRIDE_HOME" "$SESSION_ID"
AGENT_TERMINAL_HOME="$ENV_HOME" "${CLI[@]}" --home "$OVERRIDE_HOME" destroy "$SESSION_ID" --force --json
printf '\n'

cat <<SUMMARY > "$DOGFOOD_DIR/summary.txt"
version: ok
create_home_override: $OVERRIDE_HOME
create_env_home: $ENV_HOME
session_id: $SESSION_ID
missing_session_exit: $STATUS
SUMMARY
