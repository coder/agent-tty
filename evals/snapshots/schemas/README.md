# evals/snapshots/schemas

## Overview

Zod schemas for the token snapshot check report. The report compares current per-case token totals with stored snapshot totals and classifies each case. `evals/snapshots/compare.ts` builds this report, and `evals/lib/schemas.ts` embeds it as the optional `snapshotCheck` field of the token report summary. The module has no runtime logic beyond schema definitions.

## Interface

- `[report.ts:SnapshotCheckOutcomeSchema]`: enum `new`, `orphaned`, `unchanged`, `improved`, `regressed`. `[report.ts:SnapshotCheckOutcome]` is its type.
- `[report.ts:SnapshotCheckCaseSchema]`: one compared case with `provider`, `model`, `lane`, `caseId`, `condition`, `caseFingerprint`, `totalTokens`, `outcome`, and optional `currentTotalTokens`, `snapshotTotalTokens`, `deltaTokens`, `deltaPercent`. `[report.ts:SnapshotCheckCase]` is its type.
- `[report.ts:SnapshotCheckSummarySchema]`: counts `total`, `new`, `orphaned`, `unchanged`, `improved`, `regressed`. `[report.ts:SnapshotCheckSummary]` is its type.
- `[report.ts:SnapshotCheckReportSchema]`: `regressionThresholdPercent`, `cases` and `summary`. `[report.ts:SnapshotCheckReport]` is its type.

## Invariants

- `[report.ts:SnapshotCheckCaseSchema]`, `[report.ts:SnapshotCheckSummarySchema]` and `[report.ts:SnapshotCheckReportSchema]` are `.strict()` and reject unknown keys.
- `[report.ts:Sha256HexSchema]` requires `caseFingerprint` to match `/^[0-9a-f]{64}$/u` (lowercase SHA-256 hex).
- `[report.ts:SnapshotLaneSchema]` limits `lane` to `prompt`, `execution`, `dogfood`. `[report.ts:SnapshotConditionSchema]` limits `condition` to `none`, `self-load`, `preloaded`, `stale`. Neither enum is exported.
- `[report.ts:NonNegativeIntSchema]` requires token totals and summary counts to be non-negative integers. `deltaTokens` is an integer that can be negative. `[report.ts:FiniteNumberSchema]` requires a finite `deltaPercent`.
- `[report.ts:SnapshotCheckReportSchema]` requires a finite, non-negative `regressionThresholdPercent`.
- `[report.ts:SnapshotCheckSummarySchema]` has no refinement that ties `total` to the outcome counts or to `cases.length`.

## Side Effects

- None found in code.

## Verification

- Run: `npx vitest run test/unit/evals/snapshots/compare.test.ts`
- Run: `npm run typecheck`
