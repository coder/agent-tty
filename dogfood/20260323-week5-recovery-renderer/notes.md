# 2026-03-23 dogfood — Week 5 renderer recovery

## Bundle metadata

- **Date:** 2026-03-23
- **Bundle path:** `dogfood/20260323-week5-recovery-renderer/`
- **Approach:** targeted integration proof plus a simplified live CLI A/B capture using two isolated sessions with the same command.
- **Authoritative proof:** `logs/01-vitest-renderer-recovery.log`

## Simplified proof approach

The authoritative integration test at `test/integration/renderer-backend.test.ts:304-369` boots a renderer backend, replays `hello from renderer`, captures screenshot/snapshot A, calls `dispose()`, calls `boot()` again, replays the same input, captures screenshot/snapshot B, and asserts the recovered state matches.

This bundle adds a simplified live CLI proof by creating two fresh sessions that run the same command, waiting for `hello from renderer`, and then capturing one screenshot and one text snapshot per session. That does **not** exercise the internal `dispose()` + `boot()` path directly; instead, it demonstrates that the CLI-facing renderer output is consistent across equivalent before/after runs, while the unchanged vitest log remains the source of truth for the actual restart behavior.

## Artifact references

- Screenshots:
  - `screenshots/01-renderer-session-a.png`
  - `screenshots/02-renderer-session-b.png`
- Snapshots:
  - `snapshots/01-renderer-session-a.json`
  - `snapshots/02-renderer-session-b.json`
- Targeted test log:
  - `logs/01-vitest-renderer-recovery.log`

## Observations

- **Vitest result:** exit code `0`.
- **CLI proof status:** completed successfully.
- **Screenshot comparison:** `identical-bytes` (A sha256 `4c04d7269673a0214985d9c295a26b82ab0af0d24bb3198208de0994f3d95091`, B sha256 `4c04d7269673a0214985d9c295a26b82ab0af0d24bb3198208de0994f3d95091`)
- **Snapshot comparison:** `identical-bytes` (A sha256 `6a0600e332ccc1a78b6482ea64d3f2c486bb7822af4721b3b30cc865b347dfb2`, B sha256 `6a0600e332ccc1a78b6482ea64d3f2c486bb7822af4721b3b30cc865b347dfb2`)

## Interpretation

The simplified CLI proof produced byte-identical screenshots and byte-identical normalized text snapshots for the before/after session pair, which gives a reviewer-friendly visible-state check. The vitest log is still the authoritative proof that renderer state survives the actual internal `dispose()` + `boot()` cycle.

## Command results

See `command-status.tsv` for the full command list, output files, and exit codes.
