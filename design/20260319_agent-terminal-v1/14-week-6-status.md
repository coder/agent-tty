# agent-terminal v1 week 6 status

This document records the repository's actual Week 6 outcome after the plan in [13-week-6-plan.md](./13-week-6-plan.md).

Week 6 was not a new feature-family milestone. It was the contract/introspection/failure-taxonomy reconciliation pass that moved the repo from "mostly shipped but still ambiguous in the docs" to "materially design-aligned for the current v1 surface."

## Status update (2026-03-25)

By 2026-03-25, the Week 6 workstreams closed the highest-value remaining gaps between the broader v1 design docs and the shipped repository surface:

- `inspect --json` now exposes the most important missing review and automation fields,
- `version --json` now reports the compiled-in renderer backend list instead of an empty placeholder,
- artifact health is surfaced directly from CLI inspection output,
- failure reporting now separates persisted `failureOrigin` from derived `terminationCategory`,
- and the shipped JSON envelopes are locked down with dedicated golden-envelope tests.

The remaining gap is now mostly intentional future scope rather than unfinished contract closure.

## What shipped in Week 6

- Shared Week 6 schema scaffolding landed for richer inspect output, failure taxonomy, and artifact-health summaries in `src/protocol/messages.ts` and related tests (`387fc2e`).
- `version --json` now reports `rendererBackends: ['ghostty-web']` from `src/cli/commands/version.ts`, with accompanying unit/integration coverage (`a4ae0c9`).
- Artifact-health summarization landed in `src/storage/artifactHealth.ts`, including totals, `byKind`, missing-artifact detection, and overall health classification (`a8f33cf`).
- Failure-origin tracking and derived termination-category reporting landed across `src/protocol/schemas.ts`, `src/host/lifecycle.ts`, `src/host/terminationCategory.ts`, and `src/cli/commands/inspect.ts` (`9782608`).
- The `DoctorCheck` contract was tightened by requiring `durationMs`, removing a stray optional field from that result shape (`56276de`).
- `inspect` success envelopes were enriched in `src/cli/commands/inspect.ts` to expose `lastEventSeq`, `terminationCategory`, `artifacts`, and `usedOfflineReplay` (`9b14ed2`).
- Golden-envelope coverage now locks the shipped `inspect`, `version`, and representative error envelopes in `test/unit/commands/golden-envelopes.test.ts` (`387fc2e`).
- Formatting cleanup landed for the new artifact-health files (`2dda618`).

## What did NOT fully land in Week 6 (future scope)

- Native renderer adapters
- Mouse input support
- Remote/network sessions
- MCP wrapper
- Broad Windows/native rendering parity work
- Renderer CSP hardening beyond documenting the current localhost-only trade-off
- Full event-log redesign
- Full snapshot-schema redesign
- Runtime renderer capability discovery beyond the current static `rendererBackends` list
- Full result-shape parity with every design example for every command

## Week 6 outcome by workstream

- Workstream A — CLI contract and result-shape parity: **Completed for the planned Week 6 scope.** `inspect` and `version` now expose the missing high-value JSON fields, representative envelopes are locked down by tests, and the remaining parity delta is smaller and explicitly future scope.
- Workstream B — session and artifact introspection: **Completed for the planned Week 6 scope.** `inspect` now exposes artifact totals and missing-artifact health directly instead of requiring manual manifest inspection.
- Workstream C — failure taxonomy and recovery reporting: **Completed for the planned Week 6 scope.** Persisted `failureOrigin`, derived `terminationCategory`, stale-host `host-death` reconciliation, and offline replay fallback are now part of the public inspection story.
- Workstream D — design/code reconciliation: **Completed.** The main design docs and gap tracker now describe the shipped Week 6 surface and keep genuinely unfinished items clearly separated as future scope.

## Validation results

The Week 6 landing validation reported:

- 34 unit test files / 356 tests passing
- 10 integration test files / 90 tests passing
- typecheck clean
- lint clean
- format clean

## Proof bundles

No new dedicated checked-in `dogfood/*week6*` directory landed in the repository. That is an important limit of the Week 6 closeout and should not be glossed over as if fresh Week 6 bundles existed.

The nearest checked-in supporting evidence for the recovery/review parts of Week 6 remains:

- `dogfood/20260323-week5-recovery-host/`, `dogfood/20260323-week5-recovery-renderer/`, and `dogfood/20260323-week5-recovery-replay/` — recovery and fallback context for the failure-reporting work
- `dogfood/20260323-week5-review-helper/` — reviewer-surface context for the inspection/reporting work

For the Week 6 contract-closeout itself, the strongest checked-in evidence is the landed test coverage plus the updated design/status docs rather than a new repo bundle directory.

## What remains for future work

- The remaining delta is now concentrated in future-scope platform/runtime expansion and larger data-model redesign questions rather than the high-value `inspect` / `version` / artifact-health / failure-reporting gaps that Week 6 set out to close.
- See `WEEK2-GAPS.md` for the detailed current future-scope list.
