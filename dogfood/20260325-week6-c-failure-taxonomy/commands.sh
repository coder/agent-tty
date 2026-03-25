#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
export AGENT_TERMINAL_HOME="/tmp/agent-terminal-week6.N8X5Dz"

npx tsx src/cli/main.ts create --json -- /bin/sh -c 'exit 42'
npx tsx src/cli/main.ts wait 01KMJ2RSD2NWQKAN6NH3TGMSRC --exit --timeout 10000 --json
npx tsx src/cli/main.ts inspect 01KMJ2RSD2NWQKAN6NH3TGMSRC --json
npx tsx src/cli/main.ts create --json -- /bin/sh -c 'exit 0'
npx tsx src/cli/main.ts wait 01KMJ2RXN9F3K4H9366FNZZJ79 --exit --timeout 10000 --json
npx tsx src/cli/main.ts inspect 01KMJ2RXN9F3K4H9366FNZZJ79 --json
npx tsx src/cli/main.ts create --json -- /bin/sh -c 'echo host-death-proof; exec cat'
npx tsx src/cli/main.ts wait 01KMJ2S238K002KNYQWZGCCT3N --text host-death-proof --timeout 10000 --json
npx tsx src/cli/main.ts inspect 01KMJ2S238K002KNYQWZGCCT3N --json
kill -9 831241; sleep 2; printf '{"command":"kill -9 %s","hostPid":%s,"exitCode":0}\n' '831241' '831241'
npx tsx src/cli/main.ts inspect 01KMJ2S238K002KNYQWZGCCT3N --json
