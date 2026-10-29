# src/renderer/ghosttyWeb

## Overview

This directory holds the `ghostty-web` reference renderer. `GhosttyWebBackend` starts headless Chromium through Playwright and loads an HTML harness that runs the `ghostty-web` terminal. The backend replays session events into the page, then reads semantic snapshots, PNG screenshots and WebM videos back out. `harnessDecoding.ts` validates the data that the browser harness returns. `embeddedHarnessHtml.ts` holds the harness page that the backend serves at runtime.

## Interface

- `GhosttyWebBackend` [backend.ts:GhosttyWebBackend]: implements `VideoCapableRendererBackend` from `src/renderer/backend.ts`. Its `rendererBackend` is `'ghostty-web'`. It is re-exported by [index.ts:GhosttyWebBackend].
  - `constructor(sessionId, profile, videoOptions?, logger?)` [backend.ts:GhosttyWebBackend.constructor].
  - `boot()`, `replayTo(input)` and `replayWithTiming(input, timing)` [backend.ts:GhosttyWebBackend.replayWithTiming]. Timing modes are `accelerated`, `recorded` and `max-speed`.
  - `snapshot(options?)` returns a `SemanticSnapshot` [backend.ts:GhosttyWebBackend.snapshot].
  - `screenshot(outputPath, options?)` returns a `ScreenshotResult` with `sha256` and `renderProfileHash` [backend.ts:GhosttyWebBackend.screenshot].
  - `finalizeVideo(outputPath)`, `getVisibleText()` and `dispose()` [backend.ts:GhosttyWebBackend.finalizeVideo].
- `assembleCanonicalLine`, `stripTrailingAsciiSpaces` and type `GhosttyDecodedColumn` are re-exported from `harnessDecoding.ts` [backend.ts:GhosttyDecodedColumn].
- Harness snapshot types: `GhosttyHarnessVisibleLine`, `GhosttyHarnessSnapshotCell`, `GhosttyHarnessRichLine`, `GhosttyHarnessSnapshot` and `GhosttyDecodedColumn` [harnessDecoding.ts:GhosttyHarnessSnapshot].
- `validateHarnessSnapshot(value)` checks an unknown harness payload and returns a `GhosttyHarnessSnapshot` [harnessDecoding.ts:validateHarnessSnapshot].
- `stripTrailingAsciiSpaces(text)` and `assembleCanonicalLine(cols, readColumn)` build canonical line text [harnessDecoding.ts:assembleCanonicalLine].
- Assertion helpers `assertNonNegativeInteger`, `assertPositiveInteger`, `assertPositiveNumber` and `assertHexColor`, plus `normalizeError(error, prefix)` [harnessDecoding.ts:normalizeError].
- `loadHarnessHtml()` returns `EMBEDDED_HARNESS_HTML` [harnessDecoding.ts:loadHarnessHtml].
- `EMBEDDED_HARNESS_HTML` is the harness page as a template string. In the browser it defines `window.__agentTty` with `write`, `getSnapshot`, `getVisibleText`, `isReady`, `resize` and `setCursorVisible` [embeddedHarnessHtml.ts:EMBEDDED_HARNESS_HTML].
- `harness.html` is a standalone copy of the harness page. No code serves it, and it differs from `EMBEDDED_HARNESS_HTML` [harnessDecoding.ts:loadHarnessHtml].
- `assets/` (not documented separately): holds the bundled fonts `JetBrainsMono-Regular-latin.woff2` and `SymbolsNerdFontMono-Regular.ttf` plus `FONT-LICENSE.txt`. `src/renderer/bundledFont.ts` loads them, and `scripts/copy-renderer-assets.mjs` copies them into `dist/` during `npm run build`.

## Invariants

- The constructor asserts a non-empty `sessionId`, `profile.name` and `profile.fontFamily`, a positive `fontSize`, and hex colors. With `videoOptions`, `outputDir` must be absolute and the size must use positive integers [backend.ts:GhosttyWebBackend.constructor].
- Replay cannot rewind: `targetSeq` must be >= the last applied seq. The initial dimensions cannot change after the first replay. `input.sessionId` must match the backend [backend.ts:GhosttyWebBackend.replayTo].
- `replayWithTiming` asserts strictly increasing seqs and non-decreasing timestamps [backend.ts:GhosttyWebBackend.replayWithTiming].
- `snapshot()` and `screenshot()` throw until `replayTo()` or `replayWithTiming()` has run once (`lastAppliedSeq >= 0`). A replay over zero events also sets `lastAppliedSeq` to `targetSeq` [backend.ts:GhosttyWebBackend.snapshot].
- `screenshot()` requires an absolute `outputPath` whose parent directory exists. It checks that the output is a non-empty PNG with a valid signature and an `IHDR` first chunk [backend.ts:GhosttyWebBackend.screenshot].
- `finalizeVideo()` requires video recording to be enabled and an absolute `outputPath` that ends in `.webm` [backend.ts:GhosttyWebBackend.finalizeVideo].
- After a page crash, page error or browser disconnect, every later page operation throws [backend.ts:GhosttyWebBackend.requireOperationalPage].
- Output batches sent to the page hold at most `MAX_REPLAY_BATCH_SIZE` (1000) chunks [backend.ts:MAX_REPLAY_BATCH_SIZE].
- Boot waits up to 30 s for `__agentTty.isReady()` [backend.ts:GhosttyWebBackend.bootInternal].
- The screenshot paint wait times out after `RAF_TIMEOUT_MS` (5 s) [backend.ts:RAF_TIMEOUT_MS].
- The page may only load `data:` URLs, `blob:` URLs and URLs from the local server origin [backend.ts:GhosttyWebBackend.isAllowedBrowserRequest].
- A code comment cites ADR 0003: `dispose()` resolves even when cleanup fails, and it logs the failure [backend.ts:GhosttyWebBackend.closeResourceScopeAndLog].
- `validateHarnessSnapshot` asserts positive `cols` and `rows`, a cursor inside the grid, `visibleLines.length <= rows`, strictly increasing line rows, and one cell line per visible line with at most `cols` cells [harnessDecoding.ts:validateHarnessSnapshot].
- Doc comments: `stripTrailingAsciiSpaces` and `assembleCanonicalLine` must stay in sync with their copies inside `EMBEDDED_HARNESS_HTML` [harnessDecoding.ts:stripTrailingAsciiSpaces].
- A code comment calls the embedded harness the canonical runtime copy, even when the standalone template drifts [harnessDecoding.ts:loadHarnessHtml].

## Side Effects

- Reads the `ghostty-web` package files (`ghostty-web.js`, its browser-external helper and `ghostty-vt.wasm`) with `fs/promises` once per process [backend.ts:getServedAssets].
- Starts a `node:http` server on `127.0.0.1` with an ephemeral port. It serves the harness, the `ghostty-web` assets and the bundled fonts for `GET` and `HEAD` [backend.ts:GhosttyWebBackend.startServer].
- Calls `ensurePlaywrightBrowsersPath()`, which can set `process.env.PLAYWRIGHT_BROWSERS_PATH`. Then it launches headless Chromium with `chromium.launch` [backend.ts:GhosttyWebBackend.bootInternal].
- Calls `page.evaluate` on `window.__agentTty` to write output, resize and read snapshots [backend.ts:GhosttyWebBackend.writeBatchBridge].
- `screenshot()` writes the PNG through Playwright `locator('#terminal').screenshot`, then reads it back to hash it [backend.ts:GhosttyWebBackend.screenshot].
- With `videoOptions`, Playwright records into `outputDir`. `finalizeVideo()` closes the page and context and calls `video.saveAs(outputPath)` [backend.ts:GhosttyWebBackend.finalizeVideo].
- `dispose()` closes the page, context, browser and HTTP server [backend.ts:GhosttyWebBackend.dispose].
- Each screenshot paint wait starts a 5 s `setTimeout` that is never cleared. It keeps the event loop alive after the paint wins the race [backend.ts:GhosttyWebBackend.waitForScreenshotPaint].
- `replayWithTiming()` sleeps between frames with `setTimeout` [backend.ts:GhosttyWebBackend.replayWithTiming].
- The default logger comes from `createProcessLogger()` [backend.ts:GhosttyWebBackend.constructor].
- `harnessDecoding.ts`: none found in code.

## Verification

- Run: `npx vitest run test/unit/renderer/ghosttyWebBackend.test.ts test/unit/renderer/ghosttyWebDecode.test.ts`
- Run (integration, needs Playwright Chromium from `mise run bootstrap`): `npx vitest run --maxWorkers=1 test/integration/renderer-backend.test.ts test/integration/cross-backend-screen-hash.test.ts`
- Run: `npm run typecheck`
