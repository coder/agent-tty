# Plan 007: agent-tty restricts its Home directory, session directories, and event log to the owning user

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 5cb9a20..HEAD -- src/storage/home.ts src/host/lifecycle.ts src/host/eventLog.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `5cb9a20`, 2026-06-22

## Why this matters

`agent-tty` records the **full terminal byte stream** of every session into an
append-only event log (`events.jsonl`): all program output _and_ every keystroke,
paste, and `run` command the caller injects. That stream can contain secrets —
a token printed to the screen, a password typed into a prompt, an API key in a
command line.

A previous hardening pass (plan 001, shipped) locked down the RPC socket and the
**atomically-written** state files (the session manifest `session.json` and the
Home Registry `homes.json`) to `0o600`. But it did **not** restrict the event
log file, nor the directories that contain session state. Those are created with
`mkdir` / `open` and **no explicit mode**, so they inherit the process umask
(typically `0o755` for directories, `0o644` for files). The default Home
(`~/.agent-tty`) is commonly traversable (`~` is `0o755` on macOS and many Linux
distros), and a Home pointed at `AGENT_TTY_HOME=/tmp/...` is world-traversable by
definition. The net effect: **another local user can read the complete terminal
history of your sessions** — the single richest and most sensitive file is the
one plan 001 left exposed.

This plan closes the gap by making the agent-tty **Home directory** and every
**session directory** owner-only (`0o700`) — the session directory is the master
control that transitively protects the event log and all artifacts inside it —
and additionally locks the event log file itself to `0o600` as defense in depth.
No behavior changes for the owner, who retains full read/write.

## Current state

Files involved:

- `src/storage/home.ts` — `ensureHome()` creates the agent-tty **Home** root.
- `src/host/lifecycle.ts` — `allocateSession()` creates each per-session directory.
- `src/host/eventLog.ts` — `EventLog.open()` opens/creates the `events.jsonl` file.

**Home creation — `src/storage/home.ts:44-52`** (the whole `ensureHome`; `mkdir`
is imported on line 2: `import { mkdir } from 'node:fs/promises';`):

```ts
export async function ensureHome(
  configuredHome = process.env.AGENT_TTY_HOME,
): Promise<string> {
  const home = resolveHome(configuredHome);

  await mkdir(home, { recursive: true });

  return home;
}
```

`mkdir` passes no `mode`, so a newly-created Home inherits the umask.

**Session-directory creation — `src/host/lifecycle.ts:378-380`** (inside
`allocateSession`; `mkdir` is imported on line 2:
`import { mkdir, readdir, stat, unlink } from 'node:fs/promises';`):

```ts
const home = await ensureHome(config.home);
const sessionDirectory = sessionDir(home, sessionId);
await mkdir(sessionDirectory, { recursive: true });
```

`sessionId` is a fresh `ulid()` (line 375), so the session directory is always
newly created here. `mkdir` passes no `mode`.

**Event-log open — `src/host/eventLog.ts:261-283`** (`open` is imported on line 2:
`import { open, readFile, stat } from 'node:fs/promises';`; the returned value is
a `FileHandle`):

```ts
  static async open(filePath: string): Promise<EventLog> {
    assertFilePath(filePath);

    const fileHandle = await open(filePath, 'a');
    try {
      const fileStats = await fileHandle.stat();
      assertEventLogSize(fileStats.size);

      let eventBuffer: EventRecord[] = [];
      let nextSeq = 0;
      if (fileStats.size > 0) {
        const existingContent = await readFile(filePath, 'utf8');
        eventBuffer = parseEventLogContent(existingContent);
        nextSeq = deriveNextSeq(eventBuffer);
        invariant(nextSeq >= 0, 'derived next seq must be non-negative');
      }

      return new EventLog(filePath, fileHandle, nextSeq, eventBuffer);
    } catch (error) {
      await fileHandle.close();
      throw error;
    }
  }
```

`open(filePath, 'a')` creates the file (if absent) with a umask-masked mode; no
explicit `0o600` is applied.

### How the existing plan-001 hardening looks (follow this pattern)

Plan 001 already chmods the socket directory and socket file. Match its style:

- `src/host/hostMain.ts:1080-1081`:
  ```ts
  await mkdir(socketDirectory, { recursive: true });
  await chmod(socketDirectory, 0o700);
  ```
- `src/host/rpcServer.ts:230`: `await chmod(this.socketPath, 0o600);`

The existing permission test is `test/integration/socket-permissions.test.ts` —
**read it before writing the new test**; you will extend it (or model a new test
on it). It already asserts `(stat(...).mode & 0o777) === 0o700` / `0o600`.

### Conventions to follow

- Strict TypeScript, NodeNext ESM; imports from TS source use `.js` extensions;
  prefer `import type` for type-only imports (oxlint enforces).
- **Use `chmod`, not the `mkdir`/`open` `mode` option** — the `mode` option is
  masked by the umask, but `chmod` is not, so `chmod` guarantees the final mode.
  Octal literals like `0o700` / `0o600` are the standard Node idiom.
- 2-space indent, single quotes, trailing commas, semicolons (oxfmt enforces).
- Use the existing `invariant` helper for preconditions where natural; match the
  surrounding small-helper, explicit-control-flow style.

### Design constraints (from CONTEXT.md / AGENTS.md — honor these)

- A **Home** is "user-owned … agent-tty manages the **Sessions** inside a
  **Home** … but never deletes the **Home** directory itself" (`CONTEXT.md:230`).
  Locking a Home **we create** to `0o700` is consistent with this; do **not**
  chmod a Home directory that already existed before this call (the user may have
  set it up deliberately) — see Step 1's only-if-created guard.
- Keep storage/permission logic inside the existing helpers (`ensureHome`,
  `allocateSession`, `EventLog.open`); do not scatter `fs` permission calls into
  command code.
- Unix mode bits are meaningless on Windows (tier-2); guard the new test to Unix
  exactly as `socket-permissions.test.ts:22` does
  (`describe.skipIf(process.platform === 'win32')`).

## Commands you will need

| Purpose         | Command                                                      | Expected on success |
| --------------- | ------------------------------------------------------------ | ------------------- |
| Install deps    | `aube install`                                               | exit 0              |
| Typecheck       | `npm run typecheck`                                          | exit 0, no errors   |
| Lint            | `npm run lint`                                               | exit 0              |
| Format (fix)    | `npm run format`                                             | exit 0              |
| Format check    | `npm run format:check`                                       | exit 0              |
| Run one test    | `npx vitest run test/integration/state-permissions.test.ts`  | all pass            |
| Permission set  | `npx vitest run test/integration/socket-permissions.test.ts` | all pass            |
| Integration set | `npm run test:integration`                                   | all pass            |

(Exact commands from this repo, verified during recon. `aube` is the package
manager — do **not** use `npm install`. If `mise` is available, `mise run
typecheck` / `mise run lint` / `mise run test` are equivalent.)

## Scope

**In scope** (the only files you should modify):

- `src/storage/home.ts` — chmod the Home directory to `0o700` when we create it.
- `src/host/lifecycle.ts` — chmod each session directory to `0o700`.
- `src/host/eventLog.ts` — chmod the event log file to `0o600` after opening.
- `test/integration/state-permissions.test.ts` (**create**) — asserts the new
  modes. (Alternatively add cases to `socket-permissions.test.ts`; a new file is
  cleaner. Pick one — do not duplicate.)

**Out of scope** (do NOT touch, even though they look related):

- `src/host/hostMain.ts` / `src/host/rpcServer.ts` — the socket dir/file chmods
  already exist (plan 001). Don't re-touch them.
- `src/storage/manifests.ts` — `writeTextFileAtomic` already writes `0o600`
  (plan 001). Don't change it.
- `src/storage/sessionPaths.ts` — path construction is traversal-guarded; don't
  change it.
- `src/storage/artifactPaths.ts` — the artifacts subdirectory lives **inside**
  the session directory, so a `0o700` session dir already protects it
  transitively. Do not add a separate chmod there.
- `CHANGELOG.md` — automation-owned (Communique/release-please). A manual edit
  conflicts with `main` and silently breaks `pull_request` CI. Never edit it.
- Public CLI JSON envelopes / protocol schemas — this change is internal only.
- Windows-specific permission behavior — Windows is tier-2; mode bits don't apply.

## Git workflow

- Branch: `advisor/007-restrict-state-permissions`
- Commit message style: Conventional Commits (CI enforces it on PR titles).
  Example: `fix: restrict agent-tty Home, session dirs, and event log to the owner`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Lock a newly-created Home directory to `0o700`

In `src/storage/home.ts`:

1. Add `chmod` to the line-2 import:
   `import { chmod, mkdir } from 'node:fs/promises';`
2. In `ensureHome`, chmod the Home **only when this call created it**. `mkdir`
   with `{ recursive: true }` returns the path of the first directory created, or
   `undefined` if the directory already existed — use that to avoid changing the
   mode of a pre-existing Home:

```ts
export async function ensureHome(
  configuredHome = process.env.AGENT_TTY_HOME,
): Promise<string> {
  const home = resolveHome(configuredHome);

  const created = await mkdir(home, { recursive: true });
  if (created !== undefined) {
    // Owner-only: the Home lists session directories and the Home Registry.
    // chmod (not mkdir mode) guarantees 0o700 regardless of umask. Only when we
    // created it — never re-mode a Home the user set up themselves.
    await chmod(home, 0o700);
  }

  return home;
}
```

**Verify**: `npm run typecheck` → exit 0, no errors.

### Step 2: Lock each session directory to `0o700`

In `src/host/lifecycle.ts`:

1. Add `chmod` to the line-2 import:
   `import { chmod, mkdir, readdir, stat, unlink } from 'node:fs/promises';`
2. Immediately after the session-directory `mkdir` (~line 380), chmod it. The
   session directory is always freshly created (fresh `ulid`), so chmod is
   unconditional here:

```ts
const sessionDirectory = sessionDir(home, sessionId);
await mkdir(sessionDirectory, { recursive: true });
// Owner-only: this directory holds the event log and all artifacts, so 0o700
// here protects every per-session file regardless of each file's own mode.
await chmod(sessionDirectory, 0o700);
```

**Verify**: `npm run typecheck` → exit 0.

### Step 3: Lock the event log file to `0o600`

In `src/host/eventLog.ts`, inside `EventLog.open`, chmod the file via the open
`FileHandle` (no new import needed — `FileHandle` has a `.chmod` method). Place it
as the **first** statement inside the existing `try`, so a failure still hits the
`catch` that closes the handle:

```ts
    const fileHandle = await open(filePath, 'a');
    try {
      // Defense in depth: even though the session directory is 0o700, lock the
      // event log itself to owner-only — it holds the full terminal byte stream
      // (output plus injected input, which can include secrets).
      await fileHandle.chmod(0o600);

      const fileStats = await fileHandle.stat();
      assertEventLogSize(fileStats.size);
      // ... unchanged ...
```

**Verify**: `npm run typecheck` → exit 0.

### Step 4: Format and static check

Run `npm run format` then `npm run lint` then `npm run format:check`
→ all exit 0.

### Step 5: Add the integration test (see Test plan), then run it

**Verify**: `npx vitest run test/integration/state-permissions.test.ts`
→ all new cases pass.

## Test plan

Create `test/integration/state-permissions.test.ts`, modeled structurally on
`test/integration/socket-permissions.test.ts` (read that file first — copy its
`describe.skipIf(process.platform === 'win32')` guard, its `mkdtemp` + `realpath`
home setup, its `createSession` / `destroySession` / `cleanupHome` helper usage,
and its `(mode & 0o777)` assertion style).

Use helpers from `test/helpers.js`: `createSession`, `destroySession`,
`cleanupHome`, `inspectSession`, `runCli`, `SuccessEnvelope`. Import `stat` from
`node:fs/promises`, `join` from `node:path`.

Cover these cases (one `it`, or split as you prefer):

- **Home directory is `0o700` when agent-tty creates it.** Point
  `AGENT_TTY_HOME` at a **non-existent nested path** so `ensureHome` is what
  creates it (do NOT use the bare `mkdtemp` dir — `mkdtemp` already returns
  `0o700`, which would pass without exercising the new chmod). E.g.:
  ```ts
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'agent-tty-perms-')),
  );
  const home = join(base, 'home'); // does not exist yet
  const sessionId = createSession(home, ['/bin/sh', '-c', 'exec cat']);
  const homeStat = await stat(home);
  expect(homeStat.mode & 0o777).toBe(0o700);
  ```
- **Session directory is `0o700`**: assert
  `(stat(join(home, 'sessions', sessionId)).mode & 0o777) === 0o700`.
- **Event log is `0o600`**: assert
  `(stat(join(home, 'sessions', sessionId, 'events.jsonl')).mode & 0o777) === 0o600`.
  (Confirm the filename is `events.jsonl` — grep `events.jsonl` under `src/storage/`
  if unsure; it is the session's event-log file.)
- **Owner can still drive the session**: a `type` (or `inspect`) against the
  session still returns `status 0` / `ok: true`, proving the tightened perms
  didn't lock out the owner. (Mirror `socket-permissions.test.ts:56-71`.)

Clean up with `destroySession` + `cleanupHome` in `afterEach`, exactly as the
exemplar does. Guard the whole suite to Unix with
`describe.skipIf(process.platform === 'win32')`.

**Verification**: `npx vitest run test/integration/state-permissions.test.ts`
→ all cases pass; then `npm run test:integration` → still all pass (the existing
`socket-permissions` test and lifecycle/gc tests still connect and operate,
because the owner keeps read/write).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0.
- [ ] `npm run lint` exits 0.
- [ ] `npm run format:check` exits 0.
- [ ] `grep -n "chmod" src/storage/home.ts src/host/lifecycle.ts` shows one chmod
      call in each.
- [ ] `grep -n "chmod" src/host/eventLog.ts` shows the `fileHandle.chmod(0o600)` call.
- [ ] `test/integration/state-permissions.test.ts` exists and passes on this (Unix)
      machine via `npx vitest run test/integration/state-permissions.test.ts`.
- [ ] `npm run test:integration` exits 0 (no regression in existing tests).
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row for 007 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the "Current state" locations doesn't match the excerpts (drift
  since commit `5cb9a20`).
- `mkdir(home, { recursive: true })` does **not** return a string-or-undefined as
  Step 1 assumes (e.g. a wrapper changed its signature) — report rather than
  guessing the only-if-created condition.
- After Step 2 or Step 3, any existing integration or e2e test that creates a
  session **fails** — that means the owner is being locked out or a non-owner
  access path exists you weren't told about. Do **not** loosen the mode to make
  it pass; report.
- The session's event-log file is not named `events.jsonl` or lives outside the
  session directory — the file-mode assertion in the test would be wrong; find
  the real path and report before asserting.

## Maintenance notes

- A reviewer should confirm: (a) `chmod` is used (not the `mkdir`/`open` `mode`
  option, which umask would mask); (b) the Home chmod is gated on
  `created !== undefined` so a pre-existing user Home isn't silently re-moded;
  (c) the event-log chmod sits inside the `try` so a failure still closes the
  handle.
- The session-directory `0o700` is the primary control — it protects every file
  inside (event log, snapshots, screenshots, casts/webm, manifest) regardless of
  each file's own mode. The event-log `0o600` is belt-and-suspenders. If a future
  change moves artifacts **outside** the session directory, those new locations
  need their own hardening.
- Deferred out of this plan (and why): hardening the `/tmp/agent-tty/` socket-root
  parent (plan 001 already deferred it; per-Home socket dirs are `0o700`, which is
  sufficient), and any retroactive chmod of event logs in Homes created before
  this change ships (those keep their old mode until rewritten — acceptable; new
  sessions are protected).
