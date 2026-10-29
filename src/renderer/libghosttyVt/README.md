# src/renderer/libghosttyVt

## Overview

This directory holds the `libghostty-vt` renderer backend. `LibghosttyVtBackend` feeds session events into a native terminal from the optional package `@coder/libghostty-vt-node` and returns semantic snapshots and visible text. It has no native screenshot path: `screenshot()` hands the work to a separate `ghostty-web` backend. The backend validates the terminal, snapshot and visible-text values that the native module returns. It passes the `getNativeInfo()` result to the debug log without validation.

## Interface

- `LibghosttyVtBackend` [backend.ts:LibghosttyVtBackend]: implements `RendererBackend` from `src/renderer/backend.ts`. Its `rendererBackend` is `'libghostty-vt'`. It is re-exported by [index.ts:LibghosttyVtBackend].
  - `constructor(sessionId, profile, options?)` [backend.ts:LibghosttyVtBackend.constructor]. Defaults: `DEFAULT_COLS`/`DEFAULT_ROWS` from `src/config/defaults.ts` and a scrollback limit of `DEFAULT_SCROLLBACK_LIMIT` (10,000) [backend.ts:DEFAULT_SCROLLBACK_LIMIT].
  - `boot()` loads the native module on first call. Concurrent calls share one boot promise [backend.ts:LibghosttyVtBackend.boot].
  - `replayTo(input)` feeds `output` events and applies `resize` events. It skips input, marker, run, signal and exit events [backend.ts:LibghosttyVtBackend.replayTo].
  - `snapshot(options?)` returns a `SemanticSnapshot` parsed by `SemanticSnapshotSchema` [backend.ts:LibghosttyVtBackend.snapshot].
  - `screenshot(outputPath, options?)` boots a fallback backend, replays the last replay input into it, takes the screenshot, and disposes the fallback [backend.ts:LibghosttyVtBackend.screenshot].
  - `getVisibleText()` and `dispose()` [backend.ts:LibghosttyVtBackend.dispose].
- `LibghosttyVtBackendOptions`: `initialCols`, `initialRows`, `scrollbackLimit`, `loadNative`, `fallbackFactory` and `logger` [backend.ts:LibghosttyVtBackendOptions]. Re-exported as a type by `index.ts`.
- `LibghosttyVtNativeModule`: the shape the backend expects from the native package, `createTerminal(options)` and optional `getNativeInfo()` [backend.ts:LibghosttyVtNativeModule]. Re-exported as a type by `index.ts`.

## Invariants

- The constructor asserts a non-empty `sessionId` and `profile.name`, positive integer dimensions, a non-negative integer `scrollbackLimit`, and a `Logger` instance [backend.ts:LibghosttyVtBackend.constructor].
- After `dispose()`, `boot()`, `screenshot()` and every terminal method throw [backend.ts:LibghosttyVtBackend.assertNotDisposed].
- Replay cannot rewind: `targetSeq` must be >= the last applied seq. The initial dimensions cannot change after the first replay. `input.sessionId` must match the backend [backend.ts:LibghosttyVtBackend.replayTo].
- `snapshot()` requires a prior `replayTo()`. The native snapshot's `cols` and `rows` must equal the tracked dimensions [backend.ts:LibghosttyVtBackend.assertSnapshotDimensions].
- `screenshot()` requires a prior `replayTo()` and an absolute `outputPath` [backend.ts:LibghosttyVtBackend.screenshot].
- The screenshot fallback must use a different `rendererBackend`. If the fallback fails to boot, the backend tries to dispose it and rethrows the boot error [backend.ts:LibghosttyVtBackend.createFallbackBackend].
- The native terminal must expose `feed`, `resize`, `snapshot`, `getVisibleText` and `dispose` functions [backend.ts:LibghosttyVtBackend.assertTerminalShape].
- Native snapshots must have positive dimensions, a cursor inside the grid, at most `rows` visible lines, and strictly increasing line rows [backend.ts:assertNativeSnapshot].
- Doc comment: visible lines are padded to `rows` so the Screen Hash agrees with the `ghostty-web` backend [backend.ts:padVisibleLinesToRows].
- Doc comment: `cells[col]` is the cell at terminal column `col`. A wide glyph adds spacer cells that keep its style (coder/agent-tty#112) [backend.ts:mapNativeCells].

## Side Effects

- `boot()` runs a dynamic `import('@coder/libghostty-vt-node')` unless `loadNative` is given. A load or create failure throws an error that suggests `--renderer ghostty-web` [backend.ts:LibghosttyVtBackend.bootInternal].
- `replayTo()` mutates the native terminal with `feed` and `resize`. `dispose()` calls the native `dispose` [backend.ts:LibghosttyVtBackend.replayTo].
- `screenshot()` creates a `GhosttyWebBackend` (headless Chromium) by default. That backend writes the PNG. This module writes no files itself [backend.ts:LibghosttyVtBackend.screenshot].
- Logs native info at debug level through the logger from `createProcessLogger()` by default [backend.ts:LibghosttyVtBackend.bootInternal].

## Verification

- Run: `npx vitest run test/unit/renderer/libghosttyVtBackend.test.ts`
- Run (integration): `npx vitest run --maxWorkers=1 test/integration/cross-backend-screen-hash.test.ts`
- Run: `npm run typecheck`
