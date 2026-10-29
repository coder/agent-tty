# src/pty

## Overview

`src/pty` spawns the PTY child process and encodes input for it. `createPty.ts` wraps `node-pty` `spawn` and builds the child environment. `keyEncoder.ts` and `pasteEncoder.ts` turn key names and paste text into terminal byte sequences. `terminalQueryResponder.ts` scans PTY output and builds replies to a few terminal queries (DSR and OSC 10/11 color queries), so programs that probe the terminal at startup do not time out.

## Interface

- `PtyOptions` is the spawn input: `command`, `cwd`, `cols`, `rows`, `env`, `term` and an optional `sessionId`. [createPty.ts:PtyOptions]
- `resolvePtyEnv(env, term, baseEnv = process.env, sessionId?)` builds the child environment. Order, lowest precedence first: `baseEnv` without `AGENT_TTY_HOST_RENDERER`, then `PROMPT_EOL_MARK=''` when `env` does not set it, then `AGENT_TTY_ACTIVE`/`AGENT_TTY_SESSION_ID`, then `env`, then `TERM=term`. [createPty.ts:resolvePtyEnv]
- `createPty(options)` validates the options and returns the `IPty` from `node-pty` `spawn(command[0], command.slice(1), ...)`. [createPty.ts:createPty]
- `encodeKey(name)` turns a key name such as `ctrl+c`, `shift+tab`, `f5` or `up` into its xterm-style byte sequence. [keyEncoder.ts:encodeKey]
- `assertValidKeyName(name)` calls `encodeKey` and rethrows a failure as a `CliError` with code `INVALID_KEYS` (from `src/protocol/errors.ts`). [keyEncoder.ts:assertValidKeyName]
- `encodePaste(text)` wraps text in bracketed-paste markers `ESC[200~` and `ESC[201~`. [pasteEncoder.ts:encodePaste]
- `TerminalQueryResponderOptions` holds the `backgroundColor` and `foregroundColor` to report, each as `#rrggbb`. [terminalQueryResponder.ts:TerminalQueryResponderOptions]
- `TerminalQueryResponder.consume(chunk)` returns the reply bytes for the queries found in the chunk: `ESC[0n` for DSR `ESC[5n`, and an `rgb:rrrr/gggg/bbbb` reply for OSC 10/11 `?` queries. It returns `''` when there is nothing to answer. [terminalQueryResponder.ts:TerminalQueryResponder]

## Invariants

- `createPty` asserts a non-empty `command`, positive integer `cols` and `rows`, a non-empty `term`, non-empty env keys and string env values. [createPty.ts:createPty]
- `resolvePtyEnv` asserts that `sessionId` is non-empty when given. With a `sessionId` it sets `AGENT_TTY_ACTIVE='true'` and `AGENT_TTY_SESSION_ID`. Without one it deletes both inherited variables. It sets `TERM` last. [createPty.ts:resolvePtyEnv]
- `resolvePtyEnv` sets `PROMPT_EOL_MARK` to `''` only when the caller's `env` has no `PROMPT_EOL_MARK` key. The inherited value does not count. [createPty.ts:resolvePtyEnv]
- `encodeKey` rejects an empty name, an unknown base key, a repeated modifier and a modifier other than `ctrl`, `alt` or `shift`. A printable key must be one ASCII character from 0x20 to 0x7e. [keyEncoder.ts:encodeKey]
- `encodePaste` asserts that `text` is a non-empty string. [pasteEncoder.ts:encodePaste]
- The `TerminalQueryResponder` constructor asserts that both colors match `/^#[0-9a-fA-F]{6}$/`. [terminalQueryResponder.ts:TerminalQueryResponder]
- `TerminalQueryResponder` keeps its scanner state between `consume` calls, so it answers a query that is split across two chunks. It stops buffering CSI parameters after 32 characters and OSC payloads after 64 characters. [terminalQueryResponder.ts:TerminalQueryResponder]
- The file doc comment states that the responder only adds replies and does not change the output stream that goes to the event log. [terminalQueryResponder.ts:TerminalQueryResponder]

## Side Effects

- `createPty` spawns a child process through `node-pty` `spawn`. [createPty.ts:createPty]
- `resolvePtyEnv` reads `process.env` as its default `baseEnv`. [createPty.ts:resolvePtyEnv]
- On macOS (arm64 and x64), `createPty` calls `ensureDarwinSpawnHelperExecutable`. That function uses `statSync` and `chmodSync` to add the execute bit to the `node-pty` `spawn-helper` prebuild, and it ignores errors. [createPty.ts:ensureDarwinSpawnHelperExecutable]
- `encodeKey`, `assertValidKeyName` and `encodePaste` are pure. [keyEncoder.ts:encodeKey] [pasteEncoder.ts:encodePaste]
- `TerminalQueryResponder` does no I/O. The caller writes the returned replies to the PTY. [terminalQueryResponder.ts:TerminalQueryResponder]

## Verification

- Run: `npx vitest run test/unit/pty`
- Run: `npx vitest run --maxWorkers=1 test/integration/lifecycle.test.ts` (checks the env and `PROMPT_EOL_MARK` that reach the spawned shell)
- Run: `npm run typecheck`
