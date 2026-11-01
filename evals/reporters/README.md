# evals/reporters

## Overview

Reporter plugins for eval run progress events. `types.ts` defines eight event payload schemas (run, lane, case and trial start/finish) and the `Reporter` hook interface. `ReporterDispatcher` validates each payload, redacts secret-like values, and calls every registered reporter's hook in order. The built-in reporters write console lines, append JSONL events, or write the final JSON and Markdown reports. `runtime.ts` derives case start/finish events from trial-level scheduler callbacks.

## Interface

- `[types.ts:Reporter]`: interface with a required `name` and optional hooks `onRunStart`, `onLaneStart`, `onCaseStart`, `onTrialStart`, `onTrialFinish`, `onCaseFinish`, `onLaneFinish`, `onRunFinish`. `[types.ts:ReporterHook]`, `[types.ts:ReporterEventName]` and `[types.ts:ReporterEventPayloads]` type the hooks and payloads.
- `[types.ts:RunStartEventSchema]`, `[types.ts:LaneStartEventSchema]`, `[types.ts:CaseStartEventSchema]`, `[types.ts:TrialStartEventSchema]`, `[types.ts:TrialFinishEventSchema]`, `[types.ts:CaseFinishEventSchema]`, `[types.ts:LaneFinishEventSchema]`, `[types.ts:RunFinishEventSchema]`, `[types.ts:RunFinishLaneErrorSchema]`: Zod payload schemas, each with a `z.infer` type of the same name without `Schema`.
- `[types.ts:TrialStatusSchema]`: enum `passed`, `failed`, `errored`. `[types.ts:TrialStatus]` is its type. `[types.ts:EVENT_SCHEMAS]` maps each event name to its schema.
- `[dispatch.ts:ReporterDispatcher]`: `dispatch(eventName, payload)` validates against `EVENT_SCHEMAS`, redacts, then awaits each reporter's matching hook.
- `[dispatch.ts:redactSecretLikeValues]`: deep-copies arrays and plain objects and replaces values whose key is `TOKEN`, `KEY`, `SECRET` or `PASSWORD`, or ends in `_<name>` (case-insensitive), with `[REDACTED]`.
- `[console.ts:ConsoleReporter]`: reporter `console`. Writes one summary line per event. Trial lines appear only with `verbose`. Options: `[console.ts:ConsoleReporterOptions]` (`verbose`, `writeLine`).
- `[jsonl.ts:JsonlReporter]`: reporter `jsonl`. Appends `{ type, timestamp, payload }` per event to `outputPath`, with `type` values `run.start` through `run.finish`. Options: `[jsonl.ts:JsonlReporterOptions]`.
- `[final-report.ts:FinalReportReporter]`: reporter `final`. On `onRunFinish` it calls `generateJsonReport` and `generateMarkdownReport` from `evals/lib/reporting.ts` and writes both files. It does nothing when `getFinalReportInputs()` returns `null`. Types: `[final-report.ts:FinalReportInputs]`, `[final-report.ts:FinalReportReporterContext]`.
- `[runtime.ts:computePlannedCases]`: groups work items by `caseId` and condition and counts planned trials per case.
- `[runtime.ts:CaseProgressTracker]`: `onTrialStart` dispatches `caseStart` on a case's first trial. `onTrialFinish` counts passed, failed and errored trials and dispatches `caseFinish` with `meanScore` after the last planned trial. Related types: `CaseProgressIdentity`, `CaseProgressResult`, `CaseProgressWorkspaceCarrier`, `PlannedCase`, `CaseProgressDispatcher`, `CaseProgressTrackerOptions`.

## Invariants

- `[types.ts:RunStartEventSchema]` and the other event schemas are `.strict()`. They require non-empty strings outside the `caseStart` `workspace` sub-object, ISO datetime timestamps, positive integers for trial and planned counts, and non-negative integers for durations and counts.
- `[dispatch.ts:validatePayload]` throws `Invalid reporter payload for event "<name>"` when the payload fails its schema. Reporters receive the redacted copy, not the caller's object.
- `[dispatch.ts:ReporterDispatcher]` throws on a non-array reporter list, a reporter without a non-empty `name`, or a duplicate name. It catches an error thrown by a hook, so later reporters still run.
- `[final-report.ts:FinalReportReporter]` asserts a context with a `getFinalReportInputs` function, and non-empty `jsonReportPath` and `markdownReportPath` values in `onRunFinish`.
- `[jsonl.ts:JsonlReporter]` asserts a non-empty `outputPath`.
- `[runtime.ts:CaseProgressTracker]` throws when a trial starts on a finished case, finishes on a case that has not started or is finished, or exceeds `plannedTrials`. It throws when `completedAt` is earlier than `startedAt` or the score is not finite.
- `[types.ts:CaseStartEventSchema]` accepts empty strings for `workspace.presetId` and `workspace.cwd`. `[runtime.ts:buildCaseStartWorkspace]` requires a non-empty `presetId` and `bootstrapCount` equal to `bootstrap.length`.

## Side Effects

- `[console.ts:defaultWriteLine]` writes to `process.stderr` when no `writeLine` is injected.
- `[dispatch.ts:ReporterDispatcher]` writes `reporter "<name>" failed on <event>` to `process.stderr` when a hook throws.
- `[jsonl.ts:JsonlReporter]` creates the parent directory once with `fs.mkdir` (recursive) and appends lines with `fs.appendFile`.
- `[final-report.ts:FinalReportReporter]` writes the JSON and Markdown reports with `writeFile` from `node:fs/promises`. It does not create directories.
- `[runtime.ts:CaseProgressTracker]` reads the clock through its `now` option (default `new Date().toISOString()`) and awaits the optional dispatcher. It does no I/O itself.
- `types.ts`: none found in code.

## Verification

- Run: `npx vitest run test/unit/evals/reporters`
- Run: `npx vitest run --maxWorkers=1 test/integration/evals-reporter-jsonl.test.ts test/integration/evals-reporter-default-parity.test.ts`
- Run: `npm run typecheck`
