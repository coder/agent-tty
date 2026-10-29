# src/replay

## Overview

`src/replay` renders a session without its live host. `withOfflineReplayRenderer` reads the session manifest and `events.jsonl` from disk, boots a renderer backend, replays the events up to a target sequence number and runs a callback against that backend. The `snapshot`, `screenshot`, `wait` and `record diff` commands in `src/cli/commands/` import it.

## Interface

- `OfflineReplayDeps` has one optional field, `backendFactory(rendererName, sessionId, profile)`, which returns a `RendererBackend` (type from `src/renderer/backend.ts`). Tests use it to inject a backend. [offlineReplay.ts:OfflineReplayDeps]
- `withOfflineReplayRenderer({ sessionDir, profileName?, targetSeq?, rendererName? }, run, deps?)` runs `run({ manifest, replayInput, backend })` against a replayed backend and returns its result. `manifest` is a `SessionRecord` (from `src/protocol/schemas.ts`). `replayInput` is a `ReplayInput` (from `src/renderer/types.ts`) built by `buildReplayInput` in `src/host/replay.ts`. [offlineReplay.ts:withOfflineReplayRenderer]

## Invariants

- `run` must be a function. `sessionDir` must be a non-empty absolute path. The session ID is `basename(sessionDir)` and must be non-empty. [offlineReplay.ts:withOfflineReplayRenderer] [offlineReplay.ts:getSessionId]
- The manifest must exist. A missing manifest fails an `invariant`. [offlineReplay.ts:withOfflineReplayRenderer]
- The default renderer is `DEFAULT_RENDERER_NAME`, checked with `resolveRendererName` (both from `src/renderer/names.ts`). The default profile is `'reference-dark'`, resolved with `resolveProfile` (from `src/renderer/profiles.ts`). The default backend factory is `createRendererBackend` (from `src/renderer/registry.ts`). [offlineReplay.ts:withOfflineReplayRenderer] [offlineReplay.ts:createBackend]
- A missing event log counts as zero events. Other event-log read errors, replay-input errors, profile errors and boot or replay errors become a `CliError` with code `REPLAY_ERROR` (from `src/protocol/errors.ts`). [offlineReplay.ts:readOfflineReplayInput] [offlineReplay.ts:withOfflineReplayRenderer]
- `backend.replayTo` runs only when `replayInput.targetSeq >= 0`. [offlineReplay.ts:withOfflineReplayRenderer]
- After the backend is created, `backend.dispose()` runs in a `finally` block, on success and on failure. [offlineReplay.ts:withOfflineReplayRenderer]

## Side Effects

- Reads `session.json` with `readManifestIfExists` (`src/storage/manifests.ts`) at the path from `manifestPath` (`src/storage/sessionPaths.ts`). [offlineReplay.ts:withOfflineReplayRenderer]
- Reads `events.jsonl` with `readEventLogRecords` (`src/storage/eventLogCodec.ts`). [offlineReplay.ts:readOfflineReplayInput]
- Boots, drives and disposes a renderer backend from `createRendererBackend`. The backend decides how it renders. The `ghostty-web` backend in `src/renderer/ghosttyWeb/backend.ts` uses Playwright and Chromium. [offlineReplay.ts:createBackend]

## Verification

- Run: `npx vitest run test/unit/replay`
- Run: `npm run typecheck`
