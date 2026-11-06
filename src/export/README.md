# src/export

## Overview

This directory converts a session's event log into recording exports. `generateAsciicast` builds an asciicast v2 recording as a string and leaves the file write to the caller. `generateWebmExport` replays the events into a video-capable renderer backend (by default `GhosttyWebBackend`, which runs headless Chromium) and saves the recorded WebM video at the requested path. `renderGridFramesToSvg` turns styled grid frames into SVG text, still or animated, and leaves the file write to the caller.

## Interface

- `AsciicastHeader`: `version: 2`, `width`, `height`, `timestamp`, `title`, optional `sessionId` and `toolVersion`, and `env.TERM`. `width` and `height` are the creation size of the session (`manifest.creationCols` and `manifest.creationRows`, or `manifest.cols` and `manifest.rows` when they are absent), the size that replay starts from. A later `resize` event becomes an `r` line, so a resized session keeps its first size in the header [asciicast.ts:AsciicastHeader].
- `AsciicastExport`: `contents`, `header`, `capturedAtSeq`, `durationMs`, `outputEventCount`, `resizeEventCount` and `markerCount` [asciicast.ts:AsciicastExport].
- `generateAsciicast(sessionId, manifest, events, toolVersion?)` returns an `AsciicastExport`. It runs synchronously [asciicast.ts:generateAsciicast].
- `WebmExportOptions`: `sessionId`, `sessionDir`, `manifest`, `events`, `outputPath`, and optional `targetSeq`, `profileName`, `timingMode` and `rendererName` [webm.ts:WebmExportOptions].
- `WebmExportDeps`: optional `backendFactory` and `replayTimeoutMs`, for tests and callers that supply their own backend [webm.ts:WebmExportDeps].
- `WebmExportResult`: `capturedAtSeq`, `durationMs`, `outputEventCount`, `resizeEventCount`, `cols`, `rows`, `profileName`, `timingMode` and `rendererBackend`, plus the optional `missingGlyphs` and `missingGlyphsTruncated` of `RecordedGlyphFields` [webm.ts:WebmExportResult].
- `generateWebmExport(options, deps?)` returns a `Promise<WebmExportResult>` [webm.ts:generateWebmExport].
- `renderGridFramesToSvg({ profile, frames, animate, heapSizeLimit? })` returns SVG text from styled grid frames, which `captureGridFrames` in `src/replay/gridFrames.ts` builds. It runs synchronously and leaves the file write to the caller [svg.ts:renderGridFramesToSvg].

## Invariants

- `generateAsciicast` asserts a non-empty `sessionId` equal to `manifest.sessionId`, a positive initial width and height (`manifest.creationCols ?? manifest.cols` and `manifest.creationRows ?? manifest.rows`, as in `buildReplayInput`), and a non-empty `toolVersion` when given [asciicast.ts:generateAsciicast]. `manifest.createdAt` must parse as a valid timestamp even when there are events. The header uses it when `events` is empty [asciicast.ts:parseTimestamp].
- Event timestamps must parse to finite numbers [asciicast.ts:parseTimestamp]. They must not decrease from one event to the next [asciicast.ts:generateAsciicast].
- Event mapping: `output` becomes `o`, `resize` becomes `r` with `COLSxROWS`, and `marker` becomes `m`. Input, run, signal and exit events are skipped. An unknown type reaches `unreachable()` [asciicast.ts:generateAsciicast].
- `generateWebmExport` asserts a non-empty `sessionId`, absolute `sessionDir` and `outputPath`, and positive initial dimensions. An empty event list gives a blank video with `capturedAtSeq` -1 and `durationMs` 0 [webm.ts:generateWebmExport].
- `generateAsciicast` reports `capturedAtSeq` -1 for an empty event list [asciicast.ts:generateAsciicast].
- Defaults: timing mode `recorded` and profile `reference-dark` [webm.ts:generateWebmExport].
- A requested `libghostty-vt` renderer is replaced with `ghostty-web`. A code comment says `libghostty-vt` is semantic-only [webm.ts:generateWebmExport].
- The default backend factory accepts only `ghostty-web` [webm.ts:createDefaultBackend].
- Timing presets: `accelerated` caps gaps at 400 ms and holds frames at least 100 ms. `max-speed` holds frames at least 16 ms. Each mode holds the final frame (1000 ms, or 500 ms for `max-speed`) [webm.ts:buildReplayTimingOptions].
- The timed replay fails after `REPLAY_TIMEOUT_MS` (5 minutes) [webm.ts:REPLAY_TIMEOUT_MS].
- `renderGridFramesToSvg` needs the profile font size `SVG_FONT_SIZE` (14) and draws fixed 8.4x18 px cells, so equal input gives byte-identical output [svg.ts:renderGridFramesToSvg]. It always embeds the JetBrains Mono subset, and embeds each other bundled face only when a glyph needs it [svg.ts:embeddedFontAssets]. Output past `defaultMaxSvgOutputLength` of the V8 heap limit (the heap limit divided by 8 bytes, at most `MAX_SVG_OUTPUT_LENGTH`) fails with `EXPORT_ERROR` [svg.ts:defaultMaxSvgOutputLength].

## Side Effects

- `generateAsciicast`: none found in code. It returns the NDJSON text in `contents`.
- `renderGridFramesToSvg`: none found in code. It returns the SVG text.
- `generateWebmExport` creates a temporary video directory with `mkdtemp` under `os.tmpdir()` (prefix `agent-tty-webm-`) and sets its mode to `0o700` [webm.ts:generateWebmExport].
- It builds the replay input with `buildReplayInput` from `src/host/replay.ts` and the profile with `resolveProfile` from `src/renderer/profiles.ts` [webm.ts:generateWebmExport].
- The default backend is a `GhosttyWebBackend` that records video into the temporary directory [webm.ts:createDefaultBackend].
- The `.webm` file is written only by `backend.finalizeVideo(outputPath)`. `backend.recordedMissingGlyphs()` runs before it, because `finalizeVideo` closes the page that the glyph check probes [webm.ts:generateWebmExport].
- In `finally` it awaits `backend.dispose()` without a catch, so dispose errors propagate. Then it removes the temporary directory with `rm({ recursive: true, force: true })` and ignores `rm` errors. A throwing `dispose()` skips the `rm` [webm.ts:generateWebmExport].

## Verification

- Run: `npx vitest run test/unit/export test/unit/commands/record-export.test.ts`
- Run (integration): `npx vitest run --maxWorkers=1 test/integration/record-export.test.ts`
- Run (e2e, needs Playwright Chromium from `mise run bootstrap`): `npx vitest run --maxWorkers=1 test/e2e/export-fixtures.test.ts`
- Run: `npm run typecheck`
