---
status: accepted
---

# Home Registry: an advisory, per-machine, gc-reconciled index of Homes

## Context

`agent-tty` manages **Sessions** under a **Home** — a state root selected by
`--home`/`AGENT_TTY_HOME` (default `~/.agent-tty`) that holds a `sessions/`
tree. `list` and the **Session Dashboard** operate on exactly one **Home**, the
one resolved for that invocation.

There is no way to enumerate **Homes**. The only cross-**Home** artifact is the
per-**Home** socket directory at `/tmp/agent-tty/<sha256(home)[:8]>/`
(`src/storage/sessionPaths.ts`), and that is a dead end for discovery: the name
is a one-way hash (the **Home** path cannot be recovered from it), the directory
is created but never removed when hosts die (`src/host/rpcServer.ts` only
unlinks the per-**Session** socket _file_), and `/tmp` is reboot-ephemeral.

We want the **Session Dashboard** to pick a **Home** and inspect that **Home**'s
**Sessions**, and we want a "which **Homes** am I using" listing comparable to
`list`. That requires persisting the set of **Homes**. Because the docs actively
encourage throwaway **Homes** (`AGENT_TTY_HOME="$(mktemp -d)"`), any persisted
set will accumulate dead entries as those directories are garbage-collected or
`rm -rf`'d.

## Decision

Introduce a **Home Registry**: a persisted, **advisory**, **per-machine** index
of **Homes** that have hosted a **Session**.

- **Location:** `${XDG_STATE_HOME:-~/.local/state}/agent-tty/homes.json`. The
  path is a function of the OS user, never of `AGENT_TTY_HOME` — the registry
  spans **Homes**, so it cannot live inside one (a **Home** is relocatable).
- **Entry shape:** `{ path, lastSeenAt }` only. All **Session** state (active
  counts, statuses) is **derived live** by scanning the **Home** at read time,
  never cached in the registry. `home list` sorts newest-`lastSeenAt`-first,
  mirroring how **Sessions** sort newest-`createdAt`-first.
- **Source of truth is the Home directories.** The registry is reconciled
  _against_ them, never the reverse. A **Home** auto-registers when it first
  hosts a **Session** (on `create`). It is reconciled out by three layered
  mechanisms: **prune-on-read** (listings and the dashboard picker hide **Homes**
  whose directory or `sessions/` is gone), **per-Home gc deregistering** a
  **Home** it empties, and a **cross-Home gc sweep**.
- **`gc` becomes cross-Home by default** — it sweeps the whole **Home
  Registry** — with `--home` (or an explicit `AGENT_TTY_HOME`) scoping it to a
  single **Home**. gc collects Collectable **Session** directories and prunes
  registry entries, but **never deletes a Home directory** (the path is
  user-owned and arbitrary). `home forget <path>` is a non-destructive manual
  deregister.
- **CLI:** a new `home` command group — `home list [--all] [--json]` (**Active
  Homes** by default, `--all` includes terminal-only **Homes**) and
  `home forget <path>`.
- **Dashboard:** the **Session Dashboard** gains a read-only **Home** picker
  (default scope **Active Homes**). Browsing **Homes** does **not** reconcile;
  full reconcile happens only on **Home** entry, exactly as it already does for a
  single **Home**.

## Consequences

- The picker and `home list` never show a stale **Home** (prune-on-read), and
  the file stays small (gc sweep) without `agent-tty` ever deleting a user
  directory.
- Deregistration is safe and idempotent: a deregistered **Home** re-registers
  the next time it hosts a **Session**; the registry gates nothing.
- **Cross-machine sharing of a Home is unsupported.** Cross-**Home** gc
  reconciles **Sessions** across every registered **Home**, and reconciliation
  judges liveness with local PIDs (`isProcessAlive` = `process.kill(pid, 0)`)
  and SIGKILLs dead-host orphans (`killProcessBestEffort` =
  `process.kill(pid, 'SIGKILL')`, `src/host/lifecycle.ts`). Manifests carry no
  machine identity (`src/protocol/schemas.ts` records only `hostPid`/`childPid`).
  So a **Home** shared across machines (e.g. NFS) is a hazard: a cross-**Home**
  gc on machine B could mark machine A's live **Session** `failed` and SIGKILL
  an unrelated local PID. The per-machine, local-only boundary contains this and
  matches the Coder model (separate workspaces are separate machines and
  filesystems, each with its own registry).
- **Backward-incompatible CLI change:** plain `gc` changes from "collect the
  default **Home**" to "sweep all registered **Homes**." Automation that relied
  on `gc` meaning the default **Home** must pass `--home`.

## Alternatives considered

- **An authoritative registry** (add/remove are the only way **Homes** exist).
  Rejected: it becomes a second source of truth that can disagree with the
  filesystem (a `rm -rf`'d **Home**, or a **Home** created before this feature).
  An advisory index reconciled at read time never diverges.
- **Deriving active Homes from the `/tmp` socket tree** instead of persisting.
  Rejected: the directory name is a one-way hash (no path recovery), socket
  directories linger after hosts die (false "active"), the tree is
  reboot-ephemeral, and it could never surface terminal-only **Homes** for
  offline replay.
- **A machine-identity guard now** (stamp manifests with a machine id; skip
  reconcile/kill for **Sessions** whose id ≠ current). Deferred, not rejected: it
  is the right hardening _if_ shared-filesystem or remote-aggregation **Homes**
  ever come into scope, but it is unjustified for v1 given the per-machine
  boundary and the Coder model. Tracked as follow-up.
- **gc deletes emptied Home directories.** Rejected: `--home` is an arbitrary,
  user-owned path; a stale registry entry plus `rm -rf` is a footgun. gc stops
  at **Session** directories and registry entries; the **Home** directory is the
  user's to delete.
