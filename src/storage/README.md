# src/storage

## Overview

`src/storage` owns the on-disk layout of agent-tty. It resolves the Home directory, builds guarded paths for session files, sockets and artifacts, and reads and writes validated JSON files such as `session.json`, the artifact manifest and the cross-Home registry. `eventLogCodec.ts` is the one place that parses and validates `events.jsonl` and holds its 50 MB size limit. The host writes the event log itself through `src/host/eventLog.ts`.

## Interface

- `resolveHome(configuredHome = process.env.AGENT_TTY_HOME)` returns the absolute Home: the configured path, or `os.homedir()/.agent-tty`. It returns the real path when `realpathSync` succeeds. [home.ts:resolveHome]
- `ensureHome(configuredHome = process.env.AGENT_TTY_HOME)` resolves the Home, creates it and returns its path. [home.ts:ensureHome]
- `sessionDir(home, sessionId)`, `manifestPath(sessionDir)` and `eventLogPath(sessionDir)` return `<home>/sessions/<sessionId>`, its `session.json` and its `events.jsonl`. [sessionPaths.ts:sessionDir] [sessionPaths.ts:manifestPath] [sessionPaths.ts:eventLogPath]
- `socketPath(sessionDir)` returns `/tmp/agent-tty/<8 hex of sha256(home)>/<12 hex of sha256(sessionId)>`. [sessionPaths.ts:socketPath]
- `screenshotFilename`, `snapshotFilename`, `recordingFilename` and `videoFilename` build artifact file names that include the event sequence number, for example `screenshot-<seq>-<profile>.png` and `recording-<seq>-<format>.cast`. [artifactPaths.ts:screenshotFilename] [artifactPaths.ts:recordingFilename]
- `artifactPath(sessionDir, filename)` returns `<sessionDir>/artifacts/<filename>`. `ensureArtifactsDir(sessionDir)` creates that directory. [artifactPaths.ts:artifactPath] [artifactPaths.ts:ensureArtifactsDir]
- `readValidatedJsonFile`, `writeValidatedJsonFile` and `writeTextFileAtomic`, with their option interfaces, are the generic validated JSON and text file helpers. [manifests.ts:readValidatedJsonFile] [manifests.ts:writeValidatedJsonFile] [manifests.ts:writeTextFileAtomic]
- `readManifest`, `readManifestIfExists` and `writeManifest` read and write a `SessionRecord` (schema from `src/protocol/schemas.ts`). `readManifestIfExists` returns `null` when the file does not exist. [manifests.ts:readManifest] [manifests.ts:readManifestIfExists] [manifests.ts:writeManifest]
- `MAX_EVENT_LOG_SIZE` is 52,428,800 bytes (50 MB). `assertEventLogSize(size)` checks a size against it. [eventLogCodec.ts:MAX_EVENT_LOG_SIZE] [eventLogCodec.ts:assertEventLogSize]
- `parseEventLogContent(text)` parses JSONL text into `EventRecord[]`. `validateEventRecords(values)` validates records that are already loaded. `readEventLogRecords(filePath)` checks the file size, reads the file and parses it. `EventRecordSchema` comes from `src/protocol/schemas.ts`. [eventLogCodec.ts:parseEventLogContent] [eventLogCodec.ts:validateEventRecords] [eventLogCodec.ts:readEventLogRecords]
- `ArtifactEntrySchema` and `ArtifactManifestSchema`, with types `ArtifactEntry` and `ArtifactManifest`, describe `<sessionDir>/artifacts/manifest.json`. [artifactManifest.ts:ArtifactEntrySchema] [artifactManifest.ts:ArtifactManifestSchema]
- `readArtifactManifest(sessionDir)` returns the manifest, or an empty version 1 manifest when the file does not exist. `writeArtifactManifest` validates and writes it. [artifactManifest.ts:readArtifactManifest] [artifactManifest.ts:writeArtifactManifest]
- `appendArtifactWithRollback(options)` takes `AppendArtifactWithRollbackOptions` (`sessionDir`, `entry`, optional `rollbackArtifactPath`) and adds one entry to the manifest. If the append fails and `rollbackArtifactPath` is set, it tries to delete that file. It ignores `rm` errors. `createArtifactEntry` adds a ULID `id` and a `createdAt` time. [artifactManifest.ts:appendArtifactWithRollback] [artifactManifest.ts:AppendArtifactWithRollbackOptions] [artifactManifest.ts:createArtifactEntry]
- `computeArtifactHealth(sessionDir)` returns an `ArtifactHealthSummary` (schema from `src/protocol/messages.ts`) with the artifact count, counts by kind, missing files and a `health` value. [artifactHealth.ts:computeArtifactHealth]
- `resolveHomeRegistryPath`, `normalizeHomePath`, `createHomeRegistry`, `upsertHome`, `forgetHome` and `readHomeRegistry`, with types `HomeRegistryEntry`, `HomeRegistry` and `HomeRegistryDependencies`, manage the registry of known Homes at `${XDG_STATE_HOME:-~/.local/state}/agent-tty/homes.json`. [homeRegistry.ts:resolveHomeRegistryPath] [homeRegistry.ts:createHomeRegistry] [homeRegistry.ts:upsertHome]
- `scanHome(home)` counts the visible and active sessions in one Home. `listRegisteredHomes(scope)` lists registered Homes for scope `'active'` or `'all'`, newest first. Related types: `HomeListingScope`, `RegisteredHome`, `HomeSessionCounts`, `ScanHomeDependencies` and `ListRegisteredHomesDependencies`. [homeScope.ts:scanHome] [homeScope.ts:listRegisteredHomes] [homeScope.ts:HomeListingScope]

## Invariants

- `AGENT_TTY_HOME` must be a non-empty absolute path when set. [home.ts:resolveHome]
- `sessionDir` requires an absolute `home` and a session ID that is not empty, `.` or `..` and has no `/` or `\`. The result must be a direct child of `<home>/sessions`, and `session.json` and `events.jsonl` must be direct children of the session directory. [sessionPaths.ts:sessionDir] [sessionPaths.ts:manifestPath]
- `socketPath` asserts that the socket directory is a direct child of `/tmp/agent-tty`, that the two IDs have 8 and 12 characters, and that the session directory's parent is `<home>/sessions`. [sessionPaths.ts:socketPath]
- `artifactPath` rejects a file name that is empty or has `/` or `\`, and asserts that the result is directly inside `<sessionDir>/artifacts`. File-name builders replace unsafe characters in the profile name with `-` and require a non-negative integer `seq`. [artifactPaths.ts:artifactPath] [artifactPaths.ts:screenshotFilename]
- `assertEventLogSize` requires an integer from 0 to `MAX_EVENT_LOG_SIZE`. `readEventLogRecords` checks the size with `stat` before it reads the file. [eventLogCodec.ts:assertEventLogSize] [eventLogCodec.ts:readEventLogRecords]
- `parseEventLogContent` and `validateEventRecords` require each record to match `EventRecordSchema`, the first `seq` to be 0, and each next `seq` to be the previous one plus 1. Blank lines are skipped. [eventLogCodec.ts:parseEventLogContent] [eventLogCodec.ts:validateEventRecords]
- Read and write paths in `manifests.ts` must be non-empty and absolute. Invalid JSON and schema failures throw `MANIFEST_VALIDATION_ERROR`. Other read errors throw `STORAGE_READ_ERROR`. Write failures throw `STORAGE_WRITE_ERROR`. [manifests.ts:readValidatedJsonFile] [manifests.ts:writeTextFileAtomic] [manifests.ts:writeManifest]
- `ArtifactEntrySchema` and `ArtifactManifestSchema` are `.strict()`. `kind` is `screenshot`, `snapshot`, `recording` or `video`. `capturedAtSeq` is a non-negative integer. The manifest `version` is the literal `1`. The manifest and entry `sessionId` must equal the session directory name. [artifactManifest.ts:ArtifactEntrySchema] [artifactManifest.ts:ArtifactManifestSchema]
- `appendArtifactWithRollback` serializes appends per session directory with an in-process `KeyedSerializer` (from `src/util/keyedSerializer.ts`). Appends from two processes are not serialized. [artifactManifest.ts:appendArtifactWithRollback]
- `computeArtifactHealth` maps only `MANIFEST_VALIDATION_ERROR` to health `manifest-invalid` and rethrows other errors. It validates its result with `ArtifactHealthSummarySchema`. [artifactHealth.ts:computeArtifactHealth]
- The registry read returns `[]` on a read error, invalid JSON or a schema failure. The read checks each `homes` entry on its own and drops an invalid entry, so the valid entries survive. `resolveHomeRegistryPath` ignores an empty or relative `XDG_STATE_HOME`. [homeRegistry.ts:createHomeRegistry] [homeRegistry.ts:resolveHomeRegistryPath]
- `upsert` reads and then writes the registry with no lock. A code comment states that concurrent creates can race and drop an entry, which registers again on the next create. [homeRegistry.ts:createHomeRegistry]
- The `scanHome` doc comment states that it does not reconcile sessions, does not write manifests and does not throw. It skips destroyed sessions and unreadable manifests. [homeScope.ts:scanHome]
- `listRegisteredHomes` leaves out Homes with no visible sessions, and the `active` scope also leaves out Homes with no active session. Its doc comment states that it does not rewrite the registry file. [homeScope.ts:listRegisteredHomes]

## Side Effects

- `resolveHome` reads `process.env.AGENT_TTY_HOME` and calls `os.homedir()` and `realpathSync`. [home.ts:resolveHome]
- `ensureHome` calls `mkdir(home, { recursive: true })`. It runs `chmod(home, 0o700)` only when `mkdir` created the directory. [home.ts:ensureHome]
- `writeTextFileAtomic` creates the parent directory, writes `<path>.tmp-<uuid>` with mode `0o600`, then renames it to `<path>`. On failure it removes the temp file. It does not call `fsync`. `writeManifest`, `writeValidatedJsonFile`, `writeArtifactManifest` and the registry writes all go through it. [manifests.ts:writeTextFileAtomic]
- `readValidatedJsonFile` and `readEventLogRecords` read files with `fs.promises.readFile`. `readEventLogRecords` also calls `stat`. [manifests.ts:readValidatedJsonFile] [eventLogCodec.ts:readEventLogRecords]
- `ensureArtifactsDir` runs `mkdir(<sessionDir>/artifacts, { recursive: true })`. The other path functions are pure, and `socketPath` only hashes strings with `crypto`. [artifactPaths.ts:ensureArtifactsDir] [sessionPaths.ts:socketPath]
- `appendArtifactWithRollback` reads, changes and writes the artifact manifest. On failure it calls `rm(rollbackArtifactPath, { force: true })`. [artifactManifest.ts:appendArtifactWithRollback]
- `computeArtifactHealth` calls `fs.promises.access` on each artifact file. [artifactHealth.ts:computeArtifactHealth]
- `resolveHomeRegistryPath` reads `XDG_STATE_HOME` and calls `os.homedir()`. `upsertHome` and `forgetHome` read and write the real `homes.json`. `readHomeRegistry` only reads it. [homeRegistry.ts:resolveHomeRegistryPath] [homeRegistry.ts:upsertHome] [homeRegistry.ts:readHomeRegistry]
- `scanHome` and `listRegisteredHomes` only read: `readdir(<home>/sessions)`, each `session.json` and the registry. [homeScope.ts:scanHome] [homeScope.ts:listRegisteredHomes]

## Verification

- Run: `npx vitest run test/unit/storage`
- Run: `npx vitest run --maxWorkers=1 test/integration/socket-permissions.test.ts test/integration/host-renderer-rpc.test.ts test/integration/backend-selection.test.ts`
- Run: `npm run typecheck`
