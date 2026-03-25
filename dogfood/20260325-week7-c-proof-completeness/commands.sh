#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
BUNDLE_DIR="dogfood/20260325-week7-c-proof-completeness"
mkdir -p "$BUNDLE_DIR/logs" "$BUNDLE_DIR/screenshots"

touch "$BUNDLE_DIR/screenshots/.gitkeep"
find dogfood -maxdepth 1 -mindepth 1 -type d | sort > "$BUNDLE_DIR/logs/01-bundle-list.txt"
node --input-type=module <<'NODE'
// scan live dogfood bundles and write logs/02-file-counts.tsv, logs/03-artifact-counts.tsv, and logs/04-summary.json
NODE
node --input-type=module <<'NODE'
// render final notes.md, manifest.json, and commands.sh from logs/04-summary.json
NODE
npx tsx src/tools/review-bundle.ts "$BUNDLE_DIR" > "$BUNDLE_DIR/logs/05-review-bundle.txt"
npx prettier --write "$BUNDLE_DIR/" > "$BUNDLE_DIR/logs/06-prettier-write.txt"
npx prettier --check "$BUNDLE_DIR/" > "$BUNDLE_DIR/logs/07-prettier-check.txt"
