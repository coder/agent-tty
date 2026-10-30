# src/cli/commands/home

## Overview

This directory holds the handlers for the `home list` and `home forget` CLI subcommands. Both work on the Home Registry, a host-wide list of agent-tty Homes stored outside any one Home. `home list` reads the registry and counts sessions per Home. `home forget` removes one entry from the registry and does not touch the Home directory. Both handlers take optional injected dependencies so unit tests can replace the storage calls.

## Interface

- `runHomeListCommand(options, dependencies?)`: emits `{ homes }` under the command name `home list`. Scope is `'all'` when `options.all` is true, else `'active'`. The default lister is `listRegisteredHomes` from `src/storage/homeScope.ts`. [list.ts:runHomeListCommand]
- `HomeListResult`, `HomeListCommandOptions` (`{ json, all }`), `HomeListCommandDependencies` (`{ listHomes? }`). `RegisteredHome` and `HomeListingScope` come from `src/storage/homeScope.ts`. [list.ts:HomeListResult] [list.ts:HomeListCommandOptions] [list.ts:HomeListCommandDependencies]
- `runHomeForgetCommand(options, dependencies?)`: normalizes `options.path` for display, calls `forget` with the path made absolute, and emits `{ path, forgotten }` under the command name `home forget`. The default `forget` is `createHomeRegistry().forget(path)` from `src/storage/homeRegistry.ts`. [forget.ts:runHomeForgetCommand]
- `HomeForgetResult`, `HomeForgetCommandOptions` (`{ json, path }`), `HomeForgetCommandDependencies` (`{ forget? }`). [forget.ts:HomeForgetResult] [forget.ts:HomeForgetCommandOptions] [forget.ts:HomeForgetCommandDependencies]

## Invariants

- The Home path must be a non-empty string. `normalizeHomePath` enforces this with `invariant` before the registry is called. [src/storage/homeRegistry.ts:normalizeHomePath]
- `forget` returns `false` and writes nothing when no entry matches the path as written or its normalized form. [src/storage/homeRegistry.ts:createHomeRegistry]
- The registry path must be absolute (`invariant`). A relative `XDG_STATE_HOME` is ignored. [src/storage/homeRegistry.ts:resolveHomeRegistryPath]
- `listRegisteredHomes` drops Homes with zero visible sessions. The count leaves out destroyed sessions and sessions whose manifest is missing or unreadable, so a Home whose sessions are all destroyed is dropped too. In `'active'` scope it also drops Homes with zero active sessions. It sorts the result by `lastSeenAt`, newest first. [src/storage/homeScope.ts:listRegisteredHomes] [src/storage/homeScope.ts:scanHome]
- With an empty list, human output is the single line `No registered Homes.`. [list.ts:buildHomeListLines]

## Side Effects

- Both commands write to stdout through `emitSuccess` (JSON envelope with `--json`, text lines otherwise). [src/cli/output.ts:emitSuccess]
- `home forget` removes the entry stored under the given path as written or under its `canonicalHomePath` form. So a removed Home still matches its entry when you name it through a symlink, and also after an ancestor of its stored path became a symlink. [src/storage/homeRegistry.ts:normalizeHomePath] [src/storage/homeRegistry.ts:createHomeRegistry]
- `home forget` reads `${XDG_STATE_HOME:-~/.local/state}/agent-tty/homes.json`. When it removes an entry, it rewrites that file through `writeTextFileAtomic` (temp file, then rename). `writeTextFileAtomic` creates the `agent-tty/` state directory when it is missing and writes the file with mode 0600. The comment in the handler states that it never touches the Home directory. [src/storage/homeRegistry.ts:createHomeRegistry] [src/storage/manifests.ts:writeTextFileAtomic] [forget.ts:runHomeForgetCommand]
- `home list` reads the registry, runs `readdir` on each `<home>/sessions`, and reads each session manifest through `readManifestIfExists`. It writes no files. [src/storage/homeScope.ts:scanHome]

## Verification

- Run: `npx vitest run test/unit/commands/home-list.test.ts test/unit/commands/home-forget.test.ts`
- Run: `npm run typecheck`
