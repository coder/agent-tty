# evals/execution/verifiers

## Overview

This directory checks the evidence of one execution-lane trial. `verify` dispatches a `VerifierSpec` (from `evals/lib/types.ts`) to a verifier function by `spec.kind`. Verifiers read the session event log, the session manifest, artifact files and proof bundles, and return a `VerifierResult`. `evals/execution/runner.ts` calls `verify` for each case verifier and `verifyArtifactExists` for artifact requirements.

## Interface

- `VerifierContext` is `{ home, sessionId, transcript, artifacts }`. [index.ts:VerifierContext]
- `VerifierResult` is `{ pass, message, details? }`. [index.ts:VerifierResult]
- `verify(spec, ctx)` maps `spec.kind` to a verifier: `snapshot`, `event-log`, `screenshot`, `command`, `bundle`, `json`, `custom`. `json` checks for a `.json` artifact, or matches `config.patterns` when set. [index.ts:verify]
- For `custom`, `config.validator` selects one of `artifact-exists`, `snapshot-contains`, `event-log-check`, `exit-code`, `bundle-valid`. [index.ts:CUSTOM_VALIDATORS]
- `verifySnapshotContains(config, ctx)` checks that the transcript matches every `config.patterns` entry. [index.ts:verifySnapshotContains]
- `verifyEventLogCheck(config, ctx)` checks required and forbidden event types, output patterns and `minEvents` (default 1). [index.ts:verifyEventLogCheck]
- `verifyArtifactExists(config, ctx)` checks that existing artifact files match the kind, path patterns and `minCount` (default 1). [index.ts:verifyArtifactExists]
- `verifyExitCode(config, ctx)` compares `config.expectedExitCode` with the last `exit` event, or with the session manifest exit code. [index.ts:verifyExitCode]
- `verifyBundleValid(config, ctx)` runs `validateBundle` from `src/tools/validate-bundle.ts` on `config.bundlePath`. The default profile is `interactive-renderer`. [index.ts:verifyBundleValid]

## Invariants

- The `spec.kind` switch is exhaustive and ends in `unreachable`. A missing or unknown custom validator name returns a failure result. [index.ts:verify] [index.ts:resolveCustomValidator]
- Array config values must be string arrays. Artifact kinds must be keys of `ARTIFACT_MATCHERS`. Otherwise the reader throws. [index.ts:readRequiredStringArray] [index.ts:readArtifactKind]
- Each per-kind verifier function catches thrown errors and returns a failure result. [index.ts:verifyEventLogCheck] [index.ts:verifyBundleValid]
- `verify` does not catch errors from `resolveCustomValidator`. It throws when `config.validator` is set but is not a string. [index.ts:verify] [index.ts:resolveCustomValidator]
- An empty `sessionId` gives a failure result. [index.ts:verifyEventLogCheck] [index.ts:verifyExitCode]
- The session manifest is checked with `SessionRecordSchema.safeParse` from `src/protocol/schemas.ts`. [index.ts:readSessionExitCode]

## Side Effects

- Reads `events.jsonl` through `readEvalEvents` in `evals/lib/cliHarness.ts`. [index.ts:readSessionExitCode] [index.ts:verifyEventLogCheck]
- Reads the session manifest with `readFile` at `manifestPath(sessionDir(home, sessionId))` from `src/storage/sessionPaths.ts`. [index.ts:readSessionExitCode]
- Calls `stat` on each candidate artifact path. [index.ts:fileExists] [index.ts:existingArtifacts]
- Reads the proof bundle through `validateBundle`. [index.ts:verifyBundleValid]

## Verification

- Run: `npx vitest run test/unit/evals/verifiers.test.ts`
- Run: `npm run typecheck`
