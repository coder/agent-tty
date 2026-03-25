#!/usr/bin/env bash
set -euo pipefail
SESSION_ID="01W5FONTS1774283413"
npx tsx src/cli/main.ts screenshot 01W5FONTS1774283413 --json --profile reference-dark
npx tsx src/cli/main.ts screenshot 01W5FONTS1774283413 --json --profile reference-light
