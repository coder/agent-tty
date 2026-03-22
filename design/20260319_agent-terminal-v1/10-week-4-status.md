# agent-terminal v1 week 4 status

This document records the repository's actual Week 4 outcome after the plan in [09-week-4-plan.md](./09-week-4-plan.md).

Week 4 materially closed the CLI-contract, artifact-metadata, and lifecycle gaps that were still open after Week 3. Fixture/dogfood completion was only partial, so this file separates what shipped from what remains follow-up work.

## Status update (2026-03-22)

Week 4 core implementation is shipped.

What landed on top of Week 3:

- shared global CLI context with `--home`, `--timeout-ms`, and `--no-color`,
- differentiated process exit codes `0` through `8`,
- `create` parity for `--env`, `--term`, `--name`, and `--shell`,
- file-backed input for `type` / `paste`,
- renderer-backed cursor-position waits,
- scrollback-aware snapshots,
- richer screenshot / export metadata plus render-profile hashing,
- and a six-state lifecycle model with explicit failure tracking.

What did **not** fully land in Week 4:

- the planned `unicode-grid` and `scrollback-demo` fixtures,
- dedicated Week 4 unicode/scrollback proof bundles,
- config-file and log-level parity,
- bundled deterministic font assets,
- and the fuller snapshot styling/timing contract sketched in the design docs.

## Week 4 outcome by workstream

### WS1 — CLI contract alignment

Shipped:

- global root flags `--home`, `--timeout-ms`, and `--no-color`,
- shared command-context resolution instead of per-command home/timeout plumbing,
- exit-code mapping aligned to the design doc's `0`-through-`8` recommendations,
- `create` options `--env`, `--term`, `--name`, and `--shell`,
- file-backed `type` / `paste` input via `--file`,
- and renderer waits for `--cursor-row` / `--cursor-col`.

Still open:

- `--log-level`,
- a true global `--profile` override surface,
- `--idle-timeout-ms`,
- `--append-newline`,
- config-file loading,
- and full result-shape parity with every CLI-contract example.

### WS2 — Rendering and artifact fidelity

Shipped:

- `snapshot --include-scrollback` plus RPC-level `includeScrollback`,
- snapshot artifact metadata that now records renderer backend and optional scrollback counts,
- screenshot metadata enrichment (`rendererBackend`, `pixelWidth`, `pixelHeight`, `sha256`, `renderProfileHash`),
- canonical render-profile hashing via `hashProfile(...)`,
- richer asciicast export metadata,
- and richer WebM export metadata with render-profile linkage.

Still open:

- per-cell styling data,
- the broader `SnapshotCell` contract from the design doc,
- a bundled deterministic font asset,
- and fuller replay-timing controls at the CLI/design-contract level.

### WS3 — Failure semantics and recovery

Shipped:

- six session states: `running`, `exiting`, `exited`, `failed`, `destroying`, and `destroyed`,
- `failureReason` on session records,
- reconciliation that marks stale `running` sessions as `failed` instead of collapsing them to `exited`,
- explicit destroyed-session guards across CLI mutation commands,
- and GC support for `exited`, `failed`, and `destroyed` terminal states.

Still open:

- dedicated renderer-recovery proof beyond the event-log/offline-replay path,
- broader user-facing distinction between child failure and host failure,
- and more polished failure-focused dogfood bundles generated after the new lifecycle model landed.

### WS4 — Fixture and dogfooding completion

Shipped:

- `dogfood/20260321-post-hardening-smoke/`,
- `dogfood/20260321-week3-renderer-complete/`,
- `dogfood/20260321-week3-crash-retention/`,
- `dogfood/20260322-global-cli-context/`,
- and the broader real-world smoke bundle `dogfood/20260322-lazyvim-scenario/`.

Still open:

- `test/fixtures/apps/unicode-grid/`,
- `test/fixtures/apps/scrollback-demo/`,
- dedicated Scenario E/F proof bundles,
- and a local bundle-review helper/page.

### WS5 — Documentation sync

This documentation update is the WS5 landing step:

- `02-cli-contract.md` now marks shipped vs future CLI items,
- `03-rendering-and-artifacts.md` now marks shipped vs future rendering items,
- `05-dogfooding-and-validation.md` now records current coverage and remaining validation gaps,
- and `WEEK2-GAPS.md` now tracks the post-Week-4 remaining delta rather than the older post-Week-3 view.

## Test coverage summary

Week 4 landed with targeted test coverage across unit, integration, and e2e layers.

### Unit coverage highlights

- `test/unit/cli/context.test.ts`
- `test/unit/cli/exitCodes.test.ts`
- `test/unit/commands/create.test.ts`
- `test/unit/commands/input-source.test.ts`
- `test/unit/commands/screenshot.test.ts`
- `test/unit/commands/record-export.test.ts`
- `test/unit/renderer/profiles.test.ts`
- `test/unit/renderer/ghosttyWebBackend.test.ts`
- `test/unit/protocol/messages.test.ts`
- `test/unit/replay/offlineReplay.test.ts`

### Integration coverage highlights

- `test/integration/cli.test.ts`
- `test/integration/lifecycle.test.ts`
- `test/integration/wait-render.test.ts`
- `test/integration/host-renderer-rpc.test.ts`
- `test/integration/renderer-backend.test.ts`
- `test/integration/pty-basics.test.ts`
- `test/integration/gc.test.ts`

### E2E/regression coverage highlights

- `test/e2e/export-fixtures.test.ts`

Together, those tests cover the newly added CLI context plumbing, file input validation, cursor waits, create-option parity, snapshot scrollback behavior, enriched screenshot/export metadata, lifecycle-state transitions, destroyed-session guards, and GC behavior for the expanded terminal-state set.

## Architecture decisions made in Week 4

Week 4 clarified several design choices that should be treated as intentional unless a later plan changes them:

1. **Shared root command context is the CLI integration point.** Global home/timeout/color behavior is resolved once in `src/cli/context.ts` and reused by commands.
2. **Exit codes are derived from structured error codes.** The repo now treats the error catalog as the source of truth for automation-facing process status.
3. **Scrollback landed as an additive snapshot option.** The implementation uses `includeScrollback: boolean` rather than attempting the full `scope/cells/all` contract at once.
4. **Failure vs destroy is now explicit.** Unexpected host death reconciles to `failed`; intentional teardown flows through `destroying` to `destroyed`.
5. **Offline replay remains the recovery backbone.** Snapshot, screenshot, and export flows continue to rebuild from manifests/event logs when the live host is gone.
6. **Render-profile identity is hash-based.** Artifact metadata now records a stable `hashProfile(...)` digest rather than relying only on profile names.

## What remains for future work

The post-Week-4 delta is now smaller, but it is still meaningful:

- finish CLI/config parity (`--log-level`, global `--profile`, config files, `--idle-timeout-ms`, `--append-newline`),
- finish rendering fidelity (per-cell styling, bundled font assets, fuller snapshot schema, richer replay timing controls),
- finish validation parity (`unicode-grid`, `scrollback-demo`, dedicated unicode/scrollback bundles, bundle-review tooling),
- strengthen failure/recovery proof around renderer restart or host rebuild scenarios,
- and continue broader future-scope items such as native renderers, remote sessions, MCP wrapping, and cross-platform parity.

## Relationship to the design docs

Week 4 did not eliminate the need for the larger v1 design docs; it narrowed the highest-value gaps. The main design docs should now be read as:

- a record of the intended v1 contract,
- annotated by what shipped in Week 4,
- with the remaining follow-on work captured in `WEEK2-GAPS.md`.
