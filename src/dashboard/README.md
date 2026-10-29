# src/dashboard

## Overview

The Session Dashboard is an Ink/React terminal UI that lists the Sessions in a home and shows a Live View of the selected Session. The Live View tails the Session's `events.jsonl` and replays it through a renderer backend, then projects the semantic snapshot into the dashboard pane. The only caller is the `dashboard` command in `src/cli/commands/dashboard.ts`. That command imports `app.tsx` lazily, so Ink and React load only on that path.

## Interface

- `runDashboardApp(options)`: entry point. Renders the Ink `App` and resolves when the app exits. `DashboardAppOptions` comes from `src/cli/commands/dashboard.ts`, not from this directory. [app.tsx:runDashboardApp]
- `EventLogTailSource`: class that implements `SessionEventSource`. `poll()` returns the Event Log records appended since the last poll. [eventSource.ts:EventLogTailSource]
- `SessionEventSource`, `SessionEventBatch`, `SessionEventSourceState` (`'pending' | 'active' | 'collected'`): source contract and batch shape. `EventRecord` comes from `src/protocol/schemas.ts`. [eventSource.ts:SessionEventSource] [eventSource.ts:SessionEventBatch] [eventSource.ts:SessionEventSourceState]
- `LiveViewFollower`: class with `ingest()`, `render(): Promise<boolean>`, a `frame` getter and `dispose()`. It accumulates events and replays them to the latest `seq`. [liveViewFollower.ts:LiveViewFollower]
- `FollowRendererBackend`, `LiveViewStatus` (`'pending' | 'following' | 'exited' | 'collected'`), `LiveViewExit`, `LiveViewFrame`, `LiveViewFollowerOptions`: follower types. The backend type is the renderer subset (`boot`, `replayTo`, `snapshot`, `dispose`) that the follower drives. [liveViewFollower.ts:FollowRendererBackend] [liveViewFollower.ts:LiveViewStatus] [liveViewFollower.ts:LiveViewFrame]
- `projectLiveView(input)`: pure function. Clips and pans the snapshot (`'one-to-one'`) or downsamples it to shade glyphs (`'overview'`). [liveViewProjection.ts:projectLiveView]
- `LiveViewMode`, `PaneSize`, `PanOffset`, `ProjectedCell`, `TruncationFlags`, `ProjectedView`, `ProjectLiveViewInput`: projection types. [liveViewProjection.ts:LiveViewMode] [liveViewProjection.ts:ProjectedView]
- `listWidthFor`, `paneLayout`, `PaneLayout`, `shortId`, `formatSessionId`, and the constants `MIN_LIST_WIDTH`, `MAX_LIST_WIDTH`, `PANE_BORDER`, `PANE_RIGHT_SLACK`, `PANE_LIST_GAP`: session list and pane geometry. [sessionListLayout.ts:paneLayout] [sessionListLayout.ts:listWidthFor] [sessionListLayout.ts:formatSessionId]
- `listDashboardSessions(home, scope)`, `DashboardSession`, `DashboardScope` (`'active' | 'all'`): Session list for a scope, newest first. `src/cli/commands/dashboard.ts` imports `DashboardScope`. [sessionScope.ts:listDashboardSessions] [sessionScope.ts:DashboardScope]

## Invariants

- `EventLogTailSource` decodes only newline-terminated lines and keeps a partial trailing line buffered. It validates each line with `EventRecordSchema.safeParse` and skips invalid lines without throwing. [eventSource.ts:EventLogTailSource]
- `poll()` maps `ENOENT` to `'collected'` when the log was seen before, else to `'pending'`. It resets the read offset when the file shrinks. Other `stat` errors are rethrown. [eventSource.ts:EventLogTailSource]
- `render()` returns `false` when the target `seq` is not ahead of the rendered `seq`, when no events are buffered, or after the source reported the Event Log as `collected`. A collected follower never renders again. A comment states that the backend rejects rewinds, so the follower clears its buffered events after each replay. [liveViewFollower.ts:LiveViewFollower]
- The doc comment states that the projection never reflows or stretches, and that the dashboard never resizes the Session. One-to-one mode clamps the pan to the snapshot bounds. Overview mode uses `scale = max(1, ceil(snapshot / pane))` on each axis. [liveViewProjection.ts:projectLiveView]
- `paneLayout` keeps the pane at least 10 columns by 4 rows (`MIN_PANE_COLS`, `MIN_PANE_ROWS`). `listWidthFor` clamps the list width to `MIN_LIST_WIDTH`..`MAX_LIST_WIDTH`. [sessionListLayout.ts:paneLayout] [sessionListLayout.ts:listWidthFor]
- Scope `'all'` drops Sessions with status `destroyed`. Replay dimensions fall back from `creationCols`/`creationRows` to `cols`/`rows` to 80x24 (`DEFAULT_COLS`, `DEFAULT_ROWS`). Results sort by `createdAt`, descending. [sessionScope.ts:listDashboardSessions]

## Side Effects

- `EventLogTailSource.poll()` reads the Event Log with `node:fs/promises` `stat` and `open`/`read`/`close`. [eventSource.ts:EventLogTailSource]
- `listDashboardSessions` reads manifests through `listSessions` (`src/host/lifecycle.ts`) and `readManifestIfExists` (`src/storage/manifests.ts`). `listSessions` calls `reconcileSession` for active Sessions, and that function can rewrite a manifest with `writeManifest` and remove the socket file. [sessionScope.ts:listDashboardSessions]
- `runDashboardApp` renders to the terminal with Ink `render()` and waits for `waitUntilExit()`. `App` reads keys with `useInput`, and `q` or Ctrl-C calls `exit()`. [app.tsx:runDashboardApp] [app.tsx:App]
- `useFollower` polls with `setInterval` every 33 ms (`FRAME_INTERVAL_MS`) and creates a `libghostty-vt` renderer backend with `createRendererBackend` and the `reference-dark` profile. Cleanup aborts, clears the interval and disposes the follower. [app.tsx:useFollower]
- `App` refreshes the Session list with `setInterval` every 1500 ms (`LIST_REFRESH_MS`) and calls `listRegisteredHomes` (`src/storage/homeScope.ts`) for the home picker. [app.tsx:App]
- `liveViewFollower.ts` has no direct I/O. `liveViewProjection.ts` and `sessionListLayout.ts` are pure.

## Verification

- Run: `npx vitest run test/unit/dashboard`
- Run: `npm run typecheck`
