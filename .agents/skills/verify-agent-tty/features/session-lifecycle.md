# Session lifecycle

A user creates a long-lived terminal session that runs one program, sees it in `list` and `inspect`, ends it with `destroy`, and removes finished sessions with `gc`. Each Home is also recorded in the per-machine Home Registry, which `home list` shows.

## Sub-features

- `life-create` starts a program in a new session and returns its ID.
- `life-list` lists active sessions, and with `--all` the finished ones too.
- `life-inspect` reports the session record, host state and event log size.
- `life-destroy` ends a running session and marks it `destroyed`.
- `life-exit` records the program's own exit as `exited` with its exit code.
- `life-gc` removes finished sessions and skips running ones.
- `life-home-list` shows the Home in the Home Registry: with an active session, or always with `--all`.

## How to get to it (user POV)

- `agent-tty create [options] -- <command...>`, with `--name`, `--cols`, `--rows`, `--env KEY=VALUE`, `--cwd`, `--idle-timeout-ms`.
- `agent-tty list` (alias `ls`), `agent-tty list --all`.
- `agent-tty inspect <session-id>`.
- `agent-tty destroy <session-id>`, `agent-tty destroy <session-id> --force`.
- `agent-tty gc`, with `--dry-run`, `--stale-only`, `--older-than <30m|1h|7d>`.
- `agent-tty home list`, `agent-tty home list --all`.

## Driving it with att

Preconditions:

- `mkdir -p "$EVIDENCE/life"` has run. The recipe saves its proof there.
- The baseline preconditions in the README hold, and the run's Home has no sessions (`att list --all --json` shows `"sessions":[]`).

- **Create.** Run `S=$(att create --json --name life -- node --import tsx test/fixtures/apps/hello-prompt/main.ts | tee "$EVIDENCE/life/create.json" | jq -r .result.sessionId)`. Exit code 0, and `.result` has `sessionId`, `createdAt`, `cols: 80`, `rows: 24`.
- **Ready.** Run `att wait "$S" --regex 'READY>$' --scope cursor-line --timeout 10000 --json`. `.result.matched` is `true`.
- **List.** Run `att list --json`. One entry has `sessionId` `$S`, `status: "running"` and a numeric `pid`.
- **Inspect.** Run `att inspect "$S" --json`. `.result.session.status` is `running`, and `.result` also has `host`, `eventCount`, `eventLogBytes` and `artifacts`.
- **Program exit.** Run `att type "$S" 'exit-code 3' --append-newline --json`, then `att wait "$S" --exit --timeout 10000 --json`. `.result` is `{"timedOut":false,"exitCode":3}`, and `$AGENT_TTY_HOME/sessions/$S/session.json` has `status: "exited"` and `exitCode: 3`.
- **Refuse input after exit.** Run `att type "$S" more --json`. Exit code 4, `.error.code` is `SESSION_NOT_RUNNING`.
- **Destroy.** Create a second session `D` as in step 1 and run `att destroy "$D" --json`. `.result` is `{"sessionId":"<D>","destroyed":true}`, and `att list --all --json` shows `D` as `destroyed`. A second `att destroy "$D" --json` exits 4 with `SESSION_ALREADY_DESTROYED`.
- **Not found.** Run `att inspect 01NOSUCHSESSION --json`. Exit code 3, `SESSION_NOT_FOUND`.
- **Home Registry.** Run `att home list --all --json`. `.result.homes[0].path` is `$AGENT_TTY_HOME`. Without `--all`, `home list` shows only Homes with an active session, so it is empty at this point.
- **gc.** Create a third session `R` that keeps running, then run `att gc --json | tee "$EVIDENCE/life/gc.json"`. `.result.homes[0].removedSessions` lists `S` and `D`, `skippedSessions` lists `R` with the reason `session host is still alive`, and the folders of `S` and `D` are gone from `$AGENT_TTY_HOME/sessions/`.

## Gotchas

- `gc` without `AGENT_TTY_HOME` or `--home` sweeps every Home in the Home Registry, including your own. `env.sh` sets both `AGENT_TTY_HOME` and a private `XDG_STATE_HOME`; never run `gc` in a shell that did not source it.
- `gc --dry-run` removes nothing but still reconciles: it rewrites `session.json` of sessions whose host died. Do not use it as a read-only probe.
- `list` without `--all` hides finished sessions. Use `--all` before you claim that a session is gone.
- agent-tty resolves the Home to a real path. When `$TMPDIR` goes through a symlink, paths in envelopes differ from the path you passed. `start-run.sh` resolves the run folder for this reason.
