#!/usr/bin/env bash
# Prints why dist/ of this checkout is not a complete, current build of src/,
# or nothing when it is. dist/ is stale when a module of src/ has no built
# module, or when a file of src/ is newer than dist/cli/main.js.
#
#   .agents/skills/verify-agent-tty/scripts/stale-dist.sh
set -uo pipefail

cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)" || exit 2
if [ ! -f dist/cli/main.js ]; then
  echo "dist/cli/main.js is missing"
  exit 0
fi
newer=$(find src \( -name '*.ts' -o -name '*.tsx' \) -newer dist/cli/main.js | head -1)
if [ -n "$newer" ]; then
  echo "$newer is newer than dist/cli/main.js"
  exit 0
fi
# A current .tsconfig.build.tsbuildinfo keeps tsc from writing a built module
# that was deleted, so look for each one.
while IFS= read -r module; do
  built=dist/${module#src/}
  built=${built%.ts*}.js
  if [ ! -f "$built" ]; then
    echo "$built is missing"
    exit 0
  fi
done < <(find src \( -name '*.ts' -o -name '*.tsx' \) ! -name '*.d.ts')
