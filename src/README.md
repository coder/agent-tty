# src

## Overview

`src/` holds the TypeScript source of the `agent-tty` npm package. `tsconfig.build.json` compiles it from `rootDir` `./src` to `outDir` `./dist`. The CLI entry point is `src/cli/main.ts`, published as the `agent-tty` bin (`dist/cli/main.js`). The only file directly in `src/` is `index.ts`, the package's type-only library entry. Each subdirectory below has its own contract.

## Interface

- `index.ts` re-exports the CLI JSON envelope types `CommandEnvelope`, `CommandError`, `CommandErrorEnvelope` and `CommandSuccessEnvelope` from `src/protocol/envelope.ts`. [index.ts:CommandEnvelope]
- `index.ts` re-exports the RPC types `RpcMethod`, `RpcRequest`, `RpcResponse`, `RpcSuccessResponse`, `RpcErrorResponse` and `RpcError`, and the `*Params`/`*Result` pairs for `Destroy`, `Inspect`, `Paste`, `Resize`, `SendKeys`, `Signal`, `Type` and `Wait`, from `src/protocol/messages.ts`. [index.ts:RpcMethod]
- `index.ts` re-exports `EventRecord`, `EventType`, `SessionRecord` and `SessionStatus` from `src/protocol/schemas.ts`, `ProtocolErrorCode` from `src/protocol/errors.ts` and `AgentTtyConfig` from `src/config/resolveConfig.ts`. [index.ts:SessionRecord] [index.ts:ProtocolErrorCode] [index.ts:AgentTtyConfig]
- Package wiring: `main` is `./dist/index.js` and `types` is `./dist/index.d.ts`, both built from `index.ts`. `package.json` has no `exports` field. `bin.agent-tty` is `./dist/cli/main.js`. [package.json:main] [package.json:types] [package.json:bin]
- Subdirectories:
  - [`./cli/README.md`](./cli/README.md): Commander front end. `main.ts` registers every command and maps `CliError` to envelopes and exit codes. Handlers live in `./cli/commands/`.
  - [`./host/README.md`](./host/README.md): per-session host and its lifecycle: detached host spawn, PTY plus append-only `EventLog`, Unix-socket JSON RPC, renderer management, run-completion sentinels, and destroy, list and reconcile.
  - [`./protocol/README.md`](./protocol/README.md): machine-facing contract: CLI JSON envelopes, error codes, strict Zod schemas for manifests, event records and RPC methods, and the per-status session policy. No I/O.
  - [`./storage/README.md`](./storage/README.md): on-disk layout: Home resolution, guarded session, socket and artifact paths, temp-file-plus-rename JSON writes, artifact manifests, the Home registry and the 50 MB event-log codec.
  - [`./pty/README.md`](./pty/README.md): spawns the PTY child through `node-pty`, builds its environment, encodes keys and bracketed paste, and answers DSR and OSC 10/11 terminal queries.
  - [`./config/README.md`](./config/README.md): default session constants and the Zod-validated loader for the optional `<home>/config.json`.
  - [`./replay/README.md`](./replay/README.md): offline replay of a session's manifest and `events.jsonl` into a renderer backend up to a target `seq`.
  - [`./renderer/README.md`](./renderer/README.md): `RendererBackend` contract, replay, snapshot and profile schemas, the backend registry, Screen Hash helpers and the `ghostty-web` and `libghostty-vt` backends.
  - [`./renderWait/README.md`](./renderWait/README.md): validates `waitForRender` conditions and matches them against semantic snapshots. Pure.
  - [`./snapshot/README.md`](./snapshot/README.md): builds structured and text snapshot results with a Screen Hash and saves them as JSON artifacts with a manifest entry.
  - [`./screenshot/README.md`](./screenshot/README.md): captures a renderer PNG to a temp path, validates it, moves it to the artifact name without replacing an existing file and appends a manifest entry.
  - [`./export/README.md`](./export/README.md): asciicast v2 text from the event log, and WebM video by timed replay into a `ghostty-web` backend.
  - [`./batch/README.md`](./batch/README.md): parses and runs Batch plans of `type`, `paste`, `sendKeys`, `run` and `wait` steps over host RPC.
  - [`./dashboard/README.md`](./dashboard/README.md): Ink/React Session Dashboard behind `agent-tty dashboard`.
  - [`./skills/README.md`](./skills/README.md): finds, parses and serves the bundled skills from `<packageRoot>/skill-data/<name>/SKILL.md`.
  - [`./tools/README.md`](./tools/README.md): maintainer `tsx` tools for dogfood proof bundles, the Hero Demo videos and release-please runs.
  - [`./util/README.md`](./util/README.md): shared helpers: fail-fast assertions, abort and timeout plumbing, resource scopes, a per-key serializer, a line diff, a leveled logger, hashing and path checks.

## Invariants

- Every export in `index.ts` is `export type`, and `tsconfig.json` sets `verbatimModuleSyntax` to `true`. TypeScript therefore erases these re-exports from the emitted `dist/index.js`, which exports no runtime values. [index.ts:CommandEnvelope] [tsconfig.json:verbatimModuleSyntax]
- The install smoke test requires `dist/index.js` and `dist/index.d.ts` in the packed tarball and in the installed package. `assertPackedFiles` and `assertPackagePaths` throw when one is missing. [scripts/smoke-install.mjs:getRequiredPackPaths] [scripts/smoke-install.mjs:assertPackedFiles] [scripts/smoke-install.mjs:assertPackagePaths]

## Side Effects

- None found in code. `index.ts` only re-exports types.

## Verification

- Run: `npm run typecheck`
- Run: `npm run build && npm run smoke:install -- --skip-build` (checks that `dist/index.js` and `dist/index.d.ts` ship)
- Run: `npm test` (every `test/**/*.test.ts`; integration and e2e tests need Playwright Chromium from `mise run bootstrap`)
