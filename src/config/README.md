# src/config

## Overview

`src/config` holds the default values for new sessions and the loader for the optional `<home>/config.json` file. `defaults.ts` has constants only. `resolveConfig.ts` validates the config file with Zod and builds the resolved runtime config. `resolveConfig()` takes `home` from `src/storage/home.ts` and every other field from the `defaults.ts` constants.

## Interface

- `DEFAULT_COLS` (80), `DEFAULT_ROWS` (24), `DEFAULT_TERM` (`'xterm-256color'`) and `DEFAULT_IDLE_TIMEOUT_MS` (0) set the default terminal size, `TERM` value and idle timeout. [defaults.ts:DEFAULT_COLS] [defaults.ts:DEFAULT_ROWS] [defaults.ts:DEFAULT_TERM] [defaults.ts:DEFAULT_IDLE_TIMEOUT_MS]
- `DEFAULT_SHELL` is `process.env.SHELL`, or `'/bin/sh'` when `SHELL` is unset. [defaults.ts:DEFAULT_SHELL]
- `DEFAULT_LOG_LEVEL` is re-exported from `src/util/logger.ts`. [src/util/logger.ts:DEFAULT_LOG_LEVEL]
- `HOST_RENDERER_ENV_KEY` is the environment variable name `'AGENT_TTY_HOST_RENDERER'`. [defaults.ts:HOST_RENDERER_ENV_KEY]
- `SOCKET_FILENAME` (`'host.sock'`), `MANIFEST_FILENAME` (`'session.json'`) and `EVENT_LOG_FILENAME` (`'events.jsonl'`) are the per-session file names. [defaults.ts:SOCKET_FILENAME] [defaults.ts:MANIFEST_FILENAME] [defaults.ts:EVENT_LOG_FILENAME]
- `ConfigFileSchema` and its type `ConfigFile` describe `config.json`. All fields are optional: `logLevel`, `defaultProfile`, `defaultRenderer`, `defaultShell`, `defaultTerm`, `defaultCols`, `defaultRows` and `idleTimeoutMs`. [resolveConfig.ts:ConfigFileSchema] [resolveConfig.ts:ConfigFile]
- `AgentTtyConfig` is the resolved config shape: `home`, `cols`, `rows`, `shell`, `socketFilename`, `manifestFilename` and `eventLogFilename`. [resolveConfig.ts:AgentTtyConfig]
- `loadConfigFile(home)` reads `<home>/config.json` and returns the validated `ConfigFile`, or `null` when the file does not exist. [resolveConfig.ts:loadConfigFile]
- `resolveConfig()` returns a frozen `AgentTtyConfig`. [resolveConfig.ts:resolveConfig]

## Invariants

- `ConfigFileSchema` is `.strict()`, so unknown keys fail validation. `logLevel` must be `'debug'`, `'info'`, `'warn'` or `'error'`. `defaultCols` and `defaultRows` must be positive integers. `idleTimeoutMs` must be a non-negative integer. [resolveConfig.ts:ConfigFileSchema]
- `loadConfigFile` asserts that `home` is non-empty and absolute. [resolveConfig.ts:loadConfigFile]
- `loadConfigFile` returns `null` on `ENOENT`. It throws on any other read error, on invalid JSON and on a schema failure. The schema error lists each issue path. [resolveConfig.ts:loadConfigFile]
- `resolveConfig` does not read `config.json`. Its `cols`, `rows` and `shell` come from `DEFAULT_COLS`, `DEFAULT_ROWS` and `DEFAULT_SHELL`, and it freezes the result with `Object.freeze`. [resolveConfig.ts:resolveConfig]

## Side Effects

- `DEFAULT_SHELL` reads `process.env.SHELL` once, when the module loads. [defaults.ts:DEFAULT_SHELL]
- `loadConfigFile` reads `<home>/config.json` with `readFile` from `node:fs/promises`. It does not use a storage helper. [resolveConfig.ts:loadConfigFile]
- `resolveConfig` calls `resolveHome()` from `src/storage/home.ts`. That function reads `process.env.AGENT_TTY_HOME`, falls back to `~/.agent-tty` and resolves it with `realpathSync` when the path exists. If `realpathSync` throws, it returns the normalized path. [resolveConfig.ts:resolveConfig] [src/storage/home.ts:resolveHome]

## Verification

- Run: `npx vitest run test/unit/config`
- Run: `npm run typecheck`
