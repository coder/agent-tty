#!/usr/bin/env bash
export PATH="/usr/local/nvm/versions/node/v22.19.0/bin:/usr/bin:/bin"
export AGENT_TERMINAL_HOME=$(mktemp -d)
# Interactive proof session
node --import tsx ./src/cli/main.ts create --json -- /bin/bash
node --import tsx ./src/cli/main.ts run "$BASH_SESSION_ID" 'echo hello-dogfood' --timeout 15000 --json
node --import tsx ./src/cli/main.ts run "$BASH_SESSION_ID" 'echo async-dogfood' --no-wait --json
node --import tsx ./src/cli/main.ts screenshot "$BASH_SESSION_ID" --json
node --import tsx ./src/cli/main.ts snapshot "$BASH_SESSION_ID" --json
node --import tsx ./src/cli/main.ts record export "$BASH_SESSION_ID" --format asciicast --json
node --import tsx ./src/cli/main.ts record export "$BASH_SESSION_ID" --format webm --json
# Timeout proof session (matches test/integration/run.test.ts)
node --import tsx ./src/cli/main.ts create --json -- /bin/sh -c 'stty -echo; exec sleep 60'
node --import tsx ./src/cli/main.ts run "$TIMEOUT_SESSION_ID" 'echo delayed' --timeout 2000 --json
node --import tsx ./src/cli/main.ts destroy "$TIMEOUT_SESSION_ID" --json
node --import tsx ./src/cli/main.ts destroy "$BASH_SESSION_ID" --json
rm -rf "$AGENT_TERMINAL_HOME"
