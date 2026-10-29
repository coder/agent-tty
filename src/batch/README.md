# src/batch

## Overview

This directory parses and runs a Batch: an ordered JSON list of `type`, `paste`, `sendKeys`, `run` and `wait` steps sent to one live session. `parseBatchPlan` validates the whole plan before any input is sent. `executeBatch` runs the steps in order through a `StepDriver` and records one result per step. `createRpcStepDriver` implements the driver over the session host RPC socket. The caller is `src/cli/commands/batch.ts`.

## Interface

- `BatchStep`: a union of `type` (`text`), `paste` (`text`), `sendKeys` (`keys`), `run` (`command`, `noWait`, `timeoutMs`) and `wait` (`condition`, `timeoutMs`) steps [plan.ts:BatchStep]. `BatchPlan` is `{ steps }` [plan.ts:BatchPlan].
- `parseBatchPlan(raw)` parses a JSON string into a `BatchPlan` [plan.ts:parseBatchPlan].
- `StepStatusSchema` and `StepStatus`: `completed`, `failed`, `not-run` and `interrupted` [result.ts:StepStatusSchema].
- Record schemas and types: `BatchStepErrorSchema`, `InputStepRecordSchema`, `RunStepRecordSchema`, `WaitStepRecordSchema` and `BatchStepRecordSchema` (discriminated on `kind`) [result.ts:BatchStepRecordSchema].
- `BatchResultSchema`: `steps`, `completedCount` and `failedIndices` [result.ts:BatchResultSchema].
- `unreachedStepRecord(step, index, status)` builds a `not-run` or `interrupted` record [result.ts:unreachedStepRecord].
- `buildPartialBatchResult(plan, recorded)` completes a result for a batch that stopped early [result.ts:buildPartialBatchResult].
- `StepDriver`: `type`, `paste` and `sendKeys` return the event seq. `run` returns a `RunResult`. `wait(condition, afterSeq, timeoutMs)` returns a `WaitForRenderResult` [stepDriver.ts:StepDriver].
- `createRpcStepDriver(socketPath, rendererName?)` returns a `StepDriver` backed by the session host RPC [stepDriver.ts:createRpcStepDriver].
- `ExecuteBatchOptions`: `plan`, `driver`, `keepGoing`, and optional `assertCommandable` and `onStep` callbacks [executor.ts:ExecuteBatchOptions].
- `executeBatch(opts)` runs the plan and returns a `BatchResult` [executor.ts:executeBatch].

## Invariants

- Doc comment: `parseBatchPlan` is pure. Every failure throws a CLI error, so the whole plan is rejected before any input is sent. A Batch is not atomic [plan.ts:parseBatchPlan].
- The plan must be valid JSON, a JSON array, and non-empty [plan.ts:parseBatchPlan].
- Each step must be a plain object with exactly one verb key. Zero or several verbs throw `INVALID_INPUT` with `details.stepIndex` [plan.ts:parseStep].
- All step schemas are Zod `.strict()`. Strings and `sendKeys` arrays must be non-empty [plan.ts:SendKeysStepSchema].
- `sendKeys` names are checked with `assertValidKeyName` from `src/pty/keyEncoder.ts` [plan.ts:parseSendKeysStep].
- Wait conditions are built with `prepareRenderWaitCondition` from `src/renderWait/matcher.ts` [plan.ts:parseWaitStep].
- An omitted wait timeout becomes `DEFAULT_WAIT_TIMEOUT_MS` (600,000 ms). An explicit `0` means no timeout [plan.ts:DEFAULT_WAIT_TIMEOUT_MS].
- `executeBatch` runs steps in order. Without `keepGoing`, the first failed step stops the batch and every later step gets a `not-run` record [executor.ts:executeBatch].
- A non-wait step that produced a seq, failed or not, becomes the `afterSeq` baseline for the next wait [executor.ts:executeBatch].
- A thrown error that is not a `CliError` becomes an `INTERNAL_ERROR` failed record [executor.ts:reframeAsInternalError].
- A waited `run` that does not complete fails with `WAIT_TIMEOUT` or `SESSION_NOT_RUNNING` [executor.ts:runRunStep].
- A `wait` that times out or does not match fails with `WAIT_TIMEOUT` [executor.ts:runWaitStep].
- All record schemas are `.strict()` [result.ts:BatchResultSchema].
- `buildPartialBatchResult` marks the first unrecorded step `interrupted` and the rest `not-run` [result.ts:buildPartialBatchResult].
- `createRpcStepDriver` asserts a non-empty `socketPath` and validates every RPC response with its result schema [stepDriver.ts:createRpcStepDriver].
- RPC transport timeouts add padding to the step timeout: `RUN_TRANSPORT_PADDING_MS` (10,000) for waited runs and `WAIT_TRANSPORT_PADDING_MS` (5,000) for waits [stepDriver.ts:RUN_TRANSPORT_PADDING_MS]. A waited run with no timeout pads `DEFAULT_RUN_TIMEOUT_MS` (30,000) [stepDriver.ts:DEFAULT_RUN_TIMEOUT_MS]. A `noWait` run uses a fixed `NO_WAIT_RUN_TRANSPORT_TIMEOUT_MS` (10,000) [stepDriver.ts:NO_WAIT_RUN_TRANSPORT_TIMEOUT_MS]. A wait with no timeout uses transport timeout `0`, which means no transport timeout.

## Side Effects

- `createRpcStepDriver` calls `sendRpc` from `src/host/rpcClient.ts` over the session socket with the methods `type`, `paste`, `sendKeys`, `run` and `waitForRender` [stepDriver.ts:createRpcStepDriver].
- `executeBatch` does no I/O itself. It acts through the injected driver and callbacks and reads `Date.now()` for step durations [executor.ts:executeBatch].
- `plan.ts` and `result.ts`: none found in code.

## Verification

- Run: `npx vitest run test/unit/batch test/unit/commands/batch.test.ts`
- Run (integration): `npx vitest run --maxWorkers=1 test/integration/batch.test.ts`
- Run (e2e): `npx vitest run --maxWorkers=1 test/e2e/batch-fixture.test.ts`
- Run: `npm run typecheck`
