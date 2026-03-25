#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
export AGENT_TERMINAL_HOME="/tmp/agent-terminal-week6.N8X5Dz"

npx tsx src/cli/main.ts version --json
npx tsx src/cli/main.ts create --json -- /bin/sh -c 'echo hello; sleep 5'
npx tsx src/cli/main.ts wait 01KMJ2R5VRY4GS10VZ3VNG52Z1 --text hello --timeout 10000 --json
npx tsx src/cli/main.ts inspect 01KMJ2R5VRY4GS10VZ3VNG52Z1 --json
npx tsx src/cli/main.ts wait 01KMJ2R5VRY4GS10VZ3VNG52Z1 --exit --timeout 10000 --json
npx tsx src/cli/main.ts inspect 01KMJ2R5VRY4GS10VZ3VNG52Z1 --json
