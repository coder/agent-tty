# Phase 5 token-usage proof bundle

This bundle captures a focused `agent-tty` validation run for the Phase 5 token-usage work. It provides reviewer-visible proof for these commits:

- `7beaa84` — `feat(evals): add optional token usage to normalized output`
- `202244b` — `feat(evals): normalize token usage in claude and codex providers`
- `e9828d5` — `feat(evals): support deterministic token usage in fixtures provider`

The current repo-local CLI uses `create` / `destroy` rather than `session start` / `session destroy`; recording export is available for created sessions, so there is no separate `--record` flag in this workspace's `--help` output.

## Artifacts

- Snapshot: `dogfood/token-usage-phase5-proof/snapshot.txt`
- Screenshot: `dogfood/token-usage-phase5-proof/screenshot.png`
- Recording: `dogfood/token-usage-phase5-proof/recording.webm`
- Replay script: `dogfood/token-usage-phase5-proof/commands.sh`

## Exact command list used

The executable replay script is `dogfood/token-usage-phase5-proof/commands.sh`. The exact command sequence it ran was:

```bash
ROOT_DIR="$(git rev-parse --show-toplevel)"
BUNDLE_DIR="$ROOT_DIR/dogfood/token-usage-phase5-proof"
export AGENT_TTY_HOME="$(mktemp -d "$BUNDLE_DIR/.home.XXXXXX")"

npx tsx src/cli/main.ts --help
npx tsx src/cli/main.ts doctor --json
CREATE_JSON="$(npx tsx src/cli/main.ts create --json --cwd "$ROOT_DIR" --cols 140 --rows 45 --env 'PS1=phase5-proof$ ' -- /bin/bash --noprofile --norc -i)"
SESSION_ID="$(printf '%s\n' "$CREATE_JSON" | jq -er '.result.sessionId')"

npx tsx src/cli/main.ts wait "$SESSION_ID" --screen-stable-ms 500 --timeout 10000 --json
npx tsx src/cli/main.ts run "$SESSION_ID" 'npm run typecheck' --timeout 300000 --json
npx tsx src/cli/main.ts run "$SESSION_ID" 'npm run lint' --timeout 300000 --json
npx tsx src/cli/main.ts run "$SESSION_ID" 'npx vitest run test/unit/evals/claude.test.ts test/unit/evals/codex.test.ts test/unit/evals/promptRunner.test.ts test/integration/evals/authoring-pilots.test.ts --reporter=verbose' --timeout 300000 --json
npx tsx src/cli/main.ts wait "$SESSION_ID" --screen-stable-ms 1500 --timeout 10000 --json

SNAPSHOT_JSON="$(npx tsx src/cli/main.ts snapshot "$SESSION_ID" --format text --include-scrollback --json)"
printf '%s\n' "$SNAPSHOT_JSON" | jq -er '.result.text' > "$BUNDLE_DIR/snapshot.txt"

SCREENSHOT_JSON="$(npx tsx src/cli/main.ts screenshot "$SESSION_ID" --json)"
SCREENSHOT_PATH="$(printf '%s\n' "$SCREENSHOT_JSON" | jq -er '.result.artifactPath')"
cp "$SCREENSHOT_PATH" "$BUNDLE_DIR/screenshot.png"

npx tsx src/cli/main.ts record export "$SESSION_ID" --format webm --out "$BUNDLE_DIR/recording.webm" --json
npx tsx src/cli/main.ts destroy "$SESSION_ID" --json
rm -rf "$AGENT_TTY_HOME"
```

## What to verify

Open `screenshot.png` to confirm the terminal finished on a green focused validation run, play `recording.webm` to confirm the full `agent-tty` session covers `typecheck`, `lint`, and the verbose Vitest command end to end, and inspect `snapshot.txt` to confirm the scrollback includes the 27-test success summary plus the token-usage-specific test names from `claude.test.ts`, `codex.test.ts`, and `authoring-pilots.test.ts`.
