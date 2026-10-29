# src/renderer

## Overview

This directory defines the renderer abstraction that turns replayed session events into semantic snapshots, screenshots and videos. `backend.ts` declares the `RendererBackend` contract. `types.ts` holds the Zod schemas for replay input, snapshots, screenshot results and render profiles. `registry.ts` picks a backend by name, `profiles.ts` defines the built-in render profiles, and `capabilities.ts` with `readiness.ts` report which render features are available. The two backends live in the child directories.

## Interface

- [./ghosttyWeb/README.md](./ghosttyWeb/README.md): `GhosttyWebBackend`, the reference renderer. It runs `ghostty-web` in headless Chromium through Playwright and supports snapshots, PNG screenshots and WebM video.
- [./libghosttyVt/README.md](./libghosttyVt/README.md): `LibghosttyVtBackend`, a native semantic renderer from `@coder/libghostty-vt-node`. Its screenshots go through a `ghostty-web` fallback.
- `RendererBackend`: `boot`, `replayTo`, `snapshot`, `screenshot`, `getVisibleText`, `dispose`, `rendererBackend` and `isBooted` [backend.ts:RendererBackend]. Option types `SnapshotOptions`, `ScreenshotOptions` and `VideoRecordingOptions` [backend.ts:VideoRecordingOptions].
- `VideoCapableRendererBackend` adds `replayWithTiming(input, timing)` and `finalizeVideo(outputPath)` [backend.ts:VideoCapableRendererBackend]. `ReplayTimingOptions` is the union of the exported interfaces `AcceleratedTimingOptions`, `RecordedTimingOptions` and `MaxSpeedTimingOptions` (modes `accelerated`, `recorded` and `max-speed`) [backend.ts:ReplayTimingOptions].
- Schemas and inferred types: `ReplayEventSchema` (10 event types, discriminated on `type`), `ReplayInputSchema`, `ReplayStateSchema`, `SemanticSnapshotSchema`, `TextSnapshotSchema`, `ScreenshotResultSchema`, `RenderProfileBundledFontSchema` and `RenderProfileConfigSchema` [types.ts:ReplayEventSchema]. `types.ts` re-exports `VisibleLineSchema` from `src/protocol/schemas.ts`.
- `RendererNameSchema` (`'ghostty-web'`, `'libghostty-vt'`), `resolveRendererName`, and the defaults `DEFAULT_RENDERER_NAME`, `DEFAULT_SEMANTIC_RENDERER_NAME` and `DEFAULT_VISUAL_RENDERER_NAME` [names.ts:RendererNameSchema].
- `createRendererBackend(rendererName, sessionId, profile, options?)` returns a backend instance. `RendererRegistryOptions` can override the `libghostty-vt` loader [registry.ts:createRendererBackend].
- `BUILTIN_PROFILE_NAMES` (`reference-dark`, `reference-light`), `REFERENCE_PROFILE_FONT_STACK`, `getBuiltinProfile`, `resolveProfile` and `hashProfile` [profiles.ts:resolveProfile].
- `canonicalVisibleLines`, `canonicalVisibleText` and `computeScreenHash` derive the canonical visible text and its SHA-256 Screen Hash [canonicalScreen.ts:computeScreenHash].
- `iterateInRangeReplayEvents(input, lastAppliedSeq)` yields the events of a `ReplayInput` in `(lastAppliedSeq, input.targetSeq]` [replayEvents.ts:iterateInRangeReplayEvents].
- `resolvePlaywrightBrowsersPath`, `resolveDefaultPlaywrightBrowsersPath` and `ensurePlaywrightBrowsersPath` locate the Playwright browser cache [browserPath.ts:ensurePlaywrightBrowsersPath]. Types: `PlaywrightBrowsersPathSource` (`env` or `captured-home`), `PlaywrightBrowsersPathResolution` and `ResolvePlaywrightBrowsersPathOptions` [browserPath.ts:PlaywrightBrowsersPathResolution].
- Bundled font constants and `getBundledFontAssetByIdentity`: `BUNDLED_FONT_ASSETS`, `BUNDLED_FONT_FAMILY`, `BUNDLED_SYMBOLS_FONT_FAMILY`, `BUNDLED_FONT_ROUTE`, `BUNDLED_PRIMARY_FONT_ASSET` and others [bundledFont.ts:getBundledFontAssetByIdentity].
- `discoverCapabilities(mode, deps?)` returns one `CapabilityEntry` per capability name. `mode` is `'quick'` or `'full'` [capabilities.ts:discoverCapabilities]. The exported types are `DiscoveryMode` and `CapabilityDiscoveryDependencies`, which lets callers replace the probes [capabilities.ts:CapabilityDiscoveryDependencies]. Callers are `src/cli/commands/version.ts` and `src/cli/commands/doctor.ts`.
- Capability schemas: `CapabilityNameSchema` (`snapshot`, `wait`, `screenshot`, `record-export-asciicast`, `record-export-webm`, `dashboard`), `CapabilityStatusSchema` (`available`, `unavailable`, `degraded`, `unknown`), `CapabilityEntrySchema`, `RendererRuntimeModeSchema`, `RendererRuntimeStatusSchema` and `RendererRuntimeSummarySchema` [capabilities.ts:CapabilityNameSchema].
- `probeLibghosttyVt`, `assertDashboardRendererAvailable`, `buildDashboardCapability`, `LIBGHOSTTY_VT_PACKAGE` and `DASHBOARD_RENDERER_UNAVAILABLE_MESSAGE` [readiness.ts:probeLibghosttyVt]. Types: `LibghosttyVtProbe` and `LibghosttyVtLoader` [readiness.ts:LibghosttyVtProbe].
- `index.ts` is a barrel for the profile, schema, name and registry exports, the `RendererBackend` and `SnapshotOptions` types, and `GhosttyWebBackend`. It does not re-export `browserPath`, `bundledFont`, `canonicalScreen`, `replayEvents`, `capabilities` or `readiness` [index.ts:createRendererBackend].

## Invariants

- All schemas in `types.ts` are `.strict()`. Every replay event has a non-negative integer `seq` and an ISO `ts` [types.ts:ReplayEventSchema].
- `ReplayInputSchema` rejects events whose `seq` values are not strictly increasing [types.ts:ReplayInputSchema].
- `RenderProfileConfigSchema` requires hex colors, a positive `fontSize`, `theme` `dark` or `light`, and `cursorStyle` `block`, `bar` or `underline`. It rejects repeated font asset identities or routes [types.ts:RenderProfileConfigSchema].
- Doc comment: `iterateInRangeReplayEvents` enforces the seq rules that every backend shares. Seqs are non-negative and strictly increasing, events at or below `lastAppliedSeq` are skipped, and iteration stops past `targetSeq` [replayEvents.ts:iterateInRangeReplayEvents].
- Doc comment: the canonical visible text comes only from `visibleLines[].text` with no trim, pad or normalize. It must not read `getVisibleText()` or `cells[]` [canonicalScreen.ts:canonicalVisibleLines].
- `resolveRendererName` throws for any name other than `ghostty-web` or `libghostty-vt` [names.ts:resolveRendererName].
- `createRendererBackend` asserts a non-empty `sessionId` and `profile.name` [registry.ts:createRendererBackend].
- `profiles.ts` validates every built-in profile when the module loads. Profiles must reference bundled fonts by identity and route [profiles.ts:assertRenderProfileConfig].
- `hashProfile` hashes a fixed-key-order JSON form with SHA-256 and asserts a 64-character lowercase hex result [profiles.ts:hashProfile].
- `getBuiltinProfile` and `resolveProfile` return deep clones. `resolveProfile` throws for an unknown name [profiles.ts:resolveProfile].
- The bundled font registry must be non-empty, without duplicates, and must contain the JetBrains Mono and Symbols Nerd Font Mono assets [bundledFont.ts:BUNDLED_FONT_ASSETS].
- `resolvePlaywrightBrowsersPath` order: a non-empty `PLAYWRIGHT_BROWSERS_PATH` wins. Otherwise it uses the captured `HOME` cache, but only if it holds a `chromium*` directory. Otherwise it returns `null`. Doc comment: the function does not mutate the environment [browserPath.ts:resolvePlaywrightBrowsersPath].
- `discoverCapabilities` sorts the entries into the fixed `CAPABILITY_NAMES` order [capabilities.ts:discoverCapabilities]. It then asserts that each of the six capability names appears exactly once and that each entry passes `CapabilityEntrySchema`. No assertion checks the order [capabilities.ts:validateDiscoveredCapabilities].
- Doc comment: `quick` mode launches no browser [capabilities.ts:discoverCapabilities].
- Doc comment: the dashboard never falls back to the browser renderer (ADR 0006) and must fail fast [readiness.ts:LIBGHOSTTY_VT_PACKAGE]. `assertDashboardRendererAvailable` throws an `INVALID_INPUT` CLI error [readiness.ts:assertDashboardRendererAvailable].

## Side Effects

- `browserPath.ts` reads `process.env.HOME` when the module loads [browserPath.ts:CAPTURED_PROCESS_HOME].
- `resolvePlaywrightBrowsersPath` reads `PLAYWRIGHT_BROWSERS_PATH` and calls `readdirSync` on the browser cache [browserPath.ts:resolvePlaywrightBrowsersPath].
- `ensurePlaywrightBrowsersPath` sets `PLAYWRIGHT_BROWSERS_PATH` in the environment when the path came from the captured `HOME` [browserPath.ts:ensurePlaywrightBrowsersPath].
- `bundledFont.ts` reads and hashes the two font files under `ghosttyWeb/assets/` with `readFileSync` when the module loads [bundledFont.ts:BUNDLED_FONT_ASSETS].
- `createRendererBackend` runs a dynamic `import('./libghosttyVt/backend.js')` for `libghostty-vt` [registry.ts:createRendererBackend].
- `discoverCapabilities` calls `ensurePlaywrightBrowsersPath()` and runs a dynamic `import('playwright')`. It does not launch a browser [capabilities.ts:probePlaywrightAvailability].
- `probeLibghosttyVt` runs a dynamic `import('@coder/libghostty-vt-node')` by default [readiness.ts:defaultLoader].
- The child backends start Chromium or load the native module. See their READMEs.

## Verification

- Run: `npx vitest run test/unit/renderer`
- Run (integration): `npx vitest run --maxWorkers=1 test/integration/backend-selection.test.ts test/integration/renderer-backend.test.ts`
- Run: `npm run typecheck`
