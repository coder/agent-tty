#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
export AGENT_TERMINAL_HOME="/tmp/agent-terminal-week6.N8X5Dz"

npx tsx src/cli/main.ts create --json -- node --import tsx test/fixtures/apps/color-grid/main.ts
npx tsx src/cli/main.ts wait 01KMJ2RDHRZPYTZQW4WJH2717B --exit --timeout 10000 --json
npx tsx src/cli/main.ts screenshot 01KMJ2RDHRZPYTZQW4WJH2717B --json
npx tsx src/cli/main.ts inspect 01KMJ2RDHRZPYTZQW4WJH2717B --json
rm -f /tmp/agent-terminal-week6.N8X5Dz/sessions/01KMJ2RDHRZPYTZQW4WJH2717B/artifacts/screenshot-1-reference-dark.png
npx tsx src/cli/main.ts inspect 01KMJ2RDHRZPYTZQW4WJH2717B --json
