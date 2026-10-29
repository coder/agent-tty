---
name: verify-agent-tty
description: Drive the real agent-tty CLI built from this checkout, the way a user or agent does, and capture proof - JSON envelopes, rendered snapshots, PNG screenshots, recordings, and the session files on disk - in an isolated Home that never touches ~/.agent-tty. Use it to verify a change to any agent-tty command (create, run, wait, batch, snapshot, screenshot, record, gc, dashboard) end to end before you call it done, or to reproduce a reported CLI or TUI bug.
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

1. If `node_modules/.bin/tsc` is missing (a partial install), it runs `aube ci`. Otherwise it runs `aube install --frozen-lockfile`, which brings `node_modules` up to date after a change to `aube-lock.yaml` and returns at once when nothing changed. Without that, a run after a dependency change builds and runs the old packages.
2. It runs `npm run build`. If `dist/cli/main.js` is still older than a file in `src/`, it removes `.tsconfig.build.tsbuildinfo` and `dist/` and builds again. A stale build info file makes `tsc` exit 0 and write nothing.
3. It makes the run folder `<root>/<UTC time>-<name>-<random>/` with `mktemp -d`, and `home/`, `state/` and `evidence/` in it. The root is `$VERIFY_ROOT`, or `${TMPDIR:-/tmp}/verify-agent-tty-<uid>`. The script refuses a root that is a symlink or that you do not own, and sets it to mode 700, so another user on a shared machine cannot plant files there.
4. It writes `env.sh` there and prints its path.

`env.sh` sets `AGENT_TTY_HOME` (the run's `home/`), `XDG_STATE_HOME` (the run's `state/`, so the Home Registry is private), `EVIDENCE`, `VERIFY_RUN`, `AGENT_TTY_REPO`, and `NODE_OPTIONS=--disable-warning=DEP0205`, as the tests set it. It turns on `set -o pipefail`, so `att ... | tee file` keeps the CLI's exit status. It also defines `att`, which runs `node $AGENT_TTY_REPO/dist/cli/main.js`, exactly what the `agent-tty` bin runs.

Every bash call is a new shell, so start each one with `. "$ENV"` (keep the path from the first call). The CLI is ready when `doctor.sh` passes. Rebuild with a new `start-run.sh` after every change to `src/`: `att` runs `dist/`, not the source.

To drive the source without a build, use `node --import tsx src/cli/main.ts` instead of `att`. Public skill text must still say `agent-tty ...`.

## Doctor

Run this first, and again whenever a result looks wrong:

```sh
.agents/skills/verify-agent-tty/scripts/doctor.sh "$ENV"
```

It checks that the Home and the Home Registry are this run's and not `~/.agent-tty`, that `dist/` is newer than `src/`, that `att version --json` reports the `package.json` version, and that `att doctor --json` passes (PTY spawn, socket, atomic writes, Playwright Chromium, ghostty-web, libghostty-vt). It prints the sessions in the run's Home and the processes the run started. Exit 0 means the run is worth driving. `agent-tty doctor` creates and removes one probe session in the run's Home. Nothing outside the run folder changes.

## Drive

The harness is the CLI itself, run as `att <command> ... --json`, with `jq` to read the envelope. Every envelope has `ok`, `command`, `timestamp`, and `result` or `error.code`. The exit code comes from `src/cli/exitCodes.ts` (for example 3 `SESSION_NOT_FOUND`, 4 `SESSION_NOT_RUNNING`, 6 `HOST_UNREACHABLE`, 11 `WAIT_TIMEOUT`).

- Start programs with `att create --json -- <argv>` and keep `.result.sessionId`.
- Use the fixture apps in `test/fixtures/apps/` as the programs under test. Start them with `node --import tsx test/fixtures/apps/<app>/main.ts` from the repo root, as `test/e2e/helpers.ts` does. `hello-prompt` prints `READY> `, answers each line with `ECHO: <line>`, exits on `exit` or `exit-code <n>`, and prints `INTERRUPTED` and exits 130 on Ctrl+C.
- For a shell, use `att create --json --env 'PS1=$ ' -- /bin/bash --noprofile --norc`. A plain `/bin/bash` loads your own prompt and dotfiles, so its screen differs between machines.
- Wait on what the screen shows with `att wait`, never `sleep`. Always pass `--timeout <ms>`: the default is 10 minutes.
- For the TUI, run `att dashboard` as the program of an agent-tty session and drive it with `send-keys`, `wait` and `snapshot`. `features/dashboard.md` has the recipe.

## Evidence

Put every proof under `$EVIDENCE/<feature>/`, and make that folder with `mkdir -p` before the first `tee` into it. `$EVIDENCE` survives cleanup. The proof standards:

- Drive the real user path: the built CLI, its public commands and flags, and real programs. Do not call internal functions, do not use the hidden `_host` command, and do not write `session.json` by hand. The fixture apps are real programs, not mocks.
- Capture the action and the result: save each command line and its JSON envelope (`att ... --json | tee "$EVIDENCE/<feature>/<step>.json"`) and its exit code, plus the screen after it (`snapshot --format text --json`, and `screenshot` when the look matters).
- Check side effects on disk next to what the CLI reports: `$AGENT_TTY_HOME/sessions/<id>/session.json` (status, exit code, `failureOrigin`), `events.jsonl` (the event types in order), and `artifacts/manifest.json` plus the files it lists.
- A flag that sounds read-only can still write. `gc --dry-run` removes nothing, but it still reconciles: it rewrites `session.json` of sessions whose host is gone, and it can mark a session that is starting as `failed` (finding F1 in the `verify-session-lifecycle` skill). Check the files, not the flag name.
- Copy each PNG you cite into `$EVIDENCE` and look at it (attach it, or open it). A screenshot that exists is not a screenshot that shows the right thing.

## Cleanup

```sh
.agents/skills/verify-agent-tty/scripts/cleanup.sh "$ENV"
```

It destroys every active session of the run through `att destroy` (then `--force` if needed), waits up to 10 seconds for the run's processes to end, and stops only the ones that are left. Those are the session hosts that carry this run's `AGENT_TTY_HOME` and the programs that carry the `AGENT_TTY_SESSION_ID` of one of this run's sessions, as `run-pids.sh` lists them. It never kills by process name. It then copies each session's `session.json`, `events.jsonl` and `artifacts/` into `$EVIDENCE/sessions/`, removes the run's socket folder `/tmp/agent-tty/<hash>` if it is empty, and removes `home/` and `state/`. `$EVIDENCE` stays. It keeps `home/` and `state/` and exits 1 when the copy fails, or when there is no `/proc` (macOS): then it cannot confirm that every process of the run has ended, so stop them and remove the two folders yourself. Run cleanup after every run, also after a failed one.

## Helpers

All scripts take the run's `env.sh` path, except `start-run.sh`:

| Script                         | Use                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `scripts/start-run.sh [name]`  | Sync deps with the lockfile, build, make the run folder, print the `env.sh` path. |
| `scripts/doctor.sh <env.sh>`   | Check that the run is worth driving. Exit 0 or 1.                                 |
| `scripts/run-pids.sh <env.sh>` | Print the PIDs of the hosts and programs this run started (Linux, reads `/proc`). |
| `scripts/cleanup.sh <env.sh>`  | Tear the run down and keep the evidence.                                          |

## Keep the map honest

When a change adds, removes or renames a command, a flag, a key binding or a visible message, update the matching file in `features/`, or add one. Use `/maintain-verification-skill` (a pstack plugin skill) to bring the map back in line with the app.
