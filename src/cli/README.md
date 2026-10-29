# src/cli

## Overview

This directory is the agent-tty command-line front end. `main.ts` is the bin entrypoint and the public CLI contract: it builds the Commander program, registers every command, resolves a `CommandContext` before each action, and maps `CliError` failures to output envelopes and exit codes. The command handlers live in `./commands/`. The other files hold shared pieces: context resolution, output envelopes, session target lookup, session status guards, exit codes and the `CliError` class.

## Interface

- [`./commands/README.md`](./commands/README.md): one handler module per CLI command.
- `main.ts` has no exports. It builds the program named `agent-tty` and runs `main()` at module top level. [main.ts:main]
- Global options: `--home <path>`, `--timeout-ms <n>`, `--no-color`, `--log-level <level>`, `--profile <name>`, `--renderer <name>`. Each command except `dashboard` (alias `d`) and the hidden `_host` registers its own `--json` option. [main.ts:main]
- Commands: `version`, `doctor`, `create [command...]`, `list`, `inspect`, `destroy`, `gc`, `type`, `paste`, `run`, `batch`, `mark`, `send-keys`, `resize`, `signal`, `snapshot`, `screenshot`, `dashboard`, `wait`. Groups: `skills list|get|path`, `home list|forget`, `record diff|export`. A hidden `_host <session-id>` command imports `src/host/hostMain.ts` and runs `runHost`. [main.ts:main]
- `resolveCommandContext(options, env?, deps?)`, `getCommandContext`, `setCommandContext`, `parseTimeoutMsOption`, `resolveRendererDefault`, `resolveLogLevel`, `clearRendererDefaultProbeCacheForTests`, and the types `GlobalCliOptions` and `CommandContext`. [context.ts:resolveCommandContext] [context.ts:CommandContext]
- `emitSuccess`, `emitSuccessSync`, `emitFailure`, `formatSuccessOutput`, `writeJsonEnvelope`, `writeHumanLines`, `writeStdoutSync`, `setColorEnabled`. [output.ts:emitSuccess] [output.ts:emitFailure] [output.ts:writeStdoutSync]
- `resolveCommandTarget(options)` returns a `CommandTarget` (`sessionId`, `sessionDirectory`, `manifestPath`, `socketPath`, `manifest`). Also exports `ResolveCommandTargetOptions` and `CommandTargetManifest`. [commandTarget.ts:resolveCommandTarget] [commandTarget.ts:CommandTarget]
- `assertSessionCommandable(manifest, sessionId)`. [sessionGuards.ts:assertSessionCommandable]
- `exitCodeForError(code)`. [exitCodes.ts:exitCodeForError]
- `CliError` (`code`, `retryable`, `details`). [errors.ts:CliError]

## Invariants

- `EXIT_CODE_BY_ERROR_CODE` maps error codes to exit codes: input errors 2, `SESSION_NOT_FOUND` 3, `SESSION_NOT_RUNNING` and `SESSION_ALREADY_DESTROYED` 4, `HOST_TIMEOUT` 5, `HOST_UNREACHABLE` 6, `EXPORT_ERROR` 7, storage and manifest errors 8, `PROTOCOL_ERROR` and `RPC_ERROR` 9, `REPLAY_ERROR` 10, `WAIT_TIMEOUT` 11, `INTERNAL_ERROR` 1. Unknown codes give 1. A code comment marks this as a public contract documented in `docs/USAGE.md`. [exitCodes.ts:exitCodeForError]
- `wrapAction` turns only `CliError` into an error envelope and exit code. Other errors propagate. [main.ts:wrapAction]
- At top level, a `CommanderError` sets exit code 0 for `commander.helpDisplayed` and 2 otherwise. [main.ts:main]
- At top level, a `CliError` thrown outside `wrapAction` (for example from context resolution in the `preAction` hook) resets color from `--no-color` in argv and is emitted through `emitCliError` under the command name `agent-tty`. [main.ts:main] [main.ts:emitCliError]
- The envelope shapes come from `src/protocol/envelope.ts` (`createSuccessEnvelope`, `createErrorEnvelope`). `output.ts` defines no schema. [output.ts:emitSuccess]
- Home precedence is `--home`, then `AGENT_TTY_HOME`, then `resolveHome`. An explicit Home must be non-empty and absolute, else `INVALID_INPUT`. The returned context is frozen with `Object.freeze`. [context.ts:resolveCommandContext]
- `--timeout-ms` must match `/^\d+$/`, else `INVALID_DURATION`. [context.ts:parseTimeoutMsOption]
- `resolveCommandTarget` throws `SESSION_NOT_FOUND` for a missing manifest. It then requires a commandable status through `assertSessionCommandable` and asserts `status === 'running'`. [commandTarget.ts:resolveCommandTarget]
- `assertSessionCommandable` throws `SESSION_ALREADY_DESTROYED` for destroyed sessions and `SESSION_NOT_RUNNING` for other non-commandable statuses. [sessionGuards.ts:assertSessionCommandable]
- With color disabled, human output has ANSI escapes stripped. [output.ts:writeHumanLines]

## Side Effects

- `emitSuccess` writes to stdout. `emitFailure` writes the error envelope to stdout with `--json`, or `code: message` to stderr without it. [output.ts:emitSuccess] [output.ts:emitFailure]
- `writeStdoutSync` writes to fd 1 with `fs.writeSync`. [output.ts:writeStdoutSync]
- `emitCliError` reads `process.argv` for `--json` and sets `process.exitCode`. [main.ts:emitCliError]
- The `preAction` hook writes `AGENT_TTY_HOME`, `AGENT_TTY_LOG_LEVEL` and the host renderer key into `process.env`. It sets or deletes `AGENT_TTY_RENDERER`. [main.ts:main]
- `resolveCommandContext` reads `AGENT_TTY_HOME`, `AGENT_TTY_LOG_LEVEL`, `AGENT_TTY_PROFILE` and `AGENT_TTY_RENDERER`. It reads the config file through `loadConfigFile(home)` (`src/config/resolveConfig.ts`). When no renderer is configured, it dynamically imports libghostty-vt through `probeLibghosttyVt` and caches the result for the whole process. [context.ts:resolveCommandContext] [src/renderer/readiness.ts:probeLibghosttyVt]
- `resolveCommandTarget` reads the session manifest through `readManifestIfExists`. [commandTarget.ts:resolveCommandTarget]

## Verification

- Run: `npx vitest run test/unit/cli test/unit/commands`
- Integration (spawns `src/cli/main.ts` through `test/helpers.ts`): `npx vitest run --maxWorkers=1 test/integration/cli.test.ts`
- Run: `npm run typecheck`
