---
name: verify-session-lifecycle
description: TLA+ model check of the agent-tty session lifecycle when several agent-tty processes use one Home at the same time - create, the session host (start-up, resize, exit), reconcileSession (list, inspect, destroy, gc) and gc. Use it before you change src/host/lifecycle.ts, the start-up or exit path of src/host/hostMain.ts, src/cli/commands/gc.ts, src/cli/commands/create.ts, src/storage/manifests.ts or src/protocol/sessionStatusPolicy.ts, before you add a new writer of session.json, and when you must know whether a race can delete a session or corrupt its status.
---

# Verify the session lifecycle (TLA+)

Many agents share one Home (`~/.agent-tty` by default). Each agent-tty command is its own process, and they all read and write the same `session.json` files with no lock. A test runs one order of those steps. This check runs every order of them in a small model of one session, and it reports any order that breaks a rule below.

The model is `model/SessionLifecycle.tla`. Each action in it is one indivisible step of the real code: one file read, the rename that makes a manifest write visible, one `rm`, one unlink, a process start or end, or a block of synchronous code with no `await` in it. Every action has a comment that names the code it stands for.

The tool is TLC, the TLA+ model checker, pinned to release 1.7.4 by sha256. The question here is "can these steps happen in a bad order", and a model checker answers that for every order. No verifier runs on this TypeScript code across processes.

## The rules

| Rule                         | What must hold                                                                      | Harm when it breaks                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| R1 `NoLiveSessionDeleted`    | gc never removes the folder of a session whose host can still write to it.          | A running or starting session loses its manifest and event log.           |
| R2 `HostDeathOnlyWhenDead`   | The manifest says "failed, host died" only when the host process is dead.           | `list` and `inspect` show a live session as failed. Commands refuse it.   |
| R3 `TerminalIsFinal`         | Once the manifest shows exited, failed or destroyed, it never shows running again.  | A finished session looks running, and the next reconcile marks it failed. |
| R4 `RecordedExitKept`        | Once the manifest records that the program exited, no process replaces that record. | A program that exited 0 is reported as failed, with its exit code lost.   |
| R5 `RunningSessionReachable` | While the host serves a running program, the socket file exists.                    | The session runs, but no command can reach it.                            |

`TypeOK` also runs in every run. When it breaks, the model is wrong, not the code.

## Does your change touch this?

Yes, when the diff changes any of these:

- `src/host/lifecycle.ts`: `allocateSession`, `launchHost`, `isProcessAlive`, `reconcileSession`.
- `src/host/hostMain.ts` `runHost`: the start-up statements (`readManifest`, `setHostPid`, `EventLog.open`, `createPty`, `setChildPid`), `initiateShutdown`, `handlePtyExit`, `pty.onExit`, the `resize` handler, and the last `try` block (the start-up `writeManifest` and `rpcServer.listen`).
- `src/cli/commands/gc.ts` `gcSessions` and `src/cli/commands/create.ts` `runCreateCommand`.
- `src/host/sessionState.ts` `setHostPid` and `recordExit`, `src/host/eventLog.ts` `EventLog.open`, `src/host/rpcServer.ts` `listen` and `close`.
- `src/storage/manifests.ts` `readValidatedJsonFile`, `writeTextFileAtomic`, `writeManifest`.
- The `SESSION_STATUS_POLICIES` table in `src/protocol/sessionStatusPolicy.ts`.
- Any new or removed call to `writeManifest`, `writeValidatedJsonFile`, `writeTextFileAtomic`, `manifestPath` or `reconcileSession` (also through an import alias), or a recursive `rm` (one with `recursive: true`, whatever its argument is named), anywhere in `src/`.
- This skill's `model/SessionLifecycle.tla`, `scripts/facts.mjs` and `scripts/check.sh`: an edit to them also needs a new confirmed `coverage.json`.

You do not have to judge this by hand. The check prints `STALE` when any of these changed since the sync commit.

## Run it

From the repo root:

```sh
.agents/skills/verify-session-lifecycle/scripts/check.sh
```

It needs `node`, Java 11 or newer (`java -version`), and the network once: the first run downloads `tla2tools.jar` 1.7.4 into this skill's `.cache/` folder (git ignores it) and checks its sha256. On this repo it takes about 10 seconds. `JAVA=/path/to/java` picks another Java. `TLA2TOOLS_JAR=/path/to/tla2tools.jar` uses a jar you already have, which must be the same 1.7.4 build. `CHECK_OUT=<folder>` keeps the results in that folder (default: a new temp folder, printed at the end).

What it does:

1. `scripts/facts.mjs` reads the code with the TypeScript compiler. It finds the four guards that the rules depend on and the status sets of the policy table, and it hashes each covered function with comments and layout removed.
2. It writes one TLC config per run, with those facts as constants. A guard that is not in the code, in the expected place and order, reads FALSE, and the model then runs without it.
3. It runs TLC 19 times and prints one line per run.
4. It compares the hashes and call sites with `coverage.json`.

Exit codes: 0 means every run gave the expected result and the covered code matches the sync record. 1 means at least one run gave an unexpected result; the line says `UNEXPECTED`. 3 means every result was as expected, but covered code changed since the sync commit; that is not a pass, so follow "When you change covered code on purpose". 2 means a tool could not run. When both 1 and 3 apply, the exit code is 1.

## Read the result

At the sync commit, the expected results are:

| Runs                                                                                    | Expected | Why                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `current-<rule>`, one per rule, the code as it is                                       | violated | The open findings F1, F2 and F3 below break every rule.                                                                                                                                                                                                             |
| `finding-F1`, `finding-F2`, `finding-F3`                                                | violated | Each run leaves one finding open and assumes the other two fixed, so each finding still shows.                                                                                                                                                                      |
| `residual`                                                                              | pass     | With F1, F2 and F3 assumed fixed, every rule holds. This is the run that catches a new bug.                                                                                                                                                                         |
| `witness-*`                                                                             | violated | Each witness is a state that must be reachable: gc removes a session, a session serves, a resize lands, a clean exit is recorded, a crash is reconciled. A witness that passes means the model can no longer reach that state, and the passing rules prove nothing. |
| `mutant-ReconcileSkipsTerminal`, `mutant-ReconcileSkipsLiveHost`, `mutant-GcBothChecks` | violated | Each run removes a guard from the residual model and checks only the rule that the guard protects. That rule must break, which shows the check can fail.                                                                                                            |
| `mutant-GcSkipsNonCollectable`, `mutant-GcFinalCheck`                                   | pass     | gc checks "collectable" twice. One check alone still keeps R1, so removing one is safe. Removing both is not.                                                                                                                                                       |

The three `Close*` constants in the model are the assumptions "F1, F2 or F3 is fixed". Only the `finding-*`, `residual`, `witness-*` and `mutant-*` runs set them. They never describe the code.

Read `residual` first. The witness and mutant runs use the same facts from the code, so a code change that breaks `residual` can also turn them `UNEXPECTED`.

A guard reads FALSE when its condition text, its place or its order differs from what `scripts/facts.mjs` looks for, also after a refactor that kept the behavior. So when a run turns `UNEXPECTED` and the `Facts:` line shows a guard FALSE, first read the guard in the code. If it is still there and still does the same thing, update its pattern in `scripts/facts.mjs` (step 3 of "When you change covered code on purpose"). That is drift in the check, not a bug.

For every violated run, read the counterexample with the `/statechart` skill (the `statechart` skill of the pstack plugin). Each run has its own folder under the results folder. Give `/statechart` that folder's `SessionLifecycle.tla` as the spec and its `SessionLifecycle.cfg` as the config, and give it `model/statechart-view.mjs` from this skill as its view module. The view labels each state and step in the words of this SKILL.md. `/statechart` prints the shortest path to each broken rule as numbered steps. The check also writes the bare action names of each counterexample to `actions.txt` in the run folder.

### Bug or modeling error

A counterexample is a bug only if every step can happen in the real code. Map each step to the code that its action comment names. Then replay the path against the real CLI. `scripts/replay-hold.mjs` holds one file-system call in one agent-tty process, so you can force the order that the trace shows. It changes timing only. Its header comment explains `REPLAY_HOLD`. Use an isolated run of the `verify-agent-tty` skill for every replay:

```sh
ENV_FILE=$(.agents/skills/verify-agent-tty/scripts/start-run.sh replay)
. "$ENV_FILE"
export NODE_NO_WARNINGS=1
HOLD="--import $PWD/.agents/skills/verify-session-lifecycle/scripts/replay-hold.mjs"
```

The model's "other command" can reconcile at any time. In the real code, `gc`, `gc --dry-run` and the `create` time-out always reconcile. `list`, `inspect` and the dashboard first read the manifest themselves and reconcile only a session whose status is active. So when a trace has that command reconcile a terminal manifest, replay it with `gc --dry-run`: `list` skips that session unless it races.

After a replay, run `.agents/skills/verify-agent-tty/scripts/cleanup.sh "$ENV_FILE"`. It destroys the run's sessions, stops every process that carries the run's `AGENT_TTY_HOME` (also the live host of a session that a replay left `failed`, which `list` does not show), and only then removes the run's home and state folders.

If a step cannot happen in the code, the model is wrong: fix the model, and say what was wrong. If the replay shows the break, it is a bug: report it with the steps and the harm, and do not weaken a rule or the model to make the run pass.

## Open findings at the sync commit

### F1: reconcile treats a starting session as dead (R1, R2, R5, and R3)

1. `create` runs `allocateSession`, which writes `session.json` with status `running` and `hostPid: null`.
2. `create` calls `launchHost` and drops the pid that it returns.
3. The host records its pid only in its first manifest write, the `await writeManifest(mPath, state.snapshot())` in the last `try` block of `runHost`, after it has read the manifest, opened the event log and spawned the program.
4. Before that write lands, another command calls `reconcileSession`: `gc`, `gc --dry-run`, `list`, `inspect`, `destroy`, or the dashboard.
5. `reconcileSession` reads `hostPid: null`. `manifest.hostPid !== null && hostAlive` is false, so it writes `failed` with `failureOrigin: "host-death"` and unlinks the socket file.
6. In `gc`, `manifestAfter` is `failed`, which is collectable, the final check reads `failed` too, and gc removes the session folder.

Harm: `gc` deletes a session that another agent is creating, and that `create` fails with `HOST_UNREACHABLE` (exit 6). If the host's start-up write lands after the removal, it brings back a folder that holds only `session.json`, and the event log is gone. When the reconcile comes from `list` or `inspect`, a starting session reads as failed while its host runs. If that reconcile's write lands after the host started listening, the host keeps running with its socket file unlinked, and no command can reach the session.

It happens without any hold. A `gc` started at the same moment as a `create` removed the new session on the first try. With `agent-tty dashboard` open on the Home (it calls `listSessions`, so it reconciles every 1.5 seconds), 4 of 20 back-to-back `create` calls of the built CLI failed with `HOST_UNREACHABLE`, and those sessions stayed `failed`, `host-death`. Replay it on purpose:

```sh
LOG=$(mktemp)
REPLAY_LOG=$LOG REPLAY_HOLD='_host:rename:/session.json:1:4000' NODE_OPTIONS="$HOLD" \
  node --import tsx src/cli/main.ts create --json -- sleep 30 &
until grep -q hold "$LOG"; do sleep 0.1; done   # the host holds its start-up write
node --import tsx src/cli/main.ts gc --json      # removedSessions lists the new session
wait                                             # create fails: HOST_UNREACHABLE
```

### F2: reconcile writes over an exit that it did not read (R4)

1. A session's program runs, and its manifest says `running` with a `hostPid`.
2. `list`, `inspect` or `gc` calls `reconcileSession`, which reads `running`.
3. Before its `isProcessAlive` check, the program exits, the host writes `exited` with the exit code, and the host process ends.
4. The check finds the host dead, so `reconcileSession` writes `failed`, `host-death` and `exitCode: null`, from the copy it read in step 2.

Harm: a program that exited 0 is reported as failed, and its exit code is lost from the manifest, though `events.jsonl` still holds the `exit` event. The window is the time between one file read and the next line of code, so it is rare. A hold shows it:

```sh
node --import tsx src/cli/main.ts create --json -- sh -c 'sleep 5'
REPLAY_HOLD='list:readFile:/session.json:2:8000' NODE_OPTIONS="$HOLD" \
  node --import tsx src/cli/main.ts list --json
cat "$AGENT_TTY_HOME"/sessions/*/session.json   # failed, host-death, exitCode null
```

### F3: a late host write replaces the exit record (R3, R4)

1. The host spawns the program and, in the same synchronous block, starts its start-up manifest write: `running`, with both pids.
2. The program exits at once, as `create -- true` does, and `handlePtyExit` writes `exited`.
3. Nothing orders the two writes. When the start-up write's rename lands second, the manifest says `running` again, with `exitCode: null`.
4. The host ends. The next reconcile marks the session `failed`, `host-death`.

The `resize` handler's write can land after the exit write in the same way. Harm: as in F2. 60 runs of `create -- true` without a hold did not hit it. A hold on the start-up rename shows it:

```sh
REPLAY_HOLD='_host:rename:/session.json:1:1500' NODE_OPTIONS="$HOLD" \
  node --import tsx src/cli/main.ts create --json -- true
sleep 2; node --import tsx src/cli/main.ts list --all --json   # status: failed
```

## When you change covered code on purpose

1. Read the diff of every item that `STALE` lists, and the commits that the check prints. For a change that is not committed yet, read `git diff`.
2. Decide for each change: it does not alter what an action describes (formatting, a renamed local, an unrelated branch), or the model must change (a step split in two, a guard moved, a new writer of `session.json`, a new reconcile caller with a different flow), or the promise changed on purpose (cite the evidence: the doc comment, `CONTEXT.md`, the tests, the commit message).
3. Update the model from the code, not from the result. One indivisible step in the code stays one action, and its comment names the code. If a guard moved, update its pattern in `scripts/facts.mjs`.
4. Run the check. For a new or changed guard, break it once in a scratch edit of the real code (delete it, or move it after the write it guards) and confirm that a run turns `UNEXPECTED`. Then drop the scratch edit.
5. When the model describes the code again, run `scripts/check.sh --update-coverage` and commit `coverage.json` with the model change. That commit becomes the sync commit.

When you fix F1, F2 or F3, its `finding-*` run turns `pass` and the check reports it as `UNEXPECTED`. That is the signal that the fix works in the model. Then model the fix as real actions (for example a new `create` step that writes the host pid). Do not set a `Close*` constant to describe the fix. Remove the finding from the `Close*` lists, the `finding-*` runs and the expectations in `scripts/check.sh`, rerun, and move the finding out of this file.

To bring the check back in line after changes that skipped it, use `/maintain-formal-verification-skill` (a pstack plugin skill).

## Scope

The model checks every order of these steps for one session: one `create`, its host, one `gc` pass over that session (not `--dry-run`), one other command that reconciles twice, one resize, a program exit at any time, and a host crash at any time. The whole current-code model has 27,113 distinct states, and the residual model has 2,794. The check prints only the residual count, because each violated run stops at its first violation.

It assumes:

- A pid is not reused while the check looks at it, so `isProcessAlive(hostPid)` is true exactly while the host lives.
- A manifest write is atomic, because `writeTextFileAtomic` renames a temp file. A write that fails counts as a host crash or a failed command.
- gc's `rm(sessionDirectory, { recursive: true })` is one step, though the real `rm` deletes file by file. A host write that lands in the middle of it can only make F1 worse.
- Steps that only lead to the same outcome are joined: gc's `readdir` and `stat` (both only skip), the host's `EventLog.open` and `createPty` (synchronous after the open), and `recordExit` with the `exit` event append (no other process sees them).

It leaves out: `destroy` and the `destroying`/`destroyed` writes, a SIGTERM shutdown, `gc --stale-only` and `--older-than` (they only skip more), `gc --dry-run` (the other command covers its reconcile), the `rm` in `create`'s error path and in `doctor`, the Home registry, the contents of the event log and of the renderer, the kill of a child process whose host died, and the socket liveness probe in `rpcServer.listen`. A pass covers the model, not the whole product.

## Coverage record

The sync commit is the last commit that changed `coverage.json`. `check.sh` prints it, and `git log -1 --format=%h -- .agents/skills/verify-session-lifecycle/coverage.json` shows it too. In that commit, someone read the covered code above and confirmed that the model describes it. `coverage.json` holds the hash of each covered function, of the model and of the two check scripts, and the list of call sites at that commit. The check compares them with the code on every run.

Change `coverage.json` (with `check.sh --update-coverage`) only in the same commit as a confirmed model, or after you have confirmed that the model still describes the changed code. Because the sync commit comes from git, a squash merge keeps it correct.

## Files

- `model/SessionLifecycle.tla`: the model and the rules.
- `model/statechart-view.mjs`: plain-word labels for `/statechart`.
- `scripts/check.sh`: the one command.
- `scripts/facts.mjs`: reads the guards, the policy sets, the hashes and the call sites from the code.
- `scripts/replay-hold.mjs`: holds one file-system call to replay a trace against the real CLI.
- `coverage.json`: the sync record that `check.sh` compares with.
