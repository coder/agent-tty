# src/cli/commands

## Overview

This directory holds one handler module per agent-tty CLI command. `src/cli/main.ts` registers the commands and calls these `run<Name>Command` functions with a `CommandContext`. The input and control commands (`type`, `paste`, `run`, `send-keys`, `mark`, `resize`, `signal` and `batch`) find the session with `resolveCommandTarget`. `inspect`, `wait`, `snapshot`, `screenshot`, `record export` and `record diff` read the manifest directly with `readManifestIfExists`. Session commands send an RPC to the session host socket through `sendRpc` (`src/host/rpcClient.ts`). `snapshot`, `screenshot` and render-mode `wait` fall back to offline replay when the host is unreachable. Every handler except `dashboard` (and non-JSON `skills get` and `skills path`, which write with `process.stdout.write`) writes its result through `emitSuccess` (`src/cli/output.ts`). Most command option interfaces are module-private. The result types mostly come from `src/protocol/messages.ts`.

## Interface

- [`./home/README.md`](./home/README.md): `home list` and `home forget`.
- [`./skills/README.md`](./skills/README.md): `skills list`, `skills get` and `skills path`.
- Session creation and listing: `runCreateCommand` and the exported `CreateResult` [create.ts:runCreateCommand] [create.ts:CreateResult]. `runListCommand` and `ListResult` [list.ts:runListCommand] [list.ts:ListResult]. `runInspectCommand` [inspect.ts:runInspectCommand]. `runDestroyCommand` [destroy.ts:runDestroyCommand].
- Input commands: `runTypeCommand`, `runPasteCommand`, `runSendKeysCommand`, `runMarkCommand`, `runRunCommand`. The first four re-export `TypeResult`, `PasteResult`, `SendKeysResult` and `MarkResult` from `src/protocol/messages.ts`. [type.ts:runTypeCommand] [paste.ts:runPasteCommand] [send-keys.ts:runSendKeysCommand] [mark.ts:runMarkCommand] [run.ts:runRunCommand]
- Process control: `runResizeCommand` with `ResizeResult`, and `runSignalCommand` with `SignalResult`. [resize.ts:runResizeCommand] [resize.ts:ResizeResult] [signal.ts:runSignalCommand] [signal.ts:SignalResult]
- Observation: `runWaitCommand` [wait.ts:runWaitCommand], `runSnapshotCommand` [snapshot.ts:runSnapshotCommand], `runScreenshotCommand` [screenshot.ts:runScreenshotCommand].
- Recordings: `runRecordExportCommand` (asciicast or webm) [record-export.ts:runRecordExportCommand] and `runRecordDiffCommand` [record-diff.ts:runRecordDiffCommand].
- Batch: `runBatchCommand` runs a JSON step plan against one session. `buildBatchLines` formats per-step human lines. [batch.ts:runBatchCommand] [batch.ts:buildBatchLines]
- Maintenance: `runGcCommand`, `gcSessions`, `parseDurationToMs`, and the types `GcResult`, `GcHomeOutcome`, `GcSessionSweep`, `GcExecutionOptions`, `GcDependencies`, `GcCommandDependencies`. [gc.ts:runGcCommand] [gc.ts:gcSessions] [gc.ts:parseDurationToMs] [gc.ts:GcResult]
- Diagnostics: `runDoctorCommand`, `runDoctorChecks`, `runBaselineDoctorChecks`, `runDoctorCheck`, `buildDoctorLines`, the individual `run*Check` functions, and the types `DoctorResult`, `DoctorCheckGroups`, `DoctorCheck`, `DoctorDependencies`. [doctor.ts:runDoctorCommand] [doctor.ts:runDoctorChecks] [doctor.ts:runDoctorCheck] [doctor.ts:DoctorResult]
- Version: `runVersionCommand`, `buildVersionResult`, `VersionResult`. [version.ts:runVersionCommand] [version.ts:buildVersionResult] [version.ts:VersionResult]
- Dashboard: `runDashboardCommand`, `DashboardCommandOptions`, `DashboardCommandDependencies`, `DashboardAppOptions`. [dashboard.ts:runDashboardCommand] [dashboard.ts:DashboardAppOptions]
- Shared input helper: `resolveCommandInputText` reads the text for `type`, `paste` and `run` from the positional argument or `--file`. `MAX_INPUT_FILE_SIZE` is 10,000,000 bytes. [inputSource.ts:resolveCommandInputText] [inputSource.ts:MAX_INPUT_FILE_SIZE]

## Invariants

- `gc` does not delete a session whose status is not collectable after `reconcileSession`. It skips it with the reason `session host is still alive`. [gc.ts:gcSessions]
- Before each delete, `gc` re-reads the manifest. If the status is no longer collectable, it skips the session (`session restarted between check and delete`). If the read fails, it skips it (`failed final manifest safety check`). [gc.ts:gcSessions]
- `gc` calls `forgetHome` only outside dry-run mode. [gc.ts:runGcCommand]
- `parseDurationToMs` trims the value, then accepts only input matching `/^([1-9]\d*)([mhd])$/`. Other input throws `INVALID_DURATION`. [gc.ts:parseDurationToMs]
- `signal` accepts only the signals in `ALLOWED_SIGNALS`. Other values throw `INVALID_SIGNAL`. [signal.ts:runSignalCommand]
- `resize` throws `INVALID_DIMENSIONS` unless `cols` and `rows` are positive integers. [resize.ts:runResizeCommand]
- `type`, `paste`, `send-keys` and `mark` validate the host reply with the matching result schema. A mismatch throws `PROTOCOL_ERROR`. [type.ts:runTypeCommand] [paste.ts:runPasteCommand] [send-keys.ts:runSendKeysCommand] [mark.ts:runMarkCommand]
- Text input and `--file` are mutually exclusive. The file must be a regular file per `lstat` and at most `MAX_INPUT_FILE_SIZE` bytes. Violations throw `INVALID_INPUT`. [inputSource.ts:resolveCommandInputText]
- `wait` rejects a mix of legacy flags (`--exit`, `--idle-ms`) and render flags. `--text` and `--regex` are mutually exclusive. The default timeout is `DEFAULT_WAIT_TIMEOUT_MS` (600,000 ms). [wait.ts:runWaitCommand]
- `snapshot` and `screenshot` try the live RPC only when the manifest status is `running`. They fall back to offline replay only on `HOST_UNREACHABLE` and rethrow other errors. [snapshot.ts:runSnapshotCommand] [screenshot.ts:runScreenshotCommand]
- `record export` accepts only the formats in `RecordExportFormatSchema` (`asciicast`, `webm`). [record-export.ts:runRecordExportCommand]
- `batch` parses the whole plan with `parseBatchPlan` before it resolves the session target. [batch.ts:runBatchCommand]
- `create` polls readiness up to `READINESS_MAX_ATTEMPTS` (50) times, `READINESS_POLL_INTERVAL_MS` (100 ms) apart. [create.ts:runCreateCommand]
- `doctor` reports the `node-runtime` check as failed below Node major version 24. It keeps running the other checks, reports `ok: false` and sets `process.exitCode = 1`. [doctor.ts:runNodeRuntimeCheck] [doctor.ts:runDoctorCommand]
- `dashboard` throws `INVALID_INPUT` unless stdin and stdout are both TTYs. It also throws `INVALID_INPUT` when the libghostty-vt probe reports the renderer unavailable. [dashboard.ts:runDashboardCommand] [src/renderer/readiness.ts:assertDashboardRendererAvailable]
- `version` reports the constant `PROTOCOL_VERSION` (`'0.1.0'`). [version.ts:buildVersionResult]

## Side Effects

- Session commands send RPCs over the session socket through `sendRpc`. The method names are `run`, `type`, `paste`, `sendKeys`, `mark`, `resize`, `signal`, `snapshot`, `screenshot`, `wait`, `waitForRender` and `inspect`. `create` also sends `inspect` while it polls. [run.ts:runRunCommand] [send-keys.ts:runSendKeysCommand] [wait.ts:runWaitCommand] [create.ts:runCreateCommand]
- `create` allocates the session and starts the host process through `allocateSession` and `launchHost` (`src/host/lifecycle.ts`). If `allocateSession` or `launchHost` throws, it removes the session directory with `fs.rm`. A readiness-poll failure rethrows and leaves the session directory in place. It registers the Home through `upsertHome`. [create.ts:runCreateCommand]
- `gc` reads session directories, calls `reconcileSession` (which can rewrite manifests), deletes collectable session directories with `fs.rm` outside dry-run mode, and deregisters Homes through `forgetHome`. [gc.ts:gcSessions] [gc.ts:runGcCommand]
- `inspect` calls `reconcileSession` when the host is unreachable. [inspect.ts:runInspectCommand]
- `destroy` and `list` call `destroySession` and `listSessions` from `src/host/lifecycle.ts`. [destroy.ts:runDestroyCommand] [list.ts:runListCommand]
- `snapshot`, `screenshot`, `wait` and `record diff` run offline replay through `withOfflineReplayRenderer` (`src/replay/offlineReplay.ts`). `record diff` sends no RPC. [wait.ts:runOfflineRenderWait] [record-diff.ts:runRecordDiffCommand]
- Offline `snapshot` and `screenshot` write artifact files into the session artifacts directory and append artifact-manifest entries through `appendArtifactWithRollback`. `snapshot` writes a JSON artifact through `writeTextFileAtomic`. `screenshot` renames a PNG into place. [src/snapshot/capture.ts:captureSnapshotResult] [src/snapshot/capture.ts:persistSnapshotArtifact] [src/screenshot/capture.ts:captureScreenshotResult]
- `record export` writes to the session artifacts directory (created through `ensureArtifactsDir` when missing) or, with `--out`, to any writable user path outside the session. [record-export.ts:resolveOutputPath]
- `record export` writes asciicast files through `writeTextFileAtomic`, delegates webm to `generateWebmExport` (`src/export/webm.ts`), and appends an artifact-manifest entry through `appendArtifactWithRollback`. [record-export.ts:runRecordExportCommand]
- `doctor` creates and removes temporary files, a temporary session directory and a socket. Through `ensureHome` it creates the Home directory (mode 0700) and its `sessions/` directory when they are missing, and leaves them in place. [src/storage/home.ts:ensureHome] [doctor.ts:runHomeWritableCheck] It spawns a PTY through `createPty`, dynamically imports `playwright` and `ghostty-web`, and launches headless Chromium [doctor.ts:runBrowserLaunchCheck]. It sets `process.exitCode = 1` when a check fails. [doctor.ts:runDoctorChecks] [doctor.ts:runPtySpawnCheck] [doctor.ts:runDoctorCommand]
- `wait` sets `process.exitCode` for `WAIT_TIMEOUT` when the wait timed out. [wait.ts:setWaitTimeoutExitCode]
- `batch` installs `SIGINT` and `SIGTERM` handlers. On a signal it writes a partial envelope synchronously and calls `process.exit`. [batch.ts:executeWithInterruptFlush]
- When a step fails, `batch` sets `process.exitCode`. With `--keep-going` the code is 1. Without it, the code is `exitCodeForError` of the first failed step's error code. In both cases `batch` still emits a success envelope with the per-step results. [batch.ts:runBatchCommand]
- `version --json` runs `discoverCapabilities('quick')`, which dynamically imports `playwright` and libghostty-vt. If discovery fails, it writes a warning to stderr and omits `capabilities`. [version.ts:buildVersionResult] [src/renderer/capabilities.ts:discoverCapabilities]
- `type`, `paste`, `run` and `batch --file` read input files with `lstat`, `stat` and `readFile`. [inputSource.ts:resolveCommandInputText] [batch.ts:resolveBatchSource]
- `dashboard` lazily imports `src/dashboard/app.tsx` and runs the interactive app. [dashboard.ts:runDashboardCommand]

## Verification

- Run: `npx vitest run test/unit/commands`
- Integration (CLI against temp Homes): `npx vitest run --maxWorkers=1 test/integration/cli.test.ts`
- Run: `npm run typecheck`
