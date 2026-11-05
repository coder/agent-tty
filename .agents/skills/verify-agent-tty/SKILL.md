---
name: verify-agent-tty
description: Drive the real agent-tty CLI built from this checkout, the way a user or agent does, and capture proof - JSON envelopes, rendered snapshots, PNG screenshots, recordings, and the session files on disk - in an isolated Home that never touches ~/.agent-tty. Use it to verify a change to any agent-tty command (create, run, wait, batch, mouse, snapshot, screenshot, record, gc, dashboard) end to end before you call it done, or to reproduce a reported CLI or TUI bug.
---

# Verify agent-tty by driving the CLI

agent-tty is a CLI. Users and agents touch three surfaces: the `agent-tty` commands with `--json` envelopes (the main one), the `agent-tty dashboard` TUI, and the artifacts that commands write (PNG, `.cast`, `.webm`, snapshot JSON). The library export in `src/index.ts` is not covered here.

There is no server to keep alive. Each verification run builds `dist/` once and then drives the built CLI against its own Home. Two runs of the same build can work side by side, because each one has its own Home, its own Home Registry and its own socket folder. All runs of a checkout share its `dist/`, and `start-run.sh` rebuilds it (and can delete it first), so do not start a run while another run of this checkout is still driving sessions on an older build.

The feature map in [`features/README.md`](features/README.md) is the maintained list of user-facing features and how to drive each one. Read it before you drive anything, and drive every entry point that the map lists for the feature you verify.

## Launch

```sh
ENV=$(.agents/skills/verify-agent-tty/scripts/start-run.sh <name>)
. "$ENV"
```

`start-run.sh` does this, from an empty folder to a usable CLI:

1. It runs `pnpm install --frozen-lockfile`, which brings `node_modules` up to date after a change to `pnpm-lock.yaml`, repairs a partial install that lacks `node_modules/.bin`, and returns at once when nothing changed. Without that, a run after a dependency change builds and runs the old packages.
2. It runs `npm run build`. If `stale-dist.sh` then finds a module of `src/` without its built module in `dist/`, or a `.ts` or `.tsx` file in `src/` newer than `dist/cli/main.js`, it removes `.tsconfig.build.tsbuildinfo` and `dist/` and builds again. A stale build info file makes `tsc` exit 0 and write nothing, also when only one built module was deleted.
3. It makes the run folder `<root>/<UTC time>-<name>-<random>/` with `mktemp -d`, and `home/`, `state/` and `evidence/` in it. The root is `$VERIFY_ROOT`, or `${TMPDIR:-/tmp}/verify-agent-tty-<uid>`. The script refuses a root that is a symlink or that you do not own, and sets it to mode 700, so another user on a shared machine cannot plant files there.
4. It writes `env.sh` there and prints its path.

`env.sh` sets `AGENT_TTY_HOME` (the run's `home/`), `XDG_STATE_HOME` (the run's `state/`, so the Home Registry is private), `EVIDENCE`, `VERIFY_RUN`, `AGENT_TTY_REPO`, and `NODE_OPTIONS=--disable-warning=DEP0205`, as the tests set it. It turns on `set -o pipefail`, so `att ... | tee file` keeps the CLI's exit status. It also defines `att`, which runs `node $AGENT_TTY_REPO/dist/cli/main.js`, exactly what the `agent-tty` bin runs, with `HISTFILE=/dev/null`. So an interactive bash in a session that `att create` starts saves no history, and none of it reaches your `~/.bash_history`, while your own shell keeps its history file. The session's `events.jsonl` records every input. `HOME` stays yours, so other programs that keep a history file still write it there. A `~/.bashrc` that sets `HISTFILE` overrides this for an interactive bash session. It also overrides `att create --env HISTFILE=<path>`, because bash reads `~/.bashrc` after its environment. To keep that history out of your file, or to verify bash's own history, skip the startup files and give the session its own file: `att create --env HISTFILE=<path> -- bash --noprofile --norc`.

Every bash call is a new shell, so start each one with `. "$ENV"` (keep the path from the first call). The CLI is ready when `doctor.sh` passes. Rebuild with a new `start-run.sh` after every change to `src/`: `att` runs `dist/`, not the source.

To drive the source without a build, use `node --import tsx src/cli/main.ts` instead of `att`. Public skill text must still say `agent-tty ...`.

## Doctor

Run this first, and again whenever a result looks wrong:

```sh
.agents/skills/verify-agent-tty/scripts/doctor.sh "$ENV"
```

It checks that the Home and the Home Registry are this run's and not `~/.agent-tty`, that `dist/` has a built module for every module of `src/` and is newer than `src/`, that `att version --json` reports the `package.json` version, and that `att doctor --json` passes (PTY spawn, socket, atomic writes, Playwright Chromium, ghostty-web, libghostty-vt). It prints the sessions in the run's Home and the processes the run started. It fails when `run-pids.sh` fails, since `cleanup.sh` would then keep the run's folders. On macOS, where `run-pids.sh` always exits 2 (no `/proc`), it only notes that the list is unknown. Exit 0 means the run is worth driving. `agent-tty doctor` creates and removes one probe session in the run's Home. Nothing outside the run folder changes.

## Drive

The harness is the CLI itself, run as `att <command> ... --json`, with `jq` to read the envelope. Every envelope has `ok`, `command`, `timestamp`, and `result` or `error.code`. The exit code comes from `src/cli/exitCodes.ts` (for example 3 `SESSION_NOT_FOUND`, 4 `SESSION_NOT_RUNNING`, 6 `HOST_UNREACHABLE`, 11 `WAIT_TIMEOUT`).

- Start programs with `att create --json -- <argv>` and keep `.result.sessionId`.
- Use the fixture apps in `test/fixtures/apps/` as the programs under test. Start them with `node --import tsx test/fixtures/apps/<app>/main.ts` from the repo root, as `test/e2e/helpers.ts` does. `hello-prompt` prints `READY> `, answers each line with `ECHO: <line>`, exits on `exit` or `exit-code <n>`, and prints `INTERRUPTED` and exits 130 on Ctrl+C.
- For a shell, use `att create --json --env 'PS1=$ ' -- /bin/bash --noprofile --norc`. A plain `/bin/bash` loads your own prompt and dotfiles, so its screen differs between machines.
- Wait on what the screen shows with `att wait`, never `sleep`. Always pass `--timeout <ms>`: the default is 30 s, for `wait` and for a batch `wait` step.
- For the TUI, run `att dashboard` as the program of an agent-tty session and drive it with `send-keys`, `wait` and `snapshot`. `features/dashboard.md` has the recipe.

## Evidence

Put every proof under `$EVIDENCE/<feature>/`, and make that folder with `mkdir -p` before the first `tee` into it. `$EVIDENCE` survives cleanup. The proof standards:

- Drive the real user path: the built CLI, its public commands and flags, and real programs. Do not call internal functions, do not use the hidden `_host` command, and do not write `session.json` by hand. The fixture apps are real programs, not mocks.
- Capture the action and the result: save each command line and its JSON envelope (`att ... --json | tee "$EVIDENCE/<feature>/<step>.json"`) and its exit code, plus the screen after it (`snapshot --format text --json`, and `screenshot` when the look matters).
- Check side effects on disk next to what the CLI reports: `$AGENT_TTY_HOME/sessions/<id>/session.json` (status, exit code, `failureOrigin`), `events.jsonl` (the event types in order), and `artifacts/manifest.json` plus the files it lists.
- A flag that sounds read-only can still write. `gc --dry-run` removes nothing, but it still reconciles: it rewrites `session.json` of every session whose host is gone. Check the files, not the flag name.
- Copy each PNG you cite into `$EVIDENCE` and look at it (attach it, or open it). A screenshot that exists is not a screenshot that shows the right thing.

## Cleanup

```sh
.agents/skills/verify-agent-tty/scripts/cleanup.sh "$ENV"
```

It destroys every active session of the run through `att destroy` (then `--force` if needed), waits up to 10 seconds for the run's processes to end, and stops only the ones that are left. Those are the session hosts that carry this run's `AGENT_TTY_HOME`, and the programs that carry this run's `AGENT_TTY_HOME` in the terminal session of a session program, or the `AGENT_TTY_SESSION_ID` of one of this run's sessions, as `run-pids.sh` lists them. `run-pids.sh` keeps the PID and the session ID of each session program that it has seen in `<run>/child-pids`, so it still finds the children of that program after its host died and reconcile removed the PID from `session.json`. `cleanup.sh` runs it before its first `att` call. Once no process is left in the terminal session of such a PID, `run-pids.sh` marks the PID of that session ended and never matches it for that session again, so a process that gets the same PID later is not stopped. A later session of the run whose program gets the same PID is matched again. `run-pids.sh` exits 3 on a `<run>/child-pids` from an older version without session IDs: stop that run's processes yourself and start a new run. It never kills by process name, and it skips the processes of the caller's own terminal session.

A program that sets its own `AGENT_TTY_SESSION_ID` with `create --env` is tied to the run only by its terminal session. So after its host died, `run-pids.sh` finds its children only if it read the program's PID before an `att` command such as `att list`, `att inspect`, `att gc` or `att destroy` reconciled the session. A daemon that such a program starts in a new terminal session (`setsid`) is tied to the run by its environment only, which any process can copy, so `run-pids.sh` does not list it and `cleanup.sh` does not stop it. The scan below then keeps `home/` and `state/` until you stop it.

It then copies each session's `session.json`, `events.jsonl` and `artifacts/` into `$EVIDENCE/sessions/`. Before it removes anything, it scans for processes outside the caller's terminal session that still carry this run's `AGENT_TTY_HOME`, also ones that `run-pids.sh` cannot tie to the run, such as a process that you started from another shell that sourced `env.sh`. It also counts a process whose working directory or an open file is in the run's `home/`, `state/` or `removing/`, as `/proc/<pid>/cwd` and `/proc/<pid>/fd` show, whatever its environment and also in your own terminal session, such as `(cd "$AGENT_TTY_HOME"; sleep 60) &`. That check spares only `cleanup.sh` itself, every process that started it (its parent, that parent's parent, and so on) and its own child processes (none when `cleanup.sh` runs as pid 1, because pid 1 also adopts orphans), so you can still run it from a shell inside `home/`. As pid 1 of its own pid namespace with its own `/proc` (for example as the first process of `docker run`), `cleanup.sh` sees only the processes in that namespace, so it cannot see a process outside it that holds `home/`. A cleanup started inside `home/` or `state/` with its output piped, as in `cleanup.sh "$ENV" | tee log` or `| tail`, exits 1: the other end of the pipe is neither, and its working directory is in the run. Run it from outside the run, or redirect its output to a file. It does not check memory-mapped files without an open file descriptor. Linux also refuses to show the working directory and open files of a process that hides its environment, so such a process that started before the run and later moved its working directory into `home/` stays invisible to the scan. The scan reads `/proc/<pid>/environ`, which the kernel lets you read only for your own processes, and not for those among them that hide it: setuid programs, programs with more capabilities than you, and non-dumpable programs (`prctl(PR_SET_DUMPABLE, 0)`, as `ssh-agent` does). The scan counts such a process of yours as a holder if it started after the run began: after the earlier of the time in the run folder's name and the folder's birth time. A hand-made run folder without a time in its name on a file system that records no birth time makes every such process count. Processes from before the run, such as agents and daemons, normally do not carry its path, so they do not block cleanup. The scan cannot read the environment of such a process, so an unrelated one that started during the run, such as `ping`, `ssh-agent` or `coder agent-exec`, also blocks cleanup. Let it end, or stop it if it is yours, then run `cleanup.sh` again. The scan misses one that started before the run and later `exec`s a program that hides its environ with the run's environment. If it finds one, or if `run-pids.sh` failed, it stops nothing more, prints those processes, keeps `home/` and `state/`, and exits 1. Stop them yourself (`kill <pid>`) or let them end, then run `cleanup.sh` again. Otherwise it moves `home/` and `state/` into `<run>/removing/`, so that a process that starts now cannot reach them, and scans again for a process that started between the first scan and the move. If it finds one, it moves the folders back, or says that they are still in `<run>/removing/` when the move fails, and exits 1 in the same way. Then it removes `<run>/removing/` and scans a last time. It exits 1 if a process that started meanwhile carries this run's `AGENT_TTY_HOME`, has its working directory or an open file in the run's `home/`, `state/` or `removing/`, or made a new `home/` or `state/`. Last, it removes the run's socket folder `/tmp/agent-tty/<hash>` if it is empty. `$EVIDENCE` stays. It also keeps `home/` and `state/` and exits 1 when the copy fails, or when there is no `/proc` (macOS): then it cannot confirm that every process of the run has ended, so stop them and remove the two folders yourself. When the removal fails, it exits 1 and leaves the rest in `<run>/removing/`. When `cleanup.sh` finds `home/` or `state/` in `<run>/removing/` (after a failed or interrupted cleanup), it first moves them back, so it destroys, copies and scans them as usual. If a process made a new `home/` meanwhile, it copies the sessions of the run's own `home/` in `<run>/removing/` into `$EVIDENCE/removing/sessions/` before it removes them. Run cleanup after every run, also after a failed one.

## Helpers

All scripts take the run's `env.sh` path, except `start-run.sh`, `stale-dist.sh` and `dependabot-resolve.sh`:

| Script                                            | Use                                                                                                                                                                                |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/start-run.sh [name]`                     | Sync deps with the lockfile, build, make the run folder, print the `env.sh` path.                                                                                                  |
| `scripts/stale-dist.sh`                           | Print why `dist/` is not a complete, current build of `src/`, or nothing.                                                                                                          |
| `scripts/doctor.sh <env.sh>`                      | Check that the run is worth driving. Exit 0 or 1.                                                                                                                                  |
| `scripts/run-pids.sh <env.sh>`                    | Print the PIDs this run started. Exit 2: no `/proc`. Exit 3: ledger error.                                                                                                         |
| `scripts/cleanup.sh <env.sh>`                     | Tear the run down and keep the evidence.                                                                                                                                           |
| `scripts/dependabot-resolve.sh [dep@version ...]` | Replay Dependabot's npm resolve on an empty pnpm store. Run it after a change to `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` or `.github/dependabot.yml`. Exit 0 or 1. |

## Keep the map honest

When a change adds, removes or renames a command, a flag, a key binding or a visible message, update the matching file in `features/`, or add one. Use `/maintain-verification-skill` (a pstack plugin skill) to bring the map back in line with the app.
