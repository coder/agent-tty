# src/snapshot

## Overview

This directory turns a renderer `SemanticSnapshot` into a snapshot result and stores it as a session artifact. `createSnapshotResult` builds a `structured` or `text` result with a Screen Hash. `persistSnapshotArtifact` writes the result as JSON under the session artifacts directory and appends a `snapshot` entry to the artifact manifest. Callers are `src/host/hostMain.ts` and `src/cli/commands/snapshot.ts`.

## Interface

- `SnapshotFormat`: the non-null `format` of `SnapshotParams` from `src/protocol/messages.ts` [capture.ts:SnapshotFormat].
- `parseSnapshotResult(rawResult, message?)` validates a value with `SnapshotResultSchema` from `src/protocol/schemas.ts` through `parseValidatedResult` [capture.ts:parseSnapshotResult].
- `createSnapshotResult(snapshot, format)` returns a `SnapshotResult`. Format `structured` copies the whole snapshot. Format `text` joins the scrollback lines and visible lines with `\n`. Both add `screenHash` [capture.ts:createSnapshotResult].
- `PersistSnapshotArtifactOptions`: `sessionDir`, `format`, `snapshot`, `result` and `rendererBackend` [capture.ts:PersistSnapshotArtifactOptions].
- `persistSnapshotArtifact(options)` writes the artifact file and its manifest entry [capture.ts:persistSnapshotArtifact].
- `CaptureSnapshotResultOptions`: `sessionDir`, `format`, `snapshot`, `rendererBackend` and optional `expectedSessionId` [capture.ts:CaptureSnapshotResultOptions].
- `captureSnapshotResult(options)` runs `createSnapshotResult` and then `persistSnapshotArtifact`, and returns the result [capture.ts:captureSnapshotResult].

## Invariants

- `createSnapshotResult` validates its output with `SnapshotResultSchema` [capture.ts:createSnapshotResult].
- `persistSnapshotArtifact` asserts a non-empty `sessionDir` and `rendererBackend` [capture.ts:persistSnapshotArtifact].
- The result must match its source snapshot: same `format`, `sessionId`, `capturedAtSeq`, `cols`, `rows`, `cursorRow` and `cursorCol` [capture.ts:assertSnapshotResultMatchesSource].
- If `expectedSessionId` is set and differs from the snapshot's `sessionId`, `captureSnapshotResult` throws a `PROTOCOL_ERROR` CLI error [capture.ts:captureSnapshotResult].
- The filename comes from `snapshotFilename(capturedAtSeq, format)` in `src/storage/artifactPaths.ts` [capture.ts:persistSnapshotArtifact].

## Side Effects

- `createSnapshotResult` computes the Screen Hash with `computeScreenHash` from `src/renderer/canonicalScreen.ts` [capture.ts:createSnapshotResult].
- `persistSnapshotArtifact` creates the artifacts directory with `ensureArtifactsDir` from `src/storage/artifactPaths.ts` [capture.ts:persistSnapshotArtifact].
- It writes the pretty-printed JSON result with `writeTextFileAtomic` from `src/storage/manifests.ts` [capture.ts:persistSnapshotArtifact]. The write replaces any existing `snapshot-<seq>-<format>.json` at the same seq and format.
- It appends the manifest entry with `createArtifactEntry` and `appendArtifactWithRollback` from `src/storage/artifactManifest.ts`. If the append fails, the rollback helper tries to remove the snapshot file (best effort) [capture.ts:persistSnapshotArtifact]. After an overwrite, that removal also deletes the file of the earlier recorded artifact with the same name.

## Verification

- Run: `npx vitest run test/unit/snapshot`
- Run: `npm run typecheck`
