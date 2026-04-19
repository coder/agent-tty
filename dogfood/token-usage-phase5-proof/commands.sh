#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel)"
BUNDLE_DIR="$ROOT_DIR/dogfood/token-usage-phase5-proof"
mkdir -p "$BUNDLE_DIR"
rm -f "$BUNDLE_DIR/snapshot.txt" "$BUNDLE_DIR/screenshot.png" "$BUNDLE_DIR/recording.webm"

export AGENT_TTY_HOME="$(mktemp -d "$BUNDLE_DIR/.home.XXXXXX")"
SESSION_ID=''

cleanup() {
  if [[ -n "$SESSION_ID" ]]; then
    npx tsx src/cli/main.ts destroy "$SESSION_ID" --json >/dev/null 2>&1 || true
  fi
  if [[ -n "${AGENT_TTY_HOME:-}" && -d "${AGENT_TTY_HOME:-}" ]]; then
    rm -rf "$AGENT_TTY_HOME"
  fi
}
trap cleanup EXIT

cd "$ROOT_DIR"

npx tsx src/cli/main.ts --help >/dev/null
npx tsx src/cli/main.ts doctor --json | jq -e '.ok == true and .result.ok == true' >/dev/null

CREATE_JSON="$(npx tsx src/cli/main.ts create --json --cwd "$ROOT_DIR" --cols 140 --rows 45 --env 'PS1=phase5-proof$ ' -- /bin/bash --noprofile --norc -i)"
SESSION_ID="$(printf '%s\n' "$CREATE_JSON" | jq -er '.result.sessionId')"

npx tsx src/cli/main.ts wait "$SESSION_ID" --screen-stable-ms 500 --timeout 10000 --json | jq -e '.ok == true and .result.timedOut == false' >/dev/null

TYPECHECK_JSON="$(npx tsx src/cli/main.ts run "$SESSION_ID" 'npm run typecheck' --timeout 300000 --json)"
printf '%s\n' "$TYPECHECK_JSON" | jq -e '.ok == true and .result.accepted == true and .result.completed == true and (.result.timedOut // false) == false' >/dev/null

LINT_JSON="$(npx tsx src/cli/main.ts run "$SESSION_ID" 'npm run lint' --timeout 300000 --json)"
printf '%s\n' "$LINT_JSON" | jq -e '.ok == true and .result.accepted == true and .result.completed == true and (.result.timedOut // false) == false' >/dev/null

VITEST_COMMAND='npx vitest run test/unit/evals/claude.test.ts test/unit/evals/codex.test.ts test/unit/evals/promptRunner.test.ts test/integration/evals/authoring-pilots.test.ts --reporter=verbose'
VITEST_JSON="$(npx tsx src/cli/main.ts run "$SESSION_ID" "$VITEST_COMMAND" --timeout 300000 --json)"
printf '%s\n' "$VITEST_JSON" | jq -e '.ok == true and .result.accepted == true and .result.completed == true and (.result.timedOut // false) == false' >/dev/null

npx tsx src/cli/main.ts wait "$SESSION_ID" --screen-stable-ms 1500 --timeout 10000 --json | jq -e '.ok == true and .result.timedOut == false' >/dev/null

SNAPSHOT_JSON="$(npx tsx src/cli/main.ts snapshot "$SESSION_ID" --format text --include-scrollback --json)"
printf '%s\n' "$SNAPSHOT_JSON" | jq -er '.result.text' > "$BUNDLE_DIR/snapshot.txt"

SCREENSHOT_JSON="$(npx tsx src/cli/main.ts screenshot "$SESSION_ID" --json)"
SCREENSHOT_PATH="$(printf '%s\n' "$SCREENSHOT_JSON" | jq -er '.result.artifactPath')"
cp "$SCREENSHOT_PATH" "$BUNDLE_DIR/screenshot.png"

npx tsx src/cli/main.ts record export "$SESSION_ID" --format webm --out "$BUNDLE_DIR/recording.webm" --json | jq -e '.ok == true and .result.format == "webm"' >/dev/null
npx tsx src/cli/main.ts destroy "$SESSION_ID" --json | jq -e '.ok == true' >/dev/null
SESSION_ID=''

trap - EXIT
rm -rf "$AGENT_TTY_HOME"
unset AGENT_TTY_HOME
