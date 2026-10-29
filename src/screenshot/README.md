# src/screenshot

## Overview

This directory turns a renderer screenshot into a stored session artifact. `captureScreenshotResult` asks a renderer backend for a PNG at a temporary path, checks the result, moves the file to its artifact name without replacing an existing file, and appends a `screenshot` entry to the session artifact manifest. `parseScreenshotResult` validates a screenshot result received from the host. Callers are `src/host/hostMain.ts` and `src/cli/commands/screenshot.ts`.

## Interface

- `CaptureScreenshotBackend`: `Pick<RendererBackend, 'screenshot'>`, so callers can only reach `screenshot()` [capture.ts:CaptureScreenshotBackend].
- `CapturedScreenshotResult`: `ScreenshotResult` (from `src/protocol/messages.ts`) with a required `sha256` [capture.ts:CapturedScreenshotResult].
- `CaptureScreenshotResultOptions`: `backend`, `sessionDir`, `profileName`, `expectedSessionId` and optional `showCursor` [capture.ts:CaptureScreenshotResultOptions].
- `parseScreenshotResult(rawResult, message?)` validates a value with `ScreenshotResultSchema` from `src/protocol/schemas.ts` through `parseValidatedResult` [capture.ts:parseScreenshotResult].
- `captureScreenshotResult(options)` captures, stores and records one screenshot and returns the `CapturedScreenshotResult` [capture.ts:captureScreenshotResult].

## Invariants

- `sessionDir`, `profileName` and `expectedSessionId` must be non-empty [capture.ts:captureScreenshotResult].
- The renderer result must match the expected session ID and the requested profile name. It must report a positive `pngSizeBytes`, the requested temporary path and a `sha256` [capture.ts:captureScreenshotResult].
- The result must pass `ScreenshotResultSchema`, and `sha256` must survive the parse [capture.ts:captureScreenshotResult].
- The preferred filename comes from `screenshotFilename(capturedAtSeq, profileName)` in `src/storage/artifactPaths.ts`. The stored name and the returned `artifactPath` get a `-<n>` suffix when a different PNG already has that name [capture.ts:captureScreenshotResult].

## Side Effects

- Creates the artifacts directory with `ensureArtifactsDir` from `src/storage/artifactPaths.ts` [capture.ts:captureScreenshotResult].
- The backend writes the PNG to `artifacts/.tmp-screenshot-<ulid>.png`. This module moves it into place with `publishArtifactFile` from `src/storage/artifactFiles.ts`, which never replaces an existing file [capture.ts:captureScreenshotResult]. A repeat capture at the same seq and profile with identical bytes reuses `screenshot-<seq>-<profile>.png`. Different bytes go to `screenshot-<seq>-<profile>-<n>.png`.
- Appends the manifest entry with `createArtifactEntry` and `appendArtifactWithRollback` from `src/storage/artifactManifest.ts`. If the append fails, the rollback helper tries to remove the PNG (best effort), but only when this capture created the file [capture.ts:captureScreenshotResult]. A reused file stays.
- On any error it removes the temporary file with `rm({ force: true })` and rethrows [capture.ts:captureScreenshotResult].
- This module computes no hash. The `sha256` comes from the renderer [capture.ts:captureScreenshotResult].

## Verification

- Run: `npx vitest run test/unit/screenshot`
- Run: `npm run typecheck`
