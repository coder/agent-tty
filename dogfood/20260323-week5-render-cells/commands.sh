#!/usr/bin/env bash
set -euo pipefail
SESSION_ID="01W5CELLS1774283515"
npx tsx src/cli/main.ts snapshot 01W5CELLS1774283515 --include-cells --json
npx tsx src/cli/main.ts snapshot 01W5CELLS1774283515 --json
