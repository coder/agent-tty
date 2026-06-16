# Plan 001: agent-tty restricts its local socket and state files to the owning user

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c11e2e2..HEAD -- src/host/hostMain.ts src/host/rpcServer.ts src/storage/manifests.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `c11e2e2`, 2026-06-16

## Why this matters

`agent-tty` gives a caller full control of a real PTY: the RPC server accepts
`type`, `paste`, `send-keys`, `run`, `resize`, and `signal` — i.e. arbitrary
input into your shell. That server listens on a Unix domain socket at a
**deterministic, world-traversable** path under `/tmp/agent-tty/`, and the
socket and the session state files are created with **no explicit permissions**,
so they inherit the process umask. On a shared machine (multi-user dev box, a
shared CI runner) with a permissive umask, another local user can connect to the
socket and drive your session — effectively arbitrary command execution as you —
or read your session manifests and Home Registry. The default umask (`022`)
happens to block _connecting_ (connect needs write on the socket file), but
relying on ambient umask for an authorization boundary is fragile. This plan
makes the boundary explicit: the per-Home socket directory becomes owner-only
(`0o700`), the socket file and persisted state files become owner-only
(`0o600`), regardless of umask.

## Current state

Files involved:

- `src/host/hostMain.ts` — per-session host entrypoint (`runHost`); creates the
  socket directory just before the RPC server listens.
- `src/host/rpcServer.ts` — `RpcServer.listen()` binds the Unix domain socket.
- `src/storage/manifests.ts` — `writeTextFileAtomic`, the single writer used for
  the session manifest and the Home Registry (`homes.json`).
- `src/storage/sessionPaths.ts` — builds the socket path
  `/tmp/agent-tty/<sha256(home)[:8]>/<sha256(sessionId)[:12]>` (read-only here;
  do not change path construction — it is already traversal-guarded).

**Socket directory creation — `src/host/hostMain.ts` around line 1077** (inside
`runHost`, `mkdir` is already imported from `node:fs/promises` on line 1):

```ts
await mkdir(dirname(sPath), { recursive: true });
```

`sPath` is the socket path (`const sPath = socketPath(sessDir);` earlier in
`runHost`, ~line 143). `dirname(sPath)` is the per-Home socket directory. The
`mkdir` passes no `mode`, so the directory inherits the umask.

**Socket bind — `src/host/rpcServer.ts:190-229`** (`server.listen` sets no
permissions on the created socket file):

```ts
  public async listen(): Promise<void> {
    invariant(this.server === null, 'RPC server is already listening.');

    await this.removeStaleSocketIfNeeded();
    // ... length + existence invariants ...
    const server = net.createServer((socket) => {
      this.handleConnection(socket);
    });
    server.on('error', () => { /* ... */ });
    this.server = server;

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => { reject(error); };
        server.once('error', onError);
        server.listen(this.socketPath, () => {
          server.off('error', onError);
          resolve();
        });
      });
    } catch (error) {
      this.server = null;
      throw error;
    }
  }
```

`this.socketPath` is a private field set in the constructor. `net` is imported
at the top of the file; `node:fs/promises` is **not** yet imported there.

**State-file writer — `src/storage/manifests.ts:100-120`** (no `mode` on
`writeFile`, so manifests and `homes.json` inherit the umask, typically `0o644`
= world-readable):

```ts
export async function writeTextFileAtomic(
  options: WriteTextFileAtomicOptions,
): Promise<void> {
  assertAbsoluteStoragePath(options.path, options.pathLabel);

  const outputDirectory = dirname(options.path);
  const temporaryPath = `${options.path}.tmp-${randomUUID()}`;

  try {
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(temporaryPath, options.contents, 'utf8');
    await rename(temporaryPath, options.path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw makeCliError(ERROR_CODES.STORAGE_WRITE_ERROR, {
      message: options.writeErrorMessage,
      details: { path: options.path },
      cause: error,
    });
  }
}
```

`mkdir`, `rename`, `rm`, `writeFile` are imported from `node:fs/promises` on
line 2 of this file.

### Conventions to follow

- This is strict TypeScript, NodeNext ESM. Imports from TypeScript source use
  `.js` extensions. Prefer `import type` for type-only imports.
- Use the existing `invariant` helper (`src/util/assert.ts`) for preconditions;
  match the surrounding small-helper, explicit-control-flow style.
- `chmod` is preferred over a `mkdir` `mode` option because **`mkdir`'s `mode`
  is masked by the umask, but `chmod` is not** — `chmod` guarantees the final
  mode. Octal literals like `0o700` are the standard Node idiom.
- 2-space indent, single quotes, trailing commas, semicolons (oxfmt enforces).

### Design constraints (from CONTEXT.md / AGENTS.md — honor these)

- The socket path is derived per **Home** then per **Session**; a single
  per-Home socket directory holds one socket file per Session. Locking the
  directory to `0o700` is per-Home and is correct for all sessions in that Home.
- Storage writes must stay inside validated helpers; do **not** add ad-hoc
  `fs` permission logic in command code — change it in `writeTextFileAtomic`
  (the single manifest/registry writer) and in the host socket setup only.

## Commands you will need

| Purpose         | Command                                          | Expected on success |
| --------------- | ------------------------------------------------ | ------------------- |
| Install deps    | `aube install`                                   | exit 0              |
| Typecheck       | `npm run typecheck`                              | exit 0, no errors   |
| Lint            | `npm run lint`                                   | exit 0              |
| Format (fix)    | `npm run format`                                 | exit 0              |
| Run one test    | `npx vitest run test/integration/<file>.test.ts` | all pass            |
| Integration set | `npm run test:integration`                       | all pass            |

## Scope

**In scope** (the only files you should modify):

- `src/host/hostMain.ts` — chmod the socket directory after creating it.
- `src/host/rpcServer.ts` — chmod the socket file after `listen()` resolves.
- `src/storage/manifests.ts` — write state files with `mode: 0o600`.
- A new or existing test file under `test/integration/` (see Test plan).

**Out of scope** (do NOT touch):

- `src/storage/sessionPaths.ts` — path construction is already traversal-guarded
  with `dirname(x) === root` invariants. Do not change it.
- `CHANGELOG.md` — automation-owned (Communique/release-please). Never edit it
  in a feature change; a manual edit conflicts with `main` and breaks CI.
- The public CLI JSON envelopes / protocol schemas — this change is internal.
- Windows-specific permission behavior — Windows is tier-2 and Unix mode bits
  do not apply; guard the new test to Unix only (see Test plan).

## Git workflow

- Branch: `advisor/001-harden-local-state-permissions`
- Commit message style: Conventional Commits (repo enforces this on PR titles).
  Example from history: `fix: drop the component suffix from the release branch name`.
  Use e.g. `fix: restrict agent-tty socket and state files to the owning user`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Lock the per-Home socket directory to `0o700`

In `src/host/hostMain.ts`:

1. Add `chmod` to the existing `node:fs/promises` import on line 1
   (`import { chmod, mkdir } from 'node:fs/promises';`).
2. At the socket-directory creation site (~line 1077), after the existing
   `mkdir`, add a `chmod` of that directory to `0o700`:

```ts
const socketDirectory = dirname(sPath);
await mkdir(socketDirectory, { recursive: true });
await chmod(socketDirectory, 0o700);
```

(If `sPath` / `dirname(sPath)` is already bound to a local variable nearby,
reuse it instead of recomputing — keep one `dirname(sPath)` expression.)

**Verify**: `npm run typecheck` → exit 0, no errors.

### Step 2: Lock the socket file to `0o600` after bind

In `src/host/rpcServer.ts`:

1. Add an import: `import { chmod } from 'node:fs/promises';` (place it with the
   other `node:` imports at the top).
2. Inside `listen()`, immediately after the `await new Promise<void>(...)` that
   resolves when `server.listen(...)` succeeds (i.e. after the try/catch that
   binds the socket, before the method returns), chmod the socket file:

```ts
await chmod(this.socketPath, 0o600);
```

Place this **after** the bind succeeds (the socket file does not exist until
`listen` resolves). Do not place it inside the `catch`.

**Verify**: `npm run typecheck` → exit 0. Then `npm run test:integration`
→ all pass (existing RPC/lifecycle integration tests still connect, because the
owner retains read/write).

### Step 3: Write persisted state files as `0o600`

In `src/storage/manifests.ts`, change the `writeFile` call in
`writeTextFileAtomic` to set an explicit mode:

```ts
await writeFile(temporaryPath, options.contents, {
  encoding: 'utf8',
  mode: 0o600,
});
```

The mode survives the subsequent `rename` to the final path (rename preserves
the inode and its mode). No other change in this function.

**Verify**: `npm run typecheck` → exit 0.

### Step 4: Format and full static check

Run `npm run format` then `npm run lint` → both exit 0.

## Test plan

Add a focused integration test that creates a session and asserts the
permission bits. Model it on an existing integration test that already spins up
a session against an isolated `AGENT_TTY_HOME` — inspect `test/integration/`
for one that calls `create` then `destroy` (e.g. `test/integration/gc.test.ts`
or a lifecycle test) and copy its setup/teardown shape (isolated temp home,
absolute `AGENT_TTY_HOME`, never the real `~/.agent-tty`).

New test file: `test/integration/socket-permissions.test.ts` (or add a case to
the closest existing lifecycle integration test if the maintainer prefers).
Cover:

- **Socket directory is `0o700`**: after `create`, locate the per-Home socket
  directory under `/tmp/agent-tty/` for the test's Home and assert
  `(statSync(dir).mode & 0o777) === 0o700`.
- **Socket file is `0o600`**: assert the bound socket file's
  `(mode & 0o777) === 0o600`.
- **Manifest is `0o600`**: after `create`, assert the session manifest file's
  `(mode & 0o777) === 0o600`.
- **Owner can still drive the session**: a `run` or `inspect` against the
  session still succeeds (proves the tightened perms didn't lock out the owner).

Guard the whole suite to Unix: at the top, `if (process.platform === 'win32')`
skip (use vitest's `describe.skipIf(process.platform === 'win32')` or an early
`it.skip`). Mode bits are not meaningful on Windows.

**Verification**: `npx vitest run test/integration/socket-permissions.test.ts`
→ all new cases pass.

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0.
- [ ] `npm run lint` exits 0.
- [ ] `npm run format:check` exits 0.
- [ ] `npm run test:integration` exits 0; the new socket-permissions test exists
      and passes on this (Unix) machine.
- [ ] `grep -n "chmod" src/host/hostMain.ts src/host/rpcServer.ts` shows the two
      new chmod calls.
- [ ] `grep -n "mode: 0o600" src/storage/manifests.ts` shows the manifest mode.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the "Current state" locations doesn't match the excerpts (drift).
- An existing integration or e2e test that connects to the socket **fails** after
  Step 2 — that would mean the owner is being locked out or a non-owner path
  exists you weren't told about. Do not loosen the mode to make it pass.
- The socket-directory creation is not at/near `hostMain.ts:1077`, or `sPath`
  is constructed differently than described.
- Setting `mode: 0o600` on the temp file changes behavior on `rename` (e.g. a
  test reads the manifest as a different user) — report rather than reverting to
  default mode.

## Maintenance notes

- A reviewer should confirm the chmod on the socket happens **after** `listen`
  resolves (the file doesn't exist before then) and that the directory chmod
  uses `chmod`, not the `mkdir` `mode` option (which umask would mask).
- If a future change moves the socket out of `/tmp/agent-tty/` or makes sockets
  per-session-directory instead of per-Home, revisit the directory chmod.
- Deferred out of this plan: hardening the _parent_ `/tmp/agent-tty/` root mode
  (left at default; per-Home `0o700` already prevents traversal into a Home's
  sockets) and any audit-logging of rejected connections. Not needed for the
  boundary this plan establishes.
