# evals/providers

## Overview

Provider adapters that the eval lanes use to send a case to a model and get normalized output back. `base.ts` defines the `EvalProvider` contract and the `createProvider` factory. `claude.ts` and `codex.ts` wrap the Claude Code and Codex CLIs as child processes. `fixtures.ts` holds deterministic providers for tests (stub, recording decorator, and fixture replay from disk). `base.js` is a 3-line JavaScript re-export of `base.ts`. Its comment says it lets inline `tsx -e` evals resolve the factory through the repo's `.js` import specifier. The other modules import `./base.js` (for example `evals/run.ts` and `evals/providers/claude.ts`).

## Interface

- `[base.ts:EvalProvider]`: interface with `readonly id`, `detect()`, `invokePlanMode(request)`, `invokeAgentMode(request)` and `parse(raw)`. Request and result types come from `evals/lib/types.ts`.
- `[base.ts:SUPPORTED_PROVIDER_IDS]`: `['stub', 'fixture', 'recording', 'claude', 'codex'] as const`.
- `[base.ts:createProvider]`: `createProvider(id, config)` returns a `StubProvider`, `FixtureProvider`, `RecordingProvider`, `ClaudeProvider` or `CodexProvider`. For `recording` it wraps `config.wrappedProvider`, or builds the inner provider from `config.wrappedProviderId`.
- `[base.ts:ProviderFactoryConfig]`: `Partial<ProviderConfig>` plus optional `fixtureDir`, `wrappedProvider` and `wrappedProviderId`.
- `base.js`: `export * from './base.ts'`.
- `[claude.ts:ClaudeProvider]`: id `claude`. Defaults: command `['claude']`, model `sonnet`, mode `agent-run`. `detect` runs `<command> --version`. Plan mode runs `--print --output-format json`. Agent mode runs `--bare --print --verbose --output-format stream-json` with the permission-skip flags, optional `--max-turns` and `--model`. `parse` reads JSON/JSONL records and falls back to role-prefixed plain text.
- `[codex.ts:CodexProvider]`: id `codex`. Defaults: command `['codex']`, model `gpt-5.4`, mode `agent-run`. `detect` runs `<command> --version`. Plan and agent mode run `exec --color never --ephemeral --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox`, and agent mode adds `--json`. `parse` reads Codex JSONL events and falls back to text parsing.
- `[fixtures.ts:StubProvider]`: id `stub`. Returns canned outputs by `caseId`, then `default`, then fixed pass-through text. A `cannedOutputs.__error` value makes every method throw that error.
- `[fixtures.ts:RecordingProvider]`: id `recording`. Delegates to an inner provider and records each call in memory. `getRecordings()` returns a copy and `clearRecordings()` empties it.
- `[fixtures.ts:FixtureProvider]`: id `fixture`. Replays `runtime-info.json`, `responses/<caseId>.json`, `agent-results/<caseId>.json` and optional `normalized/<caseId>.json` from `fixtureDir`. It accepts schema-valid payloads and a legacy shape.
- `[fixtures.ts:createStubProvider]`, `[fixtures.ts:createRecordingProvider]`, `[fixtures.ts:createFixtureProvider]`: thin factory functions for the three test providers.

## Invariants

- `[base.ts:createProvider]` throws `Unknown provider id` for an id that is not in `SUPPORTED_PROVIDER_IDS`. It throws when `fixture` has no non-empty `fixtureDir`, or when `recording` has no wrapped provider or a `wrappedProviderId` of `recording`.
- `[claude.ts:ClaudeProvider]`, `[codex.ts:CodexProvider]`, `[fixtures.ts:StubProvider]` and `[fixtures.ts:FixtureProvider]` throw when `config.providerId` is set to another id, and validate the merged config with `ProviderConfigSchema` from `evals/lib/schemas.ts`.
- `[claude.ts:parseAgentRequest]`, `[codex.ts:parseAgentRequest]`, `[fixtures.ts:parseAgentRequest]` and their sibling `parse*` helpers throw when a request, result or runtime info fails its `evals/lib/schemas.ts` schema.
- `[claude.ts:coerceNormalizedOutput]` and `[codex.ts:coerceNormalizedOutput]` fall back to `{ finalText: raw, messages: [raw], referencedSkills: [], toolCalls: [] }` (with empty `messages` when `raw` is empty) when `NormalizedProviderOutputSchema` rejects the parsed output.
- `[claude.ts:runCommand]` and `[codex.ts:runCommand]` throw on an empty command or a timeout that is not a non-negative integer. A timeout of 0 sets no timer.
- `[claude.ts:resolveTimeoutMs]` and `[codex.ts:resolveTimeoutMs]` use `config.timeoutMs` when set. Otherwise `evalCase.budgets.timeoutMs` must be a positive integer.
- `[claude.ts:ClaudeProvider]` and `[codex.ts:CodexProvider]` set `ok` only when the exit code is 0 and the run did not time out. Error classes: `TimeoutError`, `ClaudeExecutionError` or `CodexExecutionError`, and `ProviderUnavailable` when `detect` reports the CLI as unavailable.
- `[claude.ts:buildEffortArgs]` throws when `CLAUDE_CODE_EFFORT` is set but empty after trim.
- `[codex.ts:parseCodexTokenUsageObject]` returns `undefined` when `cached_input_tokens` and `input_tokens_details.cached_tokens` disagree or the usage fails `TokenUsageSchema`.
- `[fixtures.ts:RecordingProvider]` throws when the inner provider has an empty id or lacks one of the four methods.
- `[fixtures.ts:extractCaseId]` throws when a request has neither a non-empty `caseId` nor an `evalCase.id`.

## Side Effects

- `[claude.ts:runCommand]` and `[codex.ts:runCommand]` spawn the CLI with `child_process.execFile` (utf8, `maxBuffer` 10 MiB, `AbortController` signal) and close its stdin. On timeout they send `SIGTERM`, then `SIGKILL` 1,000 ms later.
- `[claude.ts:ClaudeProvider]` agent mode passes `--dangerously-skip-permissions`. `[codex.ts:CodexProvider]` plan and agent mode pass `--dangerously-bypass-approvals-and-sandbox`. Agent mode runs in the request `cwd`. Each invoke call runs `detect` first, which spawns `<command> --version` with a 10,000 ms default timeout (`DEFAULT_DETECT_TIMEOUT_MS`).
- `[claude.ts:buildCommandEnv]` and `[codex.ts:buildCommandEnv]` read `process.env`, merge the config and request env over it, and prepend `$HOME/.local/bin` to `PATH` when it is missing. `[claude.ts:buildEffortArgs]` reads `CLAUDE_CODE_EFFORT` from the provider env or `process.env`.
- `[fixtures.ts:FixtureProvider]` reads fixture files with `fs.access` and `fs.readFile` from `node:fs/promises`. It writes no files.
- `[fixtures.ts:StubProvider]` and `[fixtures.ts:RecordingProvider]` do no I/O. They keep state in memory and read the clock for timestamps.
- `base.ts` and `base.js`: none found in code.

## Verification

- Run: `npx vitest run test/unit/evals/claude.test.ts test/unit/evals/codex.test.ts`
- Run: `npx vitest run --maxWorkers=1 test/integration/evals/authoring-pilots.test.ts` (uses `createFixtureProvider`)
- Run: `npm run typecheck`
