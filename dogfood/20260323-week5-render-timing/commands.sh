#!/usr/bin/env bash
set -euo pipefail
SESSION_ID="01W5TIMNG1774283448"
npx tsx src/cli/main.ts record export 01W5TIMNG1774283448 --format webm --timing recorded --out dogfood/20260323-week5-render-timing/recordings/recorded.webm --json
npx tsx src/cli/main.ts record export 01W5TIMNG1774283448 --format webm --timing accelerated --out dogfood/20260323-week5-render-timing/recordings/accelerated.webm --json
npx tsx src/cli/main.ts record export 01W5TIMNG1774283448 --format webm --timing max-speed --out dogfood/20260323-week5-render-timing/recordings/max-speed.webm --json
