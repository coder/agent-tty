#!/usr/bin/env bash
set -euo pipefail
SESSION_ID="01W5CURSR1774283429"
npx tsx src/cli/main.ts screenshot 01W5CURSR1774283429 --show-cursor --json
npx tsx src/cli/main.ts screenshot 01W5CURSR1774283429 --hide-cursor --json
npx tsx src/cli/main.ts screenshot 01W5CURSR1774283429 --json
