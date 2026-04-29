# Oxlint/Oxfmt migration proof

Date: 2026-04-29

This bundle proves the migrated lint/format developer workflow through an isolated `agent-tty` session.

## Environment

- Isolated `AGENT_TTY_HOME`: see `agent-tty-home.txt`.
- Session id: see `session-id.txt`.
- Local command path: `npx tsx src/cli/main.ts --home "$AGENT_TTY_HOME" ...`.

## Commands run in the recorded session

See `commands.sh` for the exact replayable command list:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run build
npm run smoke:install -- --skip-build
echo "OXC_MIGRATION_DOGFOOD_DONE"
```

The full repository test suite was run locally and by PR CI outside the dogfood session. The recorded dogfood session intentionally keeps to the shorter static, build, and install-smoke checks so the screenshot and recordings stay small and reviewable.

## Timing summary

Baseline before migration:

- `npm run format:check`: 6.9s wall time.
- `npm run lint`: 9.0s wall time.

After migration:

- `npm run format:check`: 1.5s, 1.4s, 1.5s wall-time samples.
- `npm run lint`: 1.0s, 1.1s, 1.0s wall-time samples.

## Proof artifacts

- Semantic snapshot: `artifacts/snapshot.txt`.
- Screenshot: `artifacts/validation-screenshot.png`.
- Asciicast recording: `artifacts/validation.cast`.
- WebM recording: `artifacts/validation.webm`.
- Safety-rule parity evidence: `logs/safety-parity.txt`.
- JSON command logs: `logs/*.json`.

The snapshot and recordings end with `OXC_MIGRATION_DOGFOOD_DONE` after the migrated checks pass.
