# agent-terminal v1 week 3 status

This document records the work that landed after the Week 2 renderer-backed inspection slice.

Unlike Week 1 and Week 2, Week 3 was delivered through proof bundles and follow-on implementation work rather than a formal plan doc written in advance. This file exists to close that documentation gap and describe the repository's actual shipped state.

## Status update (2026-03-22)

Week 3 is implemented.

What Week 3 added on top of the Week 2 renderer slice:

- `record export --format asciicast`,
- `record export --format webm`,
- post-exit replay for snapshot, screenshot, and recording export,
- crash-retention proof that evidence survives abnormal process exit,
- `gc` for removing exited / stale sessions,
- and stronger artifact manifests that now include `recording` and `video` entries.

## Week 3 outcome checklist

- [x] Asciicast export is implemented.
- [x] WebM export is implemented.
- [x] Export works on running sessions.
- [x] Export works after the session has exited.
- [x] Post-exit snapshot and screenshot replay works.
- [x] Crash-retention proof bundles exist.
- [x] `gc` is implemented with dry-run and removal flows.
- [x] Integration and e2e coverage exists for the export / retention flows.

## Source-of-truth implementation areas

Week 3 is primarily implemented in:

- `src/export/asciicast.ts`
- `src/export/webm.ts`
- `src/cli/commands/record-export.ts`
- `src/cli/commands/gc.ts`
- `src/storage/artifactManifest.ts`
- `src/replay/offlineReplay.ts`

Key verification coverage lives in:

- `test/integration/record-export.test.ts`
- `test/e2e/export-fixtures.test.ts`
- `test/integration/gc.test.ts`
- `test/unit/export/asciicast.test.ts`
- `test/unit/export/webm.test.ts`
- `test/unit/commands/gc.test.ts`

## Week 3 proof bundles

The strongest Week 3 proof lives under `dogfood/`:

### `dogfood/20260321-week3-renderer-complete/`

This bundle proves:

- live renderer waits,
- live snapshots,
- live screenshots,
- live asciicast export,
- post-exit snapshot replay,
- post-exit screenshot replay,
- post-exit WebM export,
- and a GC sub-demo.

### `dogfood/20260321-week3-crash-retention/`

This bundle proves:

- the session remains inspectable after abnormal exit,
- offline replay still works after the crash,
- post-crash screenshot and snapshot capture still work,
- and both asciicast and WebM export remain available after the crash.

## What Week 3 did **not** try to finish

Week 3 did not attempt to close every remaining design gap.

The major open items after Week 3 are still:

- CLI contract parity,
- richer snapshot / screenshot fidelity,
- better failure-state modeling,
- the missing `unicode-grid` and `scrollback-demo` fixtures,
- and broader dogfooding / platform hardening.

Those are now tracked as Week 4 work rather than Week 3 carry-over.

## Relationship to Week 4

With Week 3 shipped, the project is no longer missing the export story from the original design. The next milestone should focus on design parity and hardening instead of a brand-new feature family.

See [09-week-4-plan.md](./09-week-4-plan.md) for the proposed next milestone.
