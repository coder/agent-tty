# src/util

## Overview

Small shared helpers that the rest of `src/` imports: fail-fast assertions, abort and timeout plumbing, resource cleanup scopes, a per-key serializer, a line diff, a leveled logger, hashing and path checks. Each file has one narrow job. Only the logger, the package metadata loader, the abort helpers and `isDirectExecution` touch I/O, timers or process state.

## Interface

- `invariant(condition, message)`, `assertString(value, message)`: assertion functions built on `node:assert/strict`. `unreachable(value: never, message)` throws for exhaustive switches. [assert.ts:invariant] [assert.ts:assertString] [assert.ts:unreachable]
- `makeAbortReason`, `makeAbortError`, `throwIfAborted`, `addAbortListener`: `AbortError` construction and `AbortSignal` listener helpers. [abort.ts:makeAbortReason] [abort.ts:makeAbortError] [abort.ts:throwIfAborted] [abort.ts:addAbortListener]
- `createResourceScopedSettlers(scope, resolve, reject)` and `ResourceScopedSettlers`: settlers that work once and close the scope before they settle. [abort.ts:createResourceScopedSettlers]
- `waitForScopedOperation(options)` and `ScopedOperationOptions`: race an operation against an optional timeout and an optional abort signal. [abort.ts:waitForScopedOperation]
- `ResourceScope` (`add(name, release)`, `close()`), `ResourceScopeCloseError`, `ResourceScopeFailure`: ordered cleanup of registered resources. [resourceScope.ts:ResourceScope] [resourceScope.ts:ResourceScopeCloseError]
- `KeyedSerializer<K>` with `run(key, operation)`: runs operations one at a time per key. [keyedSerializer.ts:KeyedSerializer]
- `diffLines(a, b)` and `LineDiffEntry` (`op: 'equal' | 'delete' | 'add'`): LCS line diff. [lineDiff.ts:diffLines] [lineDiff.ts:LineDiffEntry]
- `Logger`, `createLogger`, `createProcessLogger`, `LOG_LEVEL_VALUES`, `LogLevel`, `LogSink`, `DEFAULT_LOG_LEVEL`, `isLogLevel`, `assertLogLevel`, `resolveLogLevel`: leveled logger. [logger.ts:Logger] [logger.ts:createProcessLogger] [logger.ts:resolveLogLevel]
- `loadPackageMetadata()` and `PackageMetadata`: `{ name, version }` from the root `package.json`. [packageMetadata.ts:loadPackageMetadata]
- `sha256Hex(text)`: lowercase SHA-256 hex digest of the UTF-8 text. [hash.ts:sha256Hex]
- `hasErrorCode(error, code)`: true when `error` is an `Error` with that `code`. [hasErrorCode.ts:hasErrorCode]
- `isDirectExecution(importMetaUrl)`: true when the calling module is the script that `node` or `tsx` runs. [isDirectExecution.ts:isDirectExecution]
- `isWithinRoot(rootPath, candidatePath)`: true when the resolved candidate is the root or below it. [isWithinRoot.ts:isWithinRoot]

## Invariants

- `invariant` and `assertString` throw `AssertionError` from `node:assert/strict`. [assert.ts:invariant] [assert.ts:assertString]
- `addAbortListener` asserts that the signal has not aborted yet. Its doc comment tells callers to check `signal.aborted` or call `throwIfAborted()` first. [abort.ts:addAbortListener]
- Settlers from `createResourceScopedSettlers` act once (`settled` flag). If the scope close fails during a reject, they reject with an `AggregateError`. [abort.ts:createResourceScopedSettlers]
- The doc comment of `waitForScopedOperation` states that the scope closes before the returned promise settles, and that `onAbort` runs before scope cleanup. The type requires `timeoutMs` and `timeoutResult` together. [abort.ts:waitForScopedOperation] [abort.ts:ScopedOperationOptions]
- `ResourceScope.add` asserts that the scope is open. `close()` runs releases in reverse order once (`closePromise`), collects every failure, and throws `ResourceScopeCloseError` if any release failed. [resourceScope.ts:ResourceScope]
- `KeyedSerializer.run`: when an earlier operation for the key rejects, later queued operations inherit the rejection without running. The doc comment warns that calling `run` with the same key from inside a queued operation hangs forever. [keyedSerializer.ts:KeyedSerializer]
- `diffLines` accepts every input size. When the differing middle exceeds `MAX_DIFF_CELLS` (4,000,000), it falls back to all deletes, then all adds. On a tie it emits the delete first (doc comment). [lineDiff.ts:diffLines]
- `resolveLogLevel` returns `'info'` for `undefined` and fails `assertLogLevel` for any value outside `LOG_LEVEL_VALUES`. Level ranks are fixed in a frozen `LOG_LEVEL_RANK`. [logger.ts:resolveLogLevel] [logger.ts:Logger]
- `loadPackageMetadata` asserts that `name` and `version` are strings. [packageMetadata.ts:loadPackageMetadata]

## Side Effects

- `Logger` writes `[agent-tty] <level>: <message>` lines to its sink. The default sink is `process.stderr.write`. `createProcessLogger` reads `AGENT_TTY_LOG_LEVEL` from the environment. [logger.ts:Logger] [logger.ts:createProcessLogger]
- `loadPackageMetadata` reads `package.json` with `fs/promises.readFile` through a URL relative to this module. [packageMetadata.ts:loadPackageMetadata]
- `addAbortListener` adds a `once` listener to the signal and registers its removal in the scope. `waitForScopedOperation` starts a `setTimeout` and registers `clearTimeout` in the scope. [abort.ts:addAbortListener] [abort.ts:waitForScopedOperation]
- `isDirectExecution` reads `process.argv[1]`. `sha256Hex` uses `node:crypto`. [isDirectExecution.ts:isDirectExecution] [hash.ts:sha256Hex]
- `assert.ts`, `hasErrorCode.ts`, `isWithinRoot.ts`, `keyedSerializer.ts`, `lineDiff.ts` and `resourceScope.ts` do no I/O.

## Verification

- Run: `npx vitest run test/unit/util`
- Run: `npm run typecheck`
