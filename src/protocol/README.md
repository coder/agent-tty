# src/protocol

## Overview

`src/protocol` defines the machine-facing contract of agent-tty: the CLI JSON envelopes, the error codes, the Zod schemas for session manifests and event records, and the RPC request, params and result shapes between the CLI and the per-session host. `sessionStatusPolicy.ts` maps each session status to the operations it allows. The files have no I/O. A change to any CLI JSON shape must update these schemas and their tests in the same change (see `AGENTS.md`).

## Interface

- `CommandError`, `CommandSuccessEnvelope`, `CommandErrorEnvelope` and `CommandEnvelope` are the CLI output envelope types. Success is `{ ok: true, command, timestamp, result }`. Error is `{ ok: false, command, timestamp, error: { code, message, retryable, details } }`. [envelope.ts:CommandEnvelope]
- `createSuccessEnvelope` and `createErrorEnvelope` build the envelopes with `timestamp = new Date().toISOString()`. [envelope.ts:createSuccessEnvelope] [envelope.ts:createErrorEnvelope]
- `ERROR_CODES` and its value type `ProtocolErrorCode` list the error codes: `SESSION_NOT_FOUND`, `SESSION_NOT_RUNNING`, `SESSION_ALREADY_DESTROYED`, `HOST_UNREACHABLE`, `HOST_TIMEOUT`, `INVALID_SESSION_ID`, `INVALID_DIMENSIONS`, `INVALID_SIGNAL`, `INVALID_KEYS`, `INVALID_DURATION`, `INVALID_INPUT`, `STORAGE_READ_ERROR`, `STORAGE_WRITE_ERROR`, `MANIFEST_VALIDATION_ERROR`, `RPC_ERROR`, `PROTOCOL_ERROR`, `EXPORT_ERROR`, `REPLAY_ERROR`, `SKILL_NOT_FOUND`, `WAIT_TIMEOUT` and `INTERNAL_ERROR`. [errors.ts:ERROR_CODES] [errors.ts:ProtocolErrorCode]
- `DEFAULT_ERROR_MESSAGES` holds one default message per code. [errors.ts:DEFAULT_ERROR_MESSAGES]
- `makeCliError(code, options?)` returns a new `CliError` (class from `src/cli/errors.ts`). `MakeCliErrorOptions` has `message`, `retryable`, `details` and `cause`. [errors.ts:makeCliError] [errors.ts:MakeCliErrorOptions]
- `parseValidatedResult(schema, rawValue, message, errorCode?)` runs `schema.safeParse` and throws a `CliError` with the Zod issues on failure. The default code is `PROTOCOL_ERROR`. [validation.ts:parseValidatedResult]
- `deriveTerminationCategory(record)` maps a `SessionRecord` to a `TerminationCategory`. [terminationCategory.ts:deriveTerminationCategory]
- `SessionStatusPolicy` and `getSessionStatusPolicy(status)` give the per-status flags `active`, `terminal`, `commandable`, `liveHostEligible`, `offlineReplayEligible`, `collectable` and `destroyed`. The predicates `isActiveSessionStatus`, `isTerminalSessionStatus`, `isCommandableSessionStatus`, `isLiveHostEligibleSessionStatus`, `isOfflineReplayEligibleSessionStatus`, `isCollectableSessionStatus` and `isDestroyedSessionStatus` read the same table. [sessionStatusPolicy.ts:getSessionStatusPolicy] [sessionStatusPolicy.ts:isCommandableSessionStatus]
- Session manifest schemas: `SessionStatusSchema` (`running`, `exiting`, `exited`, `failed`, `destroying`, `destroyed`), `FailureOriginSchema` (`host-death`, `renderer-failure`, `storage-corruption`, `unknown`), `SessionRecordSchema` and `Sha256HexSchema`, with their inferred types. [schemas.ts:SessionStatusSchema] [schemas.ts:FailureOriginSchema] [schemas.ts:SessionRecordSchema] [schemas.ts:Sha256HexSchema]
- Event log schemas: `EventTypeSchema` (`output`, `input_text`, `input_paste`, `input_keys`, `input_run`, `run_complete`, `resize`, `signal`, `exit`, `marker`), one `*EventPayloadSchema` and one `*EventRecordSchema` per type, and `EventRecordSchema` with type `EventRecord`, a union discriminated on `type`. [schemas.ts:EventTypeSchema] [schemas.ts:EventRecordSchema]
- Snapshot, screenshot, wait and record schemas: `SnapshotParamsSchema`, `SnapshotResultSchema` (discriminated on `format`: `structured` or `text`), `ScreenshotParamsSchema`, `ScreenshotResultSchema`, `RenderWaitScopeSchema`, `WaitForRenderParamsSchema`, `WaitForRenderResultSchema`, `WaitResultSchema`, `RecordExportResultSchema`, `RecordDiffResultSchema` and `ReplayTimingModeSchema` (`recorded`, `accelerated`, `max-speed`), with related schemas and types. [schemas.ts:SnapshotResultSchema] [schemas.ts:WaitForRenderParamsSchema] [schemas.ts:RecordDiffResultSchema] [schemas.ts:ReplayTimingModeSchema]
- `schemas.ts` and `messages.ts` re-export the capability and renderer-runtime schemas (`CapabilityEntrySchema`, `RendererRuntimeSummarySchema` and others) from `src/renderer/capabilities.ts`. [src/renderer/capabilities.ts:CapabilityEntrySchema]
- `messages.ts` also re-exports these `schemas.ts` schemas: `RecordDiffLineSchema`, `RecordDiffResultSchema`, `RecordDiffSideSchema`, `RecordExportResultSchema`, `ReplayTimingModeSchema`, `RichSnapshotLineSchema`, `SnapshotCellSchema`, `SnapshotParamsSchema`, `SnapshotResultSchema`, `ScreenshotParamsSchema`, `ScreenshotResultSchema`, `WaitForRenderParamsSchema`, `WaitForRenderResultSchema` and `WaitResultSchema`. [schemas.ts:RecordDiffResultSchema] [schemas.ts:WaitResultSchema]
- RPC envelope schemas: `RpcRequestSchema`, `RpcErrorSchema`, `RpcSuccessResponseSchema`, `RpcErrorResponseSchema` and `RpcResponseSchema` (discriminated on `ok`), with their types. [messages.ts:RpcRequestSchema] [messages.ts:RpcResponseSchema]
- `RpcMethodSchema` and `RpcMethod` list the host RPC methods: `inspect`, `snapshot`, `screenshot`, `type`, `paste`, `run`, `mark`, `sendKeys`, `resize`, `signal`, `wait`, `waitForRender` and `destroy`. `RpcMethodSchemas` maps each method to its `{ params, result }` schemas. [messages.ts:RpcMethodSchema] [messages.ts:RpcMethodSchemas]
- Per-method schemas: `InspectParamsSchema`, `HostInspectResultSchema`, `HostInfoSchema`, `InspectResultSchema`, `ArtifactHealthSummarySchema`, `TerminationCategorySchema`, and the `Type`, `Paste`, `Run`, `Mark`, `SendKeys`, `Resize`, `Signal` and `Destroy` params and result schemas, plus `WaitParamsSchema`. [messages.ts:InspectResultSchema] [messages.ts:TerminationCategorySchema] [messages.ts:RunParamsSchema]

## Invariants

- Every `z.object(...)` in `schemas.ts` and `messages.ts` ends in `.strict()`, so unknown keys fail validation. [schemas.ts:SessionRecordSchema] [messages.ts:RpcRequestSchema]
- `SessionRecordSchema` requires `version` to be the literal `1`, at least one `command` entry, positive integer `cols` and `rows`, and ISO datetimes for `createdAt` and `updatedAt`. [schemas.ts:SessionRecordSchema]
- `Sha256HexSchema` requires 64 lowercase hex characters. [schemas.ts:Sha256HexSchema]
- An event record has a non-negative integer `seq` and an ISO datetime `ts`. [schemas.ts:EventRecordSchema]
- `InputRunEventPayloadSchema` requires `marker` when `noWait` is false and rejects it when `noWait` is true. [schemas.ts:InputRunEventPayloadSchema]
- `WaitForRenderParamsSchema` requires at least one of `text`, `regex`, `screenStableMs`, `cursorRow` or `cursorCol`. `text` and `regex` are mutually exclusive, and scope `cursor-line` needs `text` or `regex`. [schemas.ts:WaitForRenderParamsSchema]
- `RecordDiffResultSchema` checks that `identical` matches the equality of the two screen hashes. An identical result must have an empty diff and equal side row counts. A side with `capturedAtSeq` -1 must hash to a blank screen. For a non-identical result, the rows rebuilt from the diff must hash to each side's `screenHash`. [schemas.ts:RecordDiffResultSchema]
- `RpcRequestSchema` requires non-empty `id` and `method`. It does not restrict `method` to `RpcMethodSchema`. [messages.ts:RpcRequestSchema]
- `RpcMethodSchemas` uses `satisfies Record<RpcMethod, ...>`, so TypeScript requires one entry per method. [messages.ts:RpcMethodSchemas]
- `RunParamsSchema` defaults `noWait` to `false`. [messages.ts:RunParamsSchema]
- `makeCliError` sets `retryable` to true by default only for `HOST_UNREACHABLE`, `HOST_TIMEOUT` and `RPC_ERROR`. An explicit `retryable` option wins. [errors.ts:makeCliError]
- When the module loads, a top-level loop over `SESSION_STATUS_POLICIES` in `sessionStatusPolicy.ts` asserts these rules for each status: `active` differs from `terminal`, `collectable` implies `terminal`, `commandable` implies `active`, and `liveHostEligible` differs from `offlineReplayEligible`. [sessionStatusPolicy.ts:SESSION_STATUS_POLICIES]
- Only `running` is commandable. Only `running` and `exiting` are live-host eligible. `exited`, `failed` and `destroyed` are collectable. `getSessionStatusPolicy` throws for an unknown status. [sessionStatusPolicy.ts:getSessionStatusPolicy]
- `deriveTerminationCategory` maps `running` and `exiting` to `running`, and `destroying` and `destroyed` to `destroyed`. It maps `failed` to the record's `failureOrigin` (or `unknown`). It maps `exited` to `signal-exit` when `exitSignal` is set, `clean-exit` when `exitCode` is 0 or null, and `nonzero-exit` otherwise. [terminationCategory.ts:deriveTerminationCategory]

## Side Effects

- None found in code beyond reading the clock: `createSuccessEnvelope` and `createErrorEnvelope` call `new Date()`. The `sessionStatusPolicy.ts` checks throw at import time if the policy table breaks a rule. [envelope.ts:createSuccessEnvelope] [sessionStatusPolicy.ts:SESSION_STATUS_POLICIES]

## Verification

- Run: `npx vitest run test/unit/protocol`
- Run: `npx vitest run --maxWorkers=1 test/integration/lifecycle.test.ts test/integration/run.test.ts test/integration/host-renderer-rpc.test.ts`
- Run: `npm run typecheck`
