#!/usr/bin/env bash
# Replays the resolve that a Dependabot npm version update runs on this
# checkout: `pnpm update <dep> --lockfile-only` with Dependabot's 7-day
# cooldown as the minimum release age, on copies of package.json,
# pnpm-lock.yaml and pnpm-workspace.yaml, against an empty pnpm store. A
# warm store reuses locked versions and skips pnpm's age and trust checks,
# so only an empty store shows what Dependabot sees. Needs the npm registry.
#
#   .agents/skills/verify-agent-tty/scripts/dependabot-resolve.sh [dep@version ...]
#
# Prints one line per dep and a count line. Exit 0 when every dep resolves,
# 1 when one fails, 2 on a setup error.
set -uo pipefail

repo=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel) || exit 2
pnpm=$(cd "$repo" && { mise which pnpm 2>/dev/null || command -v pnpm; }) || {
  echo "dependabot-resolve.sh: pnpm is not on PATH; run 'mise install' first" >&2
  exit 2
}
[ "$#" -gt 0 ] || set -- commander@latest zod@latest vitest@latest
work=$(mktemp -d "${TMPDIR:-/tmp}/dependabot-resolve-XXXXXX") || exit 2
trap 'rm -rf "$work"' EXIT

failed=0
for dep in "$@"; do
  rm -rf "$work/repo" "$work/store" "$work/cache"
  mkdir "$work/repo"
  cp "$repo/package.json" "$repo/pnpm-lock.yaml" "$repo/pnpm-workspace.yaml" "$work/repo/" || exit 2
  if (cd "$work/repo" && "$pnpm" update "$dep" --lockfile-only \
    --config.minimum-release-age=10080 \
    --store-dir="$work/store" --cache-dir="$work/cache") >"$work/log" 2>&1; then
    echo "ok   $dep"
  else
    failed=$((failed + 1))
    reason=$(grep -m1 -oE 'ERR_PNPM_[A-Z_]+.{0,160}' "$work/log" || tail -n 1 "$work/log")
    echo "FAIL $dep: $reason"
  fi
done
echo "dependabot-resolve: $(($# - failed)) of $# resolved"
[ "$failed" -eq 0 ]
