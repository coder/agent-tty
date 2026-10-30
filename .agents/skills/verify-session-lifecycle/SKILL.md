---
name: verify-session-lifecycle
description: TLA+ model check of the agent-tty session lifecycle when several agent-tty processes use one Home at the same time - create, the session host (start-up, resize, destroy, SIGTERM shutdown, exit), reconcileSession (list, inspect, destroy, gc), gc and destroy (with and without --force). Use it before you change src/host/lifecycle.ts, the start-up, shutdown or exit path of src/host/hostMain.ts, src/host/manifestWriter.ts, src/cli/commands/gc.ts, src/cli/commands/create.ts, src/cli/commands/destroy.ts, src/storage/manifests.ts or src/protocol/sessionStatusPolicy.ts, before you add a new writer of session.json, and when you must know whether a race can delete a session or corrupt its status.
---

# Verify the session lifecycle (TLA+)

Many agents share one Home (`~/.agent-tty` by default). Each agent-tty command is its own process, and they all read and write the same `session.json` files with no lock. A test runs one order of those steps. This check runs every order of them in a small model of one session, and it reports any order that breaks a rule below.

The model is `model/SessionLifecycle.tla`. Each action in it is one indivisible step of the real code: one file read, the rename that makes a manifest write visible, one `rm`, one unlink, a process start or end, or a block of synchronous code with no `await` in it. Every action has a comment that names the code it stands for.

The tool is TLC, the TLA+ model checker, pinned to release 1.7.4 by sha256. The question here is "can these steps happen in a bad order", and a model checker answers that for every order. No verifier runs on this TypeScript code across processes.

## The rules

| Rule                         | What must hold                                                                                                       | Harm when it breaks                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| R1 `NoLiveSessionDeleted`    | gc never removes the folder of a session whose host can still write to it.                                           | A running or starting session loses its manifest and event log.                                                                           |
| R2 `HostDeathOnlyWhenDead`   | The manifest says "failed, host died" only when the host process is dead.                                            | `list` and `inspect` show a live session as failed. Commands refuse it.                                                                   |
| R3 `TerminalIsFinal`         | Once the manifest shows exited, failed or destroyed, it never shows running again.                                   | A finished session looks running, and the next reconcile marks it failed.                                                                 |
| R4 `RecordedExitKept`        | Once the manifest records that the program exited, only `destroy` changes it, to destroyed, and keeps the exit code. | A program that exited 0 is reported as failed, with its exit code lost.                                                                   |
| R5 `RunningSessionReachable` | While the host serves a running program, the socket file exists.                                                     | The session runs, but no command can reach it.                                                                                            |
| R6 `HostStartsWhenCreated`   | A host never fails to start because another process removed or rewrote its files.                                    | `create` fails with `HOST_UNREACHABLE` for a session nobody touched.                                                                      |
| R7 `TerminalIsLastWrite`     | Once the manifest shows exited, failed or destroyed, the host has no write left to make.                             | gc removes the folder while the host still writes to it. The host's write then fails, or brings the folder back with only `session.json`. |
| R8 `DestroyedOnlyWhenEnded`  | The manifest says destroyed only after the program has ended.                                                        | `list` hides a program that still runs, and gc removes its folder.                                                                        |
| R9 `DestroyEndsDestroyed`    | `destroy` reports success only after it wrote destroyed or read it.                                                  | `destroy` says `destroyed: true`, but the session reads failed, "host process died unexpectedly", until a second `destroy`.               |

`TypeOK` also runs in every run. When it breaks, the model is wrong, not the code.

## Does your change touch this?

Yes, when the diff changes any of these:

- `src/host/lifecycle.ts`: `allocateSession` (and the order of its `launch` call and first manifest write), `launchHost`, `isProcessAlive`, `reconcileSession`, and `destroySession` with its helpers `recordDestroyed`, `stopSessionProcesses`, `readSessionManifestOrThrow`, `waitForTerminalManifest`, `waitForProcessesToExit` and `killProcessBestEffort`.
- `src/host/hostMain.ts`: `waitForManifestFromCreate`, `isSessionCommandable`, and in `runHost` the start-up statements (the manifest wait, the `hostPid === process.pid` check, `createSerialManifestWriter`, `EventLog.open`, `createPty`, `setChildPid`), `initiateShutdown`, `startShutdown`, `handlePtyExit`, `pty.onExit`, the `SIGTERM` handler, the `resize` and `destroy` handlers, and the last `try` block (the start-up manifest write and `rpcServer.listen`).
- `src/host/manifestWriter.ts` `createSerialManifestWriter`.
- `src/cli/commands/gc.ts` `gcSessions`, `src/cli/commands/create.ts` `runCreateCommand` and `src/cli/commands/destroy.ts` `runDestroyCommand`.
- `src/host/sessionState.ts` `setDimensions`, `requestDestroy`, `recordDestroyed` and `recordExit`, `src/host/eventLog.ts` `EventLog.open`, `src/host/rpcServer.ts` `listen` and `close`, `src/host/rpcClient.ts` `toTransportCliError` (which socket errors read as `HOST_UNREACHABLE`).
- `src/storage/manifests.ts` `readValidatedJsonFile`, `writeTextFileAtomic`, `writeValidatedJsonFile`, `writeManifest`.
- The `SESSION_STATUS_POLICIES` table in `src/protocol/sessionStatusPolicy.ts`.
- Any new or removed call to `writeManifest`, `persistManifest`, `writeValidatedJsonFile`, `writeTextFileAtomic`, `manifestPath` or `reconcileSession` (also through an import alias), or a recursive `rm` (one with `recursive: true`, whatever its argument is named), anywhere in `src/`.
- This skill's `model/SessionLifecycle.tla`, `scripts/facts.mjs` and `scripts/check.sh`: an edit to them also needs a new confirmed `coverage.json`.

You do not have to judge this by hand. The check prints `STALE` when any of these changed since the sync commit.

## Run it

From the repo root:

```sh
.agents/skills/verify-session-lifecycle/scripts/check.sh
```

It needs `node`, Java 11 or newer (`java -version`), and the network once: the first run downloads `tla2tools.jar` 1.7.4 into this skill's `.cache/` folder (git ignores it) and checks its sha256. On this repo it takes about 30 seconds. `JAVA=/path/to/java` picks another Java. `TLA2TOOLS_JAR=/path/to/tla2tools.jar` uses a jar you already have, which must be the same 1.7.4 build. `CHECK_OUT=<folder>` keeps the results in that folder (default: a new temp folder, printed at the end).

What it does:

1. `scripts/facts.mjs` reads the code with the TypeScript compiler. It finds the twelve guards that the rules depend on and the status sets of the policy table, and it hashes each covered function with comments and layout removed.
2. It writes one TLC config per run, with those facts as constants. A guard that is not in the code, in the expected place and order, reads FALSE, and the model then runs without it.
3. It runs TLC 24 times and prints one line per run.
4. It compares the hashes and call sites with `coverage.json`.

Exit codes: 0 means every run gave the expected result and the covered code matches the sync record. 1 means at least one run gave an unexpected result; the line says `UNEXPECTED`. 3 means every result was as expected, but covered code changed since the sync commit; that is not a pass, so follow "When you change covered code on purpose". 2 means a tool could not run. When both 1 and 3 apply, the exit code is 1.

## Read the result

At the sync commit, the expected results are:

| Runs                                                                                                                                                                                                                                                                                                               | Expected | Why                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `current`, the code as it is, every rule                                                                                                                                                                                                                                                                           | pass     | No order of the modelled steps breaks a rule. This is the run that catches a new bug.                                                                                                                                                                                                                                                                                                                                     |
| `witness-*`                                                                                                                                                                                                                                                                                                        | violated | Each witness is a state that must be reachable: gc removes a session, a session serves, a resize lands, a clean exit is recorded, a crash is reconciled, a plain destroy completes, a SIGTERM shutdown is recorded, an exited session is destroyed, and `destroy --force` records a live session as destroyed. A witness that passes means the model can no longer reach that state, and the passing rules prove nothing. |
| `mutant-CreateRecordsHostPid`, `mutant-HostWaitsForManifest`, `mutant-ReconcileRereads`, `mutant-HostSerializesWrites`, `mutant-ReconcileSkipsLiveHost`, `mutant-HostStopsAfterTerminalWrite`, `mutant-DestroyRecordsDestroyed`, `mutant-DestroyKeepsExitCode`, `mutant-GcBothChecks`, `mutant-ShutdownBothChecks` | violated | Each run removes a guard from the model and checks only the rule that the guard protects. That rule must break, which shows the check can fail.                                                                                                                                                                                                                                                                           |
| `mutant-ReconcileSkipsTerminal`                                                                                                                                                                                                                                                                                    | pass     | The re-read in `reconcileSession` also returns on a terminal manifest, so the first terminal return alone is redundant.                                                                                                                                                                                                                                                                                                   |
| `mutant-GcSkipsNonCollectable`, `mutant-GcFinalCheck`                                                                                                                                                                                                                                                              | pass     | gc checks "collectable" twice. One check alone still keeps R1, so removing one is safe. Removing both is not.                                                                                                                                                                                                                                                                                                             |
| `mutant-ShutdownChecksCommandable`                                                                                                                                                                                                                                                                                 | pass     | `initiateShutdown` requests destroy only while the session is commandable, and the writer writes nothing after a terminal record. Either one alone keeps R3. Removing both is not safe.                                                                                                                                                                                                                                   |

Read `current` first. The witness and mutant runs use the same facts from the code, so a code change that breaks `current` can also turn them `UNEXPECTED`.

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

## Races the guards prevent

Each of these broke the rules in earlier code. The guard named in each heading closes it, and its mutant run shows the race again when the guard is gone. Each replay drives the real CLI. On the current code, each one must show the safe result in its last comment.

### `CreateRecordsHostPid` and `HostWaitsForManifest`: a starting session read as dead (R1, R2, R5, R6)

Without the guard, `allocateSession` wrote a manifest with `hostPid: null`, and the host recorded its pid only later. A `reconcileSession` in that window (from `gc`, `gc --dry-run`, `list`, `inspect`, `destroy` or the dashboard) read the null pid as a dead host, wrote `failed`, `host-death` and unlinked the socket, and `gc` then removed the folder of the starting session. `create` failed with `HOST_UNREACHABLE`. With the dashboard open, that hit 4 of 20 `create` calls.

Now `allocateSession` calls `launch` first and writes the first manifest with the returned pid, and `runCreateCommand` starts the host only through that callback. Because the host can start before that write lands, `waitForManifestFromCreate` polls for the manifest for as long as the `create` process lives (`launchHost` passes its pid as the second argument of `_host`), and the host then checks that the manifest names its own pid.

```sh
LOG=$(mktemp)
REPLAY_LOG=$LOG REPLAY_HOLD='_host:rename:/session.json:1:4000' NODE_OPTIONS="$HOLD" \
  node --import tsx src/cli/main.ts create --json -- sleep 30 &
until grep -q hold "$LOG"; do sleep 0.1; done   # the host holds its start-up write
node --import tsx src/cli/main.ts gc --json      # skips it: "session host is still alive"
wait                                             # create succeeds
```

### `ReconcileRereads`: a reconcile writes over an exit that it did not read (R4)

Without the guard, `reconcileSession` built its `failed` record from the manifest it read before its `isProcessAlive` check. When the program exited and the host wrote `exited` and ended in between, the reconcile replaced the exit record, and a program that exited 0 read as failed.

Now `reconcileSession` reads the manifest again after it finds the host dead, returns when that copy is terminal, and reconciles from that copy. A dead host cannot write again, so that copy is final.

```sh
node --import tsx src/cli/main.ts create --json -- sh -c 'sleep 5'
REPLAY_HOLD='list:readFile:/session.json:2:8000' NODE_OPTIONS="$HOLD" \
  node --import tsx src/cli/main.ts list --json
cat "$AGENT_TTY_HOME"/sessions/*/session.json   # stays exited, exitCode 0
```

### `HostSerializesWrites`: a late host write replaces the exit record (R3, R4)

Without the guard, the host's start-up, resize, destroying and exit writes ran as independent async writes. A start-up write could land after the exit write of a program that exited at once, and the manifest said `running` again.

Now every host write of `session.json` goes through one `createSerialManifestWriter`. Writes run in call order, and each takes its snapshot when its turn starts, so the last write holds the latest state.

```sh
REPLAY_HOLD='_host:rename:/session.json:1:1500' NODE_OPTIONS="$HOLD" \
  node --import tsx src/cli/main.ts create --json -- true
sleep 2; node --import tsx src/cli/main.ts list --all --json   # status: exited
```

### `HostStopsAfterTerminalWrite`: a terminal manifest before the host's last write (R1, R7)

Without the guard, a SIGTERM or a destroy request that came while another host write was in flight queued the "destroying" write behind it. When the program ended before that write's turn, the write took the "destroyed" snapshot and landed while the exit write of `handlePtyExit` was still queued. gc then removed the folder of a host that still wrote to it, and the exit write failed on the removed folder.

Now `createSerialManifestWriter` writes nothing after it wrote a terminal record, so the terminal write is the host's last write.

```sh
LOG=$(mktemp)
REPLAY_LOG=$LOG REPLAY_HOLD='_host:rename:/session.json:1:3000,_host:rename:/session.json:3:6000' \
  NODE_OPTIONS="$HOLD" node --import tsx src/cli/main.ts create --json -- sleep 30 &
until grep -q hold "$LOG"; do sleep 0.1; done   # the host holds its start-up write
kill -TERM "$(node -e 'console.log(require(process.argv[1]).hostPid)' "$AGENT_TTY_HOME"/sessions/*/session.json)"
sleep 4; node --import tsx src/cli/main.ts gc --json
wait; grep -c hold "$LOG"                        # 1: the host made no exit write after "destroyed"
```

### `DestroyRecordsDestroyed`: a destroyed session that reads failed (R9)

Without the guard, `destroy --force` killed the host and the program and then called `reconcileSession`, which read the dead host as a crash. The session read failed, "host process died unexpectedly", and only a second `destroy` made it destroyed. A plain `destroy` of a session whose host had crashed did the same. The force path also waited for the socket file, which only the dead host could remove, so it always took 5 seconds.

Now every successful return of `destroySession` comes right after `recordDestroyed`, which writes destroyed from a manifest that no host write can follow and unlinks the socket. The force path stops the two processes, reads the manifest again, and stops a child that only that read names. `recordDestroyed` keeps the exit code (`DestroyKeepsExitCode`).

`DestroyRecordsDestroyed` is one fact for all the return paths of `destroySession`. When one path loses its `recordDestroyed`, the fact reads FALSE and the model drops `recordDestroyed` from every path. So the counterexample of `mutant-DestroyRecordsDestroyed` can go through a path that still records destroyed in the code.

```sh
id=$(node --import tsx src/cli/main.ts create --json -- sleep 30 | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s).result.sessionId))')
node --import tsx src/cli/main.ts destroy "$id" --force --json   # returns in about 1 second
node --import tsx src/cli/main.ts inspect "$id" --json           # status: destroyed
```

## When you change covered code on purpose

1. Read the diff of every item that `STALE` lists, and the commits that the check prints. For a change that is not committed yet, read `git diff`.
2. Decide for each change: it does not alter what an action describes (formatting, a renamed local, an unrelated branch), or the model must change (a step split in two, a guard moved, a new writer of `session.json`, a new reconcile caller with a different flow), or the promise changed on purpose (cite the evidence: the doc comment, `CONTEXT.md`, the tests, the commit message).
3. Update the model from the code, not from the result. One indivisible step in the code stays one action, and its comment names the code. If a guard moved, update its pattern in `scripts/facts.mjs`.
4. Run the check. For a new or changed guard, break it once in a scratch edit of the real code (delete it, or move it after the write it guards) and confirm that a run turns `UNEXPECTED`. Then drop the scratch edit.
5. When the model describes the code again, run `scripts/check.sh --update-coverage` and commit `coverage.json` with the model change. That commit becomes the sync commit.

To add a guard, give it a constant in the model, make the actions run with and without it, read it in `scripts/facts.mjs`, add it to `GUARDS` in `scripts/check.sh`, and add its mutant run with the rule it protects.

To bring the check back in line after changes that skipped it, use `/maintain-formal-verification-skill` (a pstack plugin skill).

## Scope

The model checks every order of these steps for one session: one `create`, its host, one `gc` pass over that session (not `--dry-run`), one other command that reconciles twice, one resize, one `destroy` (with or without `--force`), one SIGTERM to the host, a program exit at any time, and a host crash at any time. The current model has 451,432 distinct states, and the check prints that count.

It assumes:

- A pid is not reused while the check looks at it, so `isProcessAlive(hostPid)` is true exactly while the host lives.
- A manifest write is atomic, because `writeTextFileAtomic` renames a temp file. A write that fails counts as a host crash or a failed command.
- The host waits for its manifest while the `create` process lives, so it gives up only when `create` dies before that write. That counts as a host crash, which R6 does not cover.
- gc's `rm(sessionDirectory, { recursive: true })` is one step, though the real `rm` deletes file by file. R1 already forbids removing a session whose host can still write, so the order of the deleted files does not matter.
- Steps that only lead to the same outcome are joined: gc's `readdir` and `stat` (both only skip), the host's `EventLog.open` and `createPty` (synchronous after the open), and `recordExit` with the `exit` event append (no other process sees them).
- A program ends with its host: a host crash or the SIGKILL of `destroy --force` ends both. `reconcileSession` also kills a live child of a dead host, which the model leaves out.
- The `destroy` RPC is one step: the host's handler does the work. `destroySession`'s own `reconcileSession` calls are the reconciles of the other command, so `destroy` itself only reads after them. A poll that reads an active status is either retried later or is the last of its 50 tries.
- Only the "destroying" write of `initiateShutdown` can wait for its turn while the in-memory status changes, so only it keeps its snapshot in the model. The start-up, resize and exit writes carry a status that cannot change before their turn.

It leaves out: a second `destroy` or a second SIGTERM, a rule that a folder gc removed stays removed (the `mkdir` in `writeTextFileAtomic` lets `destroy` and `reconcileSession` bring it back, coder/agent-tty#196), a SIGTERM before the host registers its handler (a crash covers it), a `destroy` RPC that fails for a reason other than an unreachable host (it writes nothing), `gc --stale-only` and `--older-than` (they only skip more), `gc --dry-run` (the other command covers its reconcile), the `rm` in `create`'s error path and in `doctor`, the Home registry, the contents of the event log and of the renderer, the kill of a child process whose host died, and the socket liveness probe in `rpcServer.listen`. A pass covers the model, not the whole product.

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
