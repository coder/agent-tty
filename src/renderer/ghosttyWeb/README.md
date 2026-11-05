# src/renderer/ghosttyWeb

## Overview

This directory holds the `ghostty-web` reference renderer. `GhosttyWebBackend` starts headless Chromium through Playwright and loads an HTML harness that runs the `ghostty-web` terminal. The backend replays session events into the page, then reads semantic snapshots, PNG screenshots and WebM videos back out. `harnessDecoding.ts` validates the data that the browser harness returns. `embeddedHarnessHtml.ts` holds the harness page that the backend serves at runtime.

## Interface

- `GhosttyWebBackend` [backend.ts:GhosttyWebBackend]: implements `VideoCapableRendererBackend` from `src/renderer/backend.ts`. Its `rendererBackend` is `'ghostty-web'`. It is re-exported by [index.ts:GhosttyWebBackend].
  - `constructor(sessionId, profile, videoOptions?, logger?)` [backend.ts:GhosttyWebBackend.constructor].
  - `boot()`, `replayTo(input)` and `replayWithTiming(input, timing)` [backend.ts:GhosttyWebBackend.replayWithTiming]. Timing modes are `accelerated`, `recorded` and `max-speed`.
  - `snapshot(options?)` returns a `SemanticSnapshot` [backend.ts:GhosttyWebBackend.snapshot].
  - `screenshot(outputPath, options?)` returns a `ScreenshotResult` with `sha256`, `renderProfileHash` and `missingGlyphs` [backend.ts:GhosttyWebBackend.screenshot].
  - `recordedMissingGlyphs()` returns the boxed code points of every frame that `replayWithTiming()` painted [backend.ts:GhosttyWebBackend.recordedMissingGlyphs].
  - `finalizeVideo(outputPath)`, `getVisibleText()` and `dispose()` [backend.ts:GhosttyWebBackend.finalizeVideo].
- `assembleCanonicalLine`, `stripTrailingAsciiSpaces` and type `GhosttyDecodedColumn` are re-exported from `harnessDecoding.ts` [backend.ts:GhosttyDecodedColumn].
- Harness snapshot types: `GhosttyHarnessVisibleLine`, `GhosttyHarnessSnapshotCell`, `GhosttyHarnessRichLine`, `GhosttyHarnessSnapshot` and `GhosttyDecodedColumn` [harnessDecoding.ts:GhosttyHarnessSnapshot].
- `missingGlyphs.ts`: `GlyphCheck.forProfile(profile)` returns a check, or `null` when the font stack does not start with a bundled font. `screen(page, grid)` takes one grapheme string per viewport cell and returns the boxed code points with their cells. `graphemes(page, graphemes, complete)` returns the boxed code points of a set of graphemes, without cells. A grapheme is a candidate unless one bundled family covers all of it in every face, also after NFC or NFD normalization. The spaces that HarfBuzz draws blank (U+00A0, U+2000-U+200A, U+202F, U+205F, U+3000) count as covered. Each candidate is probed whole, plus one probe text per code point that no bundled face has (a combining mark on its base). `probeUsedFonts(page, font, texts)` asks Chromium through CDP `CSS.getPlatformFontsForNode` which fonts draw each text, one block-level hidden span per text [missingGlyphs.ts:GlyphCheck].
- `validateHarnessSnapshot(value)` checks an unknown harness payload and returns a `GhosttyHarnessSnapshot` [harnessDecoding.ts:validateHarnessSnapshot].
- `stripTrailingAsciiSpaces(text)` and `assembleCanonicalLine(cols, readColumn)` build canonical line text [harnessDecoding.ts:assembleCanonicalLine].
- Assertion helpers `assertNonNegativeInteger`, `assertPositiveInteger`, `assertPositiveNumber` and `assertHexColor`, plus `normalizeError(error, prefix)` [harnessDecoding.ts:normalizeError].
- `loadHarnessHtml()` returns `EMBEDDED_HARNESS_HTML` [harnessDecoding.ts:loadHarnessHtml].
- `EMBEDDED_HARNESS_HTML` is the harness page as a template string. In the browser it defines `window.__agentTty` with `write`, `getSnapshot`, `getCellGraphemes`, `getVisibleText`, `isReady`, `resize` and `setCursorVisible` [embeddedHarnessHtml.ts:EMBEDDED_HARNESS_HTML].
- `harness.html` is a standalone copy of the harness page. No code serves it, and it differs from `EMBEDDED_HARNESS_HTML` [harnessDecoding.ts:loadHarnessHtml].
- `assets/` (not documented separately): holds the bundled fonts `JetBrainsMono-Regular-latin.woff2`, `SymbolsNerdFontMono-Regular.ttf`, `NotoSansSymbols2-Regular.woff2` and `NotoSansMath-Regular.woff2`, plus `FONT-LICENSE.txt` and the OFL texts of the Noto fonts. `scripts/subset-symbol-fonts.sh` rebuilds the two Noto subsets. `src/renderer/bundledFont.ts` loads them, and `scripts/copy-renderer-assets.mjs` copies them into `dist/` during `npm run build`.

## Invariants

- The constructor asserts a non-empty `sessionId`, `profile.name` and `profile.fontFamily`, a positive `fontSize`, and hex colors. With `videoOptions`, `outputDir` must be absolute and the size must use positive integers [backend.ts:GhosttyWebBackend.constructor].
- Replay cannot rewind: `targetSeq` must be >= the last applied seq. The initial dimensions cannot change after the first replay. `input.sessionId` must match the backend [backend.ts:GhosttyWebBackend.replayTo].
- `replayWithTiming` asserts strictly increasing seqs and non-decreasing timestamps [backend.ts:GhosttyWebBackend.replayWithTiming].
- `replayWithTiming` waits until each event's place on a schedule built from the recorded gaps: `recorded` keeps them, `accelerated` caps each at `maxGapMs`, and `max-speed` sets them to 0. It measures that schedule with `performance.now()`, so frame holds and bridge calls use up idle time instead of adding to it. In `recorded` and `accelerated` mode it flushes pending output once the next event is at least one frame hold after the batch's first output, unless the replay runs behind the schedule, in which case the batch grows until it catches up. `max-speed` flushes once per run of output events [backend.ts:GhosttyWebBackend.replayWithTiming].
- `snapshot()` and `screenshot()` throw until `replayTo()` or `replayWithTiming()` has run once and set the initial size. Both replays accept `targetSeq` -1 for an empty Event Log. A replay over zero events sets `lastAppliedSeq` to `targetSeq` [backend.ts:GhosttyWebBackend.snapshot].
- `missingGlyphs` lists a code point only when a bundled face that lacks it drew it. Chromium draws a cluster with one font: the first stack font that covers all of it, or else the first font of the stack, which is bundled in both built-in profiles and then draws `.notdef` boxes. CDP names the face that drew a probe by its PostScript name, so a family alias or several faces under one family resolve to the right cmap. When one bundled face drew the whole grapheme, every code point that face lacks is listed. A probe with no reported font is judged against every face of the first family. When the grapheme is split over several fonts, each uncovered code point is judged by its own probe, and a mark's probe on its base is compared with a probe of the base alone. Glyphs that a host font draws are not listed. The check runs after the PNG is written, removes its probe spans, and caches each probe text's result for the page, clearing the cache when it would pass `MAX_CACHED_GLYPH_PROBES` (16384) entries. It probes at most `MAX_GLYPH_PROBES` texts and lists at most `MAX_MISSING_GLYPH_CELLS` cells (4096 each). `probeUsedFonts` sends its CDP queries in batches of 256 and stops starting batches after `GLYPH_PROBE_BUDGET_MS` (1000 ms). The result sets `missingGlyphsTruncated` when any of these stops the check early. Family names match without regard to case. A web font whose PostScript name the profile does not bundle fails the check. A failed check is logged at debug level and leaves the field out, so the screenshot still succeeds. `replayWithTiming()` records the viewport graphemes in the page after each output batch and each resize (at most `MAX_CACHED_GLYPH_PROBES`), and the final frame hold judges them once, with the hold as the probe budget, so the check does not lengthen the video. `recordedMissingGlyphs()` returns that result. A failed note or check leaves the record export fields out. A profile whose font stack does not start with a bundled font gets no `missingGlyphs` field [missingGlyphs.ts:probeUsedFonts] [backend.ts:GhosttyWebBackend.screenshot].
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
