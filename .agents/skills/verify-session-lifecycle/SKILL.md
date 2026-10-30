---
name: verify-session-lifecycle
description: TLA+ model check of the agent-tty session lifecycle when several agent-tty processes use one Home at the same time - create, the session host (start-up, resize, destroy, SIGTERM shutdown, exit), reconcileSession (list, inspect, destroy, gc), gc and destroy (with and without --force). Use it before you change src/host/lifecycle.ts, src/host/programGroup.ts, the start-up, shutdown or exit path of src/host/hostMain.ts, src/host/manifestWriter.ts, src/cli/commands/gc.ts, src/cli/commands/create.ts, src/cli/commands/destroy.ts, src/storage/manifests.ts or src/protocol/sessionStatusPolicy.ts, before you add a new writer of session.json, and when you must know whether a race can delete a session, corrupt its status, leave its program running or kill a process group that is not the session's.
---

# Verify the session lifecycle (TLA+)

Many agents share one Home (`~/.agent-tty` by default). Each agent-tty command is its own process, and they all read and write the same `session.json` files with no lock. A test runs one order of those steps. This check runs every order of them in a small model of one session, and it reports any order that breaks a rule below.

The model is `model/SessionLifecycle.tla`. Each action in it is one indivisible step of the real code: one file read, the rename that makes a manifest write visible, one `rm`, one unlink, a process start or end, or a block of synchronous code with no `await` in it. Every action has a comment that names the code it stands for.

The tool is TLC, the TLA+ model checker, pinned to release 1.7.4 by sha256. The question here is "can these steps happen in a bad order", and a model checker answers that for every order. No verifier runs on this TypeScript code across processes.

## The rules

| Rule                            | What must hold                                                                                                                                                                                     | Harm when it breaks                                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 `NoLiveSessionDeleted`       | gc never removes the folder of a session whose host can still write to it.                                                                                                                         | A running or starting session loses its manifest and event log.                                                                               |
| R2 `HostDeathOnlyWhenDead`      | The manifest says "failed, host died" only when the host process is dead.                                                                                                                          | `list` and `inspect` show a live session as failed. Commands refuse it.                                                                       |
| R3 `TerminalIsFinal`            | Once the manifest shows exited, failed or destroyed, it never shows running again.                                                                                                                 | A finished session looks running, and the next reconcile marks it failed.                                                                     |
| R4 `RecordedExitKept`           | Once the manifest records that the program exited, only `destroy` changes it, to destroyed, and keeps the exit code.                                                                               | A program that exited 0 is reported as failed, with its exit code lost.                                                                       |
| R5 `RunningSessionReachable`    | While the host serves a running program, the socket file exists.                                                                                                                                   | The session runs, but no command can reach it.                                                                                                |
| R6 `HostStartsWhenCreated`      | A host never fails to start because another process removed or rewrote its files.                                                                                                                  | `create` fails with `HOST_UNREACHABLE` for a session nobody touched.                                                                          |
| R7 `TerminalIsLastWrite`        | Once the manifest shows exited, failed or destroyed, the host has no write left to make.                                                                                                           | gc removes the folder while the host still writes to it, and the host's write then fails.                                                     |
| R8 `DestroyedOnlyWhenEnded`     | While the host lives, the manifest says destroyed only after the host saw the program end.                                                                                                         | `list` hides a program that still runs, and gc removes its folder.                                                                            |
| R9 `DestroyEndsDestroyed`       | `destroy` reports success only after it wrote destroyed or read it.                                                                                                                                | `destroy` says `destroyed: true`, but the session reads failed, "host process died unexpectedly", until a second `destroy`.                   |
| R10 `RemovedFolderStaysRemoved` | Once gc removed the session folder, no write brings it back.                                                                                                                                       | A late write creates the folder again with only `session.json`. `list --all` shows that stub session until the next gc removes it.            |
| R11 `DestroyedProgramStopped`   | When the manifest says destroyed, no process of the program's process group runs, unless the program exited on its own first or no manifest named its pid.                                         | A process of the session keeps running, `list` hides it, and nothing stops it later.                                                          |
| R13 `LiveGroupStaysNamed`       | While a process of the program's process group runs, a manifest that named the program still names it.                                                                                             | The session reads failed or destroyed without `childPid`, so no later `destroy` or reconcile can stop the process that still runs.            |
| R14 `DestroyOutlivesProgram`    | `destroy` is never killed before it reports, also when it runs inside the program's session.                                                                                                       | `destroy` prints nothing. With `--force` it kills its own group, and the session reads exited, not destroyed.                                 |
| R15 `NoUnrelatedGroupKilled`    | No kill reaches a process group that took the program's group id after the program's group ended.                                                                                                  | `destroy`, `destroy --force`, a reconcile or the host's shutdown sends SIGKILL to an unrelated group, such as the program of another session. |
| R16 `DestroyedSessionStopped`   | When the manifest says destroyed, no process of the program's group runs, also none that the program left when it exited on its own, unless the host died before `program.json` named the program. | `destroy` reports `destroyed: true` while a process of the session runs, `list` hides it, and nothing stops it later.                         |

`TypeOK` also runs in every run. When it breaks, the model is wrong, not the code.

## Does your change touch this?

Yes, when the diff changes any of these:

- `src/host/lifecycle.ts`: `allocateSession` (and the order of its `launch` call and first manifest write), `launchHost`, `isProcessAlive`, `cliRunsInsideProgramSession` with `ownLinuxSessionId` and `ownProcessGroupId`, `reconcileSession`, and `destroySession` with its local `stopLeftoversThenRecordDestroyed` and its helpers `recordDestroyed`, `stopSessionProcesses`, `readSessionManifestOrThrow`, `waitForTerminalManifest`, `waitForProcessesToExit` and `killProcessBestEffort`.
- `src/host/programGroup.ts`: the token capture (`captureProgram`, `captureToken`, `readAutogroup`, `parseAutogroup`, `parseProcStat`), the `/proc` reads (`readProcFileIfExists`, `readProcStat`, `readShownProcStat`, `isRefusedRead`), the record (`writeProgramRecord`, `readProgramRecord`, `readProvenProgramGroup`, `readProgramGroup`), the verdict (`judgeProgramGroup`, `readGroupMembers`), and the kill and the probe (`stopProgramGroup`, `isProgramGroupAlive`, `processGroupTarget`, `isProcessGroupAlive` with `groupHasLiveProcess` and `procHidesOtherUsers`, `killProcessGroupBestEffort`).
- `src/host/hostMain.ts`: `waitForManifestFromCreate`, `isSessionCommandable`, and in `runHost` the start-up statements (the manifest wait, the `hostPid === process.pid` check, `createSerialManifestWriter`, `EventLog.open`, `createPty`, `setChildPid`, `captureProgram`), `hangUpProgram` with its kill timer and the `SHUTDOWN_KILL_GRACE_MS` constant, `startIdlePolling` (the idle time-out), `initiateShutdown`, `startShutdown`, `handlePtyExit` with its wait for the program's group, `pty.onExit`, the `SIGTERM` handler, the `resize` and `destroy` handlers, and the last `try` block (the `program.json` write, the start-up manifest write and `rpcServer.listen`).
- `src/host/manifestWriter.ts` `createSerialManifestWriter`.
- `src/cli/commands/gc.ts` `gcSessions`, `src/cli/commands/create.ts` `runCreateCommand`, and `src/cli/commands/destroy.ts` `runDestroyCommand` with `rerunInNewSession`.
- `src/host/sessionState.ts` `setDimensions`, `requestDestroy`, `recordDestroyed` and `recordExit`, `src/host/eventLog.ts` `EventLog.open`, `src/host/rpcServer.ts` `listen` and `close`, `src/host/rpcClient.ts` `toTransportCliError` (which socket errors read as `HOST_UNREACHABLE`).
- `src/storage/manifests.ts` `readValidatedJsonFile`, `replaceFileAtomic`, `replaceFileAtomicSync`, `writeValidatedJsonFileSync`, `writeManifest`.
- The `SESSION_STATUS_POLICIES` table in `src/protocol/sessionStatusPolicy.ts`.
- Any new or removed call to `writeManifest`, `persistManifest`, `replaceFileAtomic`, `writeValidatedJsonFile`, `writeTextFileAtomic`, `manifestPath`, `reconcileSession`, `writeProgramRecord` or `stopProgramGroup` (also through an import alias), or a recursive `rm` (one with `recursive: true`, whatever its argument is named), anywhere in `src/`.
- This skill's `model/SessionLifecycle.tla`, `scripts/facts.mjs` and `scripts/check.sh`: an edit to them also needs a new confirmed `coverage.json`.

You do not have to judge this by hand. The check prints `STALE` when any of these changed since the sync commit.

## Run it

From the repo root:

```sh
.agents/skills/verify-session-lifecycle/scripts/check.sh
```

It needs `node`, Java 11 or newer (`java -version`), and the network once: the first run downloads `tla2tools.jar` 1.7.4 into this skill's `.cache/` folder (git ignores it) and checks its sha256. On this repo it takes about eleven minutes with the default `CHECK_JOBS` of 4. Six runs explore the whole model, so `CHECK_JOBS=52` starts every run at once and takes about as long as the longest run. `JAVA=/path/to/java` picks another Java. `TLA2TOOLS_JAR=/path/to/tla2tools.jar` uses a jar you already have, which must be the same 1.7.4 build. `CHECK_OUT=<folder>` keeps the results in that folder (default: a new temp folder, printed at the end).

What it does:

1. `scripts/facts.mjs` reads the code with the TypeScript compiler. It finds the twenty-three guards that the rules depend on and the status sets of the policy table, and it hashes each covered function with comments and layout removed.
2. It writes one TLC config per run, with those facts as constants. A guard that is not in the code, in the expected place and order, reads FALSE, and the model then runs without it.
3. It runs TLC 52 times and prints one line per run.
4. It compares the hashes and call sites with `coverage.json`.

Exit codes: 0 means every run gave the expected result and the covered code matches the sync record. 1 means at least one run gave an unexpected result; the line says `UNEXPECTED`. 3 means every result was as expected, but covered code changed since the sync commit; that is not a pass, so follow "When you change covered code on purpose". 2 means a tool could not run. When both 1 and 3 apply, the exit code is 1.

## Read the result

At the sync commit, the expected results are:

| Runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Expected | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `current`, the code as it is with the program's session token, every rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | pass     | No order of the modelled steps breaks a rule. This is the run that catches a new bug.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `current-no-token`, the code as it is without a token, R1 to R14                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | pass     | The same for a session whose `program.json` holds no token: on macOS, on a kernel without autogroups, when the capture read none, and for a session that an older agent-tty created. Every kill then falls back to the id that a manifest or the host's own record names. R15 and R16 are what the token adds, so this run leaves them out (see Scope).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `witness-*` without a suffix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | violated | Each witness is a state that must be reachable: gc removes a session, a session serves, a resize lands, a clean exit is recorded, a crash is reconciled, a plain destroy completes, a SIGTERM shutdown is recorded, an exited session is destroyed, `destroy --force` records a live session as destroyed, a program outlives its host, a process of another user outlives a plain `destroy` (which ends with `HOST_TIMEOUT` and leaves the session destroying) and `destroy --force` (which ends with `HOST_TIMEOUT` too), a process that the program left meets the kill of `destroy`, an unrelated group has the program's group id when `destroy --force` kills, `destroy --force` stops a program that only `program.json` names, and a program whose host died before `program.json` named it outlives `destroy`. A witness that passes means the model can no longer reach that state, and the passing rules prove nothing. |
| `witness-*-no-token`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | violated | Six of those states without a token: a crash is reconciled, an exited session is destroyed, `destroy --force` records a live session as destroyed, a program outlives its host, and a process of another user outlives a plain `destroy` and `destroy --force`. They show that `current-no-token` reaches the fallback kill and the EPERM probe.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `mutant-CreateRecordsHostPid`, `mutant-HostWaitsForManifest`, `mutant-ReconcileRereads`, `mutant-HostSerializesWrites`, `mutant-ReconcileSkipsLiveHost`, `mutant-HostStopsAfterTerminalWrite`, `mutant-DestroyRecordsDestroyed`, `mutant-DestroyKeepsExitCode`, `mutant-ManifestWriteNeedsFolder`, `mutant-KillsProgramGroup`, `mutant-HostWaitsForGroup`, `mutant-ReconcileWaitsForGroup`, `mutant-ReRunsInNewSession`, `mutant-InsideCheckReadsEnv`, `mutant-RecordsProgramSync`, `mutant-ProvesGroupOwnership`, `mutant-DestroyStopsLeftovers`, `mutant-FallbackNeedsFolder`, `mutant-GcBothChecks`, `mutant-ShutdownBothChecks` | violated | Each run removes a guard from the model and checks only the rule that the guard protects. That rule must break, which shows the check can fail.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `mutant-ProbeCountsDeniedGroup-no-token`, `mutant-KillsProgramGroup-no-token`, `mutant-HostWaitsForGroup-no-token`, `mutant-ReconcileWaitsForGroup-no-token`                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | violated | The same without a token. The fallback depends on these guards as the code before `program.json` did. With a token, the token check reads a process of another user in view, so only this path checks `ProbeCountsDeniedGroup`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `mutant-ReconcileSkipsTerminal`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | pass     | The re-read in `reconcileSession` also returns on a terminal manifest, so the first terminal return alone is redundant.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `mutant-GcSkipsNonCollectable`, `mutant-GcFinalCheck`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | pass     | gc checks "collectable" twice. One check alone still keeps R1, so removing one is safe. Removing both is not.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `mutant-ShutdownChecksCommandable`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | pass     | `initiateShutdown` requests destroy only while the session is commandable, and the writer writes nothing after a terminal record. Either one alone keeps R3. Removing both is not safe.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

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

Now `reconcileSession` reads the manifest again after it finds the host dead, returns when that copy is terminal, and reconciles from that copy. A dead host cannot write again. After its group wait, `reconcileSession` reads the manifest once more, returns when it is gone or terminal, and builds its record from that copy, so a `destroy --force` that recorded destroyed during the wait stays destroyed. The guard also reads TRUE when the record comes from that later copy.

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

### `ManifestWriteNeedsFolder`: a late write brings a removed folder back (R10)

Without the guard, `writeManifest` went through `writeTextFileAtomic`, which runs `mkdir` before every write. A manifest write that landed after gc removed the session folder created the folder again, holding only `session.json`. `destroy` and `reconcileSession` both did that, and `list --all` showed the stub session until the next gc.

Now `writeManifest` writes the temp file and renames it with no `mkdir`, so a write into a removed folder fails with `SESSION_NOT_FOUND`. `reconcileSession` then returns. `destroy` reports `SESSION_NOT_FOUND`, as it does when its reads find no manifest. A host write fails too. A failed start-up or exit write ends the host, and a failed resize write fails only that RPC.

```sh
id=$(node --import tsx src/cli/main.ts create --json -- sleep 300 | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s).result.sessionId))')
LOG=$(mktemp)
REPLAY_LOG=$LOG REPLAY_HOLD='destroy:readFile:/session.json:2:3000' NODE_OPTIONS="$HOLD" \
  node --import tsx src/cli/main.ts destroy "$id" --force --json &
until grep -q hold "$LOG"; do sleep 0.1; done   # destroy holds its read after the kill
node --import tsx src/cli/main.ts gc --json      # removes the session folder
wait                                             # destroy prints SESSION_NOT_FOUND
ls "$AGENT_TTY_HOME/sessions"                    # empty: the folder stays removed
```

### `KillsProgramGroup`: a process of the program outlives destroy (R11)

Without the guard, the host's shutdown sent SIGHUP to the program and waited, and every kill went to the program's pid. A program that ignores SIGHUP kept running, so a plain `destroy` ended with `HOST_TIMEOUT` and the session stayed `destroying`. A process that the program started, such as `sleep 300 &` in a shell that ignores SIGHUP, outlived `destroy`, `destroy --force` and a reconcile after a host crash, and the session read destroyed or failed.

node-pty starts the program as a session leader, so the program's pid is also its process group id, and the program cannot leave that group. Now every kill goes to the group, through `stopProgramGroup` in `src/host/programGroup.ts`. Its helper `killProcessGroupBestEffort` sends SIGKILL to the negated id. It throws on an id that is not an integer above 1, so it never calls `process.kill(0)` or `process.kill(-1)`. `handlePtyExit` kills the group when the program ends during a destroy. `stopSessionProcesses` kills the group, and `waitForProcessesToExit` waits until `isProgramGroupAlive` reads false. `reconcileSession` kills the group that its re-read names. The model found that last case: a reconcile whose first read came before the host's start-up write killed the program of that copy, which named none, and wrote failed with `childPid: null`, so nothing could stop the program later.

The kill timer of `hangUpProgram`, which `initiateShutdown` and the idle time-out call, kills the group `SHUTDOWN_KILL_GRACE_MS` (2 seconds) after SIGHUP. So a plain `destroy` ends within its wait of about 5 seconds, and a program that ignores SIGHUP no longer outlives its idle time-out. When the program exits on that SIGHUP before the timer fires, `handlePtyExit` clears the timer and kills the group itself, so a process that the program started and that ignores SIGHUP does not outlive the idle time-out either. nvim takes about 1 second to exit on SIGHUP. No rule depends on the timer, because the model has no clock.

`KillsProgramGroup` is one fact for the helpers in `programGroup.ts` and three kill sites: the kill in `handlePtyExit`, the kill and the wait in `stopSessionProcesses`, and the kill in `reconcileSession`. When one of them loses its group kill, the fact reads FALSE and the model drops the group kill from all three sites, and every `waitForProcessesToExit` reads the group gone, as the pid wait before it did. So the counterexample of `mutant-KillsProgramGroup` can go through a site that still kills the group in the code. The kill timer is not part of the fact. No rule depends on it, because it only bounds how long `destroy` takes: without its action the model still passes every rule. The kill in `handlePtyExit` after an idle hang-up is not part of the fact either. No rule depends on it: it goes through `stopProgramGroup` like every kill, and a process that outlives it is one that the program left, which the model keeps after a normal exit anyway. So a change to the timer shows only `STALE` (on `runHost(parts)`, or on `SHUTDOWN_KILL_GRACE_MS`).

```sh
LOG=$(mktemp)
REPLAY_LOG=$LOG REPLAY_HOLD='_host:rename:/session.json:1:4000' NODE_OPTIONS="$HOLD" \
  node --import tsx src/cli/main.ts create --json -- sh -c 'trap "" TERM HUP; sleep 300 & wait' &
until grep -q 'hold rename' "$LOG"; do sleep 0.1; done   # the host holds its start-up write
REPLAY_LOG=$LOG REPLAY_HOLD='list:readFile:/session.json:2:6000' NODE_OPTIONS="$HOLD" \
  node --import tsx src/cli/main.ts list --json &          # its reconcile reads create's copy
until grep -q 'release rename' "$LOG"; do sleep 0.1; done
m=$(ls "$AGENT_TTY_HOME"/sessions/*/session.json)
pgid=$(node -e 'console.log(require(process.argv[1]).childPid)' "$m")
echo "pgid=$pgid"                                         # a number: with null the check below proves nothing
kill -KILL "$(node -e 'console.log(require(process.argv[1]).hostPid)' "$m")"
wait; ps -eo pgid=,args= | awk -v g="$pgid" '$1 == g'   # prints nothing: the group is gone
```

### `ProbeCountsDeniedGroup`: a group of another user's processes reads gone (R11)

`kill(-pgid)` fails with EPERM when every process left in the program's group belongs to another user, such as the root child of `sudo cmd &`. Before this guard, both group helpers threw that error. The host died in its kill timer or in `handlePtyExit`, and `destroy`, `destroy --force` and the reconcile after a host crash printed a raw Node stack. The kill can ignore EPERM as it ignores ESRCH, but the probe must not. A probe that reads EPERM as gone lets every wait for the group pass while that process runs, and the session reads destroyed.

Now, on EPERM, `isProcessGroupAlive` reads the group alive unless `/proc` shows only zombies of it (Linux only, see Scope). A group with no process in view also reads alive, because `hidepid` hides the processes of other users. `killProcessGroupBestEffort` returns on EPERM. This probe decides for a group without a token. With a token, `isProgramGroupAlive` reads the group alive while a live member in view carries the token, and a process of another user in the program's session carries it too. When `/proc` shows no live member, as when `hidepid` hides that process, the token check asks this probe. `mutant-ProbeCountsDeniedGroup-no-token` breaks R11 on the path without a token. So `destroy --force` ends with `HOST_TIMEOUT` and records nothing while such a process runs. `test/fixtures/eperm-group-kill.ts` makes every group signal fail with EPERM and deliver nothing, which stands for such a group.

```sh
EPERM="--import=$PWD/test/fixtures/eperm-group-kill.ts"
id=$(NODE_OPTIONS="$EPERM" node --import tsx src/cli/main.ts create --json -- sh -c 'trap "" TERM HUP; exec sleep 300' | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s).result.sessionId))')
m="$AGENT_TTY_HOME/sessions/$id/session.json"
NODE_OPTIONS="$EPERM" node --import tsx src/cli/main.ts destroy "$id" --force --json   # HOST_TIMEOUT after about 5 seconds
node -e 'const m=require(process.argv[1]);console.log(m.status, m.childPid)' "$m"      # running and the pid: not destroyed
```

### `HostWaitsForGroup`: the host records destroyed while the group runs (R11)

Without the guard, `handlePtyExit` recorded destroyed right after its group kill. A kill that returns 0 does not show that the group is gone: with `sudo cmd &` the group holds `sudo`, which we may signal, and its root child, which survives. The session read destroyed while that child ran.

Now the async block of `handlePtyExit` calls `recordDestroyed` only after `waitForProcessesToExit(null, program)` read the group gone. When that wait gives up after about 5 seconds, the host writes its record as it is, destroying without the exit code, and still shuts down. A later reconcile retries the kill. `WitnessForeignOutlivesDestroy` shows that the model reaches this end.

```sh
EPERM="--import=$PWD/test/fixtures/eperm-group-kill.ts"
id=$(NODE_OPTIONS="$EPERM" node --import tsx src/cli/main.ts create --json -- sh -c '(trap "" HUP; exec sleep 300) & wait' | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s).result.sessionId))')
m="$AGENT_TTY_HOME/sessions/$id/session.json"
host=$(node -e 'console.log(require(process.argv[1]).hostPid)' "$m")
NODE_OPTIONS="$EPERM" node --import tsx src/cli/main.ts destroy "$id" --json   # HOST_TIMEOUT
while kill -0 "$host" 2>/dev/null; do sleep 0.2; done                         # the host gives up and ends
node -e 'const m=require(process.argv[1]);console.log(m.status, m.childPid)' "$m"   # destroying and the pid
```

### `ReconcileWaitsForGroup`: a reconcile forgets a group that still runs (R13)

Without the guard, `reconcileSession` wrote its record right after its group kill, with `childPid: null`. When a process of another user survived the kill, the session read failed after a host crash, and nothing could find that process again. A later `destroy` then recorded destroyed while it ran.

Now `reconcileSession` returns with no write and no unlink while `waitForProcessesToExit(null, group)` reads the group alive, for about 5 seconds. `childPid` stays, so a later reconcile retries the kill.

```sh
EPERM="--import=$PWD/test/fixtures/eperm-group-kill.ts"
id=$(NODE_OPTIONS="$EPERM" node --import tsx src/cli/main.ts create --json -- sh -c 'trap "" TERM HUP; exec sleep 300' | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s).result.sessionId))')
m="$AGENT_TTY_HOME/sessions/$id/session.json"
kill -KILL "$(node -e 'console.log(require(process.argv[1]).hostPid)' "$m")"
NODE_OPTIONS="$EPERM" node --import tsx src/cli/main.ts gc --dry-run --json   # after about 5 seconds: "session host is still alive"
node -e 'const m=require(process.argv[1]);console.log(m.status, m.childPid)' "$m"   # running and the pid: childPid kept
```

### `ReRunsInNewSession`: a destroy inside the program's session dies before it reports (R14)

Without the guard, a destroy that the program ran (`sh -c 'agent-tty destroy "$AGENT_TTY_SESSION_ID"'`), or that someone typed into the program's interactive shell, ran inside the program's session, and its own stop ended it. With `--force` it died in the SIGKILL of its own group, and the host then recorded exited. A plain destroy died from the hang-up when the program's leader exited. Either way it printed nothing.

Now `runDestroyCommand` first asks `cliRunsInsideProgramSession`. When the CLI runs inside, `rerunInNewSession` runs the same command detached, in a new session and without `AGENT_TTY_SESSION_ID`, and exits with that copy's exit code. The copy does the destroy from outside and prints the result. On Linux the check also compares the CLI's session id, from `/proc/self/stat`, with `childPid`. That covers a job of an interactive shell, which runs in a process group of its own. In the model, a destroy inside the session dies at the first step that ends the program's leader, kills its group or closes its PTY, unless it re-ran.

```sh
out=$(mktemp)
id=$(node --import tsx src/cli/main.ts create --json -- sh -c 'sleep 2; "$@" destroy "$AGENT_TTY_SESSION_ID" --force --json > "$0"; sleep 300' "$out" node --import tsx src/cli/main.ts | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s).result.sessionId))')
sleep 6; cat "$out"                                                                                  # ok: true, destroyed: true
node -e 'console.log(require(process.argv[1]).status)' "$AGENT_TTY_HOME/sessions/$id/session.json"   # destroyed
```

### `InsideCheckReadsEnv`: a destroy before the host's start-up write looks outside (R14)

The model found this race. The program gets `AGENT_TTY_SESSION_ID` at spawn, but its pid reaches the manifest only with the host's start-up write. Without the guard, a destroy that the program ran before that write read `childPid: null`, so the check said that it ran outside, and it did not re-run. With `--force` it killed the host, the closed PTY hung up the program's group, and the CLI died before it printed. The session then read failed.

Now `cliRunsInsideProgramSession` returns true when `AGENT_TTY_SESSION_ID` equals the session id, before it reads the manifest. The id comparison stays, for a program whose `create --env` overrode the variable. The re-run copy does not get the variable: with it, the copy would start yet another copy. A needless re-run is harmless, because the check only routes the CLI and never decides a kill. The hold below applies to the host only, though the inner CLI inherits it.

```sh
out=$(mktemp)
REPLAY_HOLD='_host:rename:/session.json:1:4000' NODE_OPTIONS="$HOLD" \
  node --import tsx src/cli/main.ts create --json -- sh -c '"$@" destroy "$AGENT_TTY_SESSION_ID" --force --json > "$0"' "$out" node --import tsx src/cli/main.ts
# create fails with HOST_UNREACHABLE: the destroy ended its host during the held write
cat "$out"                                                                                  # ok: true, destroyed: true
node -e 'console.log(require(process.argv[1]).status)' "$AGENT_TTY_HOME"/sessions/*/session.json   # destroyed
```

### `RecordsProgramSync`: a host death in its start-up write leaves a program that no file names (R16)

Without the guard, the program's pid reached a file only with the host's start-up manifest write, the first `await` after the spawn. When the host died in that write, no file named the program, and a program that ignores SIGHUP kept running. `destroy --force` then recorded the session destroyed while the program ran. That is case 2 of coder/agent-tty#203.

Now `runHost` reads the program's session token with `captureProgram` right after `setChildPid`, and writes `program.json` with `renameSync` as the first statement of its last `try`, before `await persistManifest()`. No statement between `createPty` and that write awaits, so no event handler of the host runs in between. A host that dies in its start-up write leaves `program.json`, and `destroy --force` and a reconcile kill the group that it proves. A host death inside that synchronous block still leaves the program unnamed, and R16 exempts it. Scope gives the length of that window.

```sh
LOG=$(mktemp)
REPLAY_LOG=$LOG REPLAY_HOLD='_host:rename:/session.json:1:30000' NODE_OPTIONS="$HOLD" \
  node --import tsx src/cli/main.ts create --json -- sh -c 'trap "" HUP; sleep 300 & wait' &
until grep -q 'hold rename' "$LOG"; do sleep 0.1; done   # the host holds its start-up write
d=$(dirname "$(ls "$AGENT_TTY_HOME"/sessions/*/session.json)")
pgid=$(node -e 'console.log(require(process.argv[1]).pid)' "$d/program.json")   # session.json has childPid: null
kill -KILL "$(node -e 'console.log(require(process.argv[1]).hostPid)' "$d/session.json")"
wait                                                     # create fails: its host died
node --import tsx src/cli/main.ts destroy "$(basename "$d")" --force --json   # ok: true
ps -eo pgid=,args= | awk -v g="$pgid" '$1 == g'          # prints nothing: the group is gone
```

### `ProvesGroupOwnership`: a kill reaches a group that took the program's group id (R15)

Without the guard, every kill trusted the number that a manifest named. Once every process of the program's group had ended, the kernel could give that id to a new session leader, such as the program of another session. A reconcile of a stale manifest, or `destroy --force`, then sent SIGKILL to that unrelated group. That is case 5 of coder/agent-tty#203. The model also found the host's own window: the kill timer ends the group, node-pty reaps the program, and another group can take the id before `handlePtyExit` kills the group again.

Now every group kill goes through `stopProgramGroup`. With a record that has a token, it reads the process table, finds a live member of the group whose session id is the program's pid and whose autogroup and boot id are the recorded ones, reads that member again, and kills the group, in one synchronous block. `setsid()` gives each new session a new autogroup id from a counter that does not repeat within a boot, and `fork()` passes it on, so a group that took the id later has another autogroup. Such a group gets no kill, and `isProgramGroupAlive` reads it gone, so the wait after the kill passes. `killProcessGroupBestEffort` and `processGroupTarget` have no callers outside `stopProgramGroup` and the probe. The replay rewrites the files of a destroyed session so that they name an unrelated session leader, which is what a reused id looks like.

```sh
id=$(node --import tsx src/cli/main.ts create --json -- sh -c 'exec sleep 300' | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s).result.sessionId))')
node --import tsx src/cli/main.ts destroy "$id" --json
d="$AGENT_TTY_HOME/sessions/$id"
other=$(sh -c 'setsid sleep 300 </dev/null >/dev/null 2>&1 & echo $!')
until [ "$(ps -o sid= -p "$other" | tr -d ' ')" = "$other" ]; do sleep 0.01; done
node -e '
  const fs = require("node:fs");
  const [dir, pid] = [process.argv[1], Number(process.argv[2])];
  const edit = (file, change) => fs.writeFileSync(`${dir}/${file}`, JSON.stringify(change(JSON.parse(fs.readFileSync(`${dir}/${file}`, "utf8")))));
  edit("program.json", (record) => ({ ...record, pid }));
  edit("session.json", (manifest) => ({ ...manifest, status: "running", hostPid: null, childPid: pid }));
' "$d" "$other"
node --import tsx src/cli/main.ts inspect "$id" --json   # status: failed
ps -o pid=,args= -p "$other"                             # sleep 300 still runs
kill "$other"
```

### `DestroyStopsLeftovers`: a process that an exited program left outlives destroy (R16)

Without the guard, `destroySession` recorded a terminal session destroyed with no kill, because such a manifest can be days old, and its group id can name an unrelated group by then. A process that the program started and that ignored the hang-up of the program's exit, such as `sleep 300 &` after `trap "" HUP`, kept running after `destroy`, and `list` hid it. That is case 1 of coder/agent-tty#203 (coder/agent-tty#204).

Now every terminal path of `destroySession` goes through `stopLeftoversThenRecordDestroyed`. It reads `program.json` with `readProvenProgramGroup`, kills the group that the record proves, waits for it like `destroy --force`, and only then records destroyed. A record without a token, or no record, proves nothing, so such a session is recorded destroyed with no kill, as before.

```sh
id=$(node --import tsx src/cli/main.ts create --json -- sh -c 'trap "" HUP; sleep 300 & exit 0' | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s).result.sessionId))')
d="$AGENT_TTY_HOME/sessions/$id"
pgid=$(node -e 'console.log(require(process.argv[1]).pid)' "$d/program.json")
until [ "$(node -e 'console.log(require(process.argv[1]).status)' "$d/session.json")" = exited ]; do sleep 0.1; done
ps -eo pgid=,args= | awk -v g="$pgid" '$1 == g'          # sleep 300 runs in the program's group
node --import tsx src/cli/main.ts destroy "$id" --json   # ok: true
ps -eo pgid=,args= | awk -v g="$pgid" '$1 == g'          # prints nothing: the leftover is gone
```

### `FallbackNeedsFolder`: a childPid that gc's removal left stale gets the kill (R15)

The model found this race. Without a token, `readProgramGroup` falls back to the childPid of the manifest copy that the caller read before it, as before `program.json` existed. When gc removed the session folder between that read and the `program.json` read, the record read missing too, and the kill used a childPid whose group could have ended and whose id could name an unrelated group by then.

Now that fallback carries the session folder, and `stopProgramGroup` kills it, and `isProgramGroupAlive` probes it, only while the folder exists, checked in the same synchronous block. A session with a record names its childPid only after the record, so a record that is missing from a folder that still exists marks a session that never had one. The replay holds the manifest read of `destroy --force` while the program exits and gc removes the folder, and a preload logs every group kill.

```sh
KILLS=$(mktemp)
LOGGER=$(mktemp --suffix=.mjs)
echo "import { appendFileSync } from 'node:fs'; const kill = process.kill.bind(process); process.kill = (pid, signal) => { if (pid < -1) appendFileSync(process.env.KILLS, pid + ' ' + signal + '\n'); return kill(pid, signal); };" >"$LOGGER"
id=$(node --import tsx src/cli/main.ts create --json -- sh -c 'sleep 2' | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s).result.sessionId))')
LOG=$(mktemp)
KILLS=$KILLS REPLAY_LOG=$LOG REPLAY_HOLD='destroy:readFile:/session.json:2:6000' NODE_OPTIONS="$HOLD --import=$LOGGER" \
  node --import tsx src/cli/main.ts destroy "$id" --force --json &
until grep -q 'hold readFile' "$LOG"; do sleep 0.1; done   # destroy holds the running copy
until grep -q '"exited"' "$AGENT_TTY_HOME/sessions/$id/session.json"; do sleep 0.1; done
node --import tsx src/cli/main.ts gc --json              # removes the session folder
wait                                                     # destroy prints SESSION_NOT_FOUND
cat "$KILLS"                                             # prints nothing: no group kill
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

The model checks every order of these steps for one session: one `create`, its host, one `gc` pass over that session (not `--dry-run`), one other command that reconciles twice, one resize, one `destroy` (with or without `--force`, from outside or from inside the program's session), one SIGTERM to the host, a program exit at any time, a process of another user in the program's group that starts and ends at any time, a process that the program leaves when it exits on its own, the host's `program.json` write, an unrelated group that takes the program's group id once the whole group has ended, the kill timer of the host's shutdown, and a host crash at any time. With a token the model has 4,304,893 distinct states, and without one 5,218,828. The check prints both counts.

It assumes:

- The host's pid is not reused while the check looks at it, so `isProcessAlive(hostPid)` is true exactly while the host lives. `destroy --force` also sends SIGKILL to a stale `hostPid` with no check, which the model leaves out. Under an init that never reaps orphans, a host that ended stays a zombie, and `isProcessAlive` reads it alive, so `list` shows a crashed host's session running and `destroy --force` ends with `HOST_TIMEOUT`. That is still open.
- The kernel does not reuse a pid while a process group with that id exists, so a kill of the program's group id reaches only that group while a process of it runs. Once the whole group has ended, a new process can get that id and lead an unrelated group (case 5 of coder/agent-tty#203). The model lets that happen at any step after the group ended. With a token, `stopProgramGroup` kills only right after it read a live member that carries the token again, and the model takes that check and the kill as one step. No API holds a process group the way a pidfd holds one process, so a gap stays between the check and the `kill(2)`: from the start of the member's re-read to the kill call it took p50 24 µs, p99 69 µs and at most 81 µs over 300 kills at a load average of 43. A group that takes the id inside that gap needs every member to exit, the pid counter to wrap onto the id, and the new process to lead a group, all within those microseconds.
- The program runs from the spawn on, but `program.json` names it only after `captureProgram` read its token and `writeProgramRecord` renamed the file, in the same synchronous block. A host death inside that block leaves a program that no file names, and R16 exempts it (case 2 of coder/agent-tty#203). Over 150 sequential `create` calls on Linux, from the return of node-pty's spawn to the renamed `program.json`, at 1-minute load averages of 38 to 83, that took a median of 2.8 ms, a 90th percentile of 4.3 ms and at most 66 ms. A scratch build of `runHost` timed it with `performance.now()`. `captureProgram` took a median of 1.3 ms and at most 7.3 ms of that, so the long tail lies in the rest of the block and the write. node-pty returns before the child has called `setsid()`, so the capture polls for at most 250 ms until the child leads its own session.
- `current` describes Linux with autogroups, where the capture finds the token. Without a token, `readProgramGroup` falls back to the childPid of the manifest, as before `program.json` existed: on macOS and Windows, on a kernel without `CONFIG_SCHED_AUTOGROUP`, when the capture read no autogroup, and for a session that an older agent-tty created. There a reconcile and `destroy --force` kill that childPid as it is, `destroy` of a terminal session kills nothing, and a kill can still reach an unrelated group that took the id. `current-no-token` checks that fallback: the constant `Token` is FALSE there, so `program.json` names no group, and the host kills and probes the program's pid as it is. R15 and R16 do not hold on that path, so the run checks R1 to R14. The fallback kills only while the session folder exists. gc's real `rm` deletes file by file, so while it runs the folder can exist after `program.json` is gone, and a fallback kill in that moment can use a childPid that gc's removal made stale.
- A `program.json` that does not parse, or that another version wrote, proves nothing: it gets no kill, and reconcile and `destroy` do not throw. A missing one gets the childPid fallback above.
- A manifest write is atomic, because `writeManifest` renames a temp file. A write that fails counts as a host crash or a failed command. That covers a host write into a removed folder, which only a state that already breaks R1 reaches.
- The host waits for its manifest while the `create` process lives, so it gives up only when `create` dies before that write. That counts as a host crash, which R6 does not cover.
- gc's `rm(sessionDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 })` is one step, though the real `rm` deletes file by file. R1 already forbids removing a session whose host can still write, so for the host the order of the deleted files does not matter. A reconcile or `destroy` write can land during the real `rm`, after it listed the folder, and make its last `rmdir` fail with `ENOTEMPTY`. The `rm` then runs again, up to 3 times, after waits of 10, 20 and 30 ms, and deletes the late `session.json` (coder/agent-tty#202). A write after the last `rmdir` fails, because `writeManifest` runs no `mkdir`. The folder stays only when a write lands in each of the 4 runs, and the next gc then removes it.
- Steps that only lead to the same outcome are joined: gc's `readdir` and `stat` (both only skip), the host's `EventLog.open` and `createPty` (synchronous after the open), and `recordExit` with the `exit` event append (no other process sees them).
- A program can outlive its host: the PTY closes with the host and sends the program SIGHUP, which a program can ignore. The model keeps such a program running until a kill of its group ends it, the worst case for R11. A SIGKILL of the group ends every process of our user in it at once.
- A process of another user can run in the program's group, such as the root child of `sudo cmd &`. Our SIGKILL does not reach it, and once only such processes are left, `kill(-pgid)` fails with EPERM. `isProcessGroupAlive` reads EPERM as alive unless `/proc` shows only zombies of the group, and `killProcessGroupBestEffort` ignores it. While such a process runs, three things take about 5 seconds, the length of `waitForProcessesToExit`. The host waits that long after the program's exit, then leaves the manifest destroying and ends. `destroy` and `destroy --force` end with `HOST_TIMEOUT`. Every reconcile of the session (`list`, `inspect`, `gc`, the dashboard) waits that long and writes nothing. The model lets each wait give up at any poll that reads the group alive. With a token, the model lets such a process carry the token in view. Where `/proc` hides or refuses it, the token check reads it through `isProcessGroupAlive`, which reads it alive in the same states while `ProbeCountsDeniedGroup` holds.
- A killed process stays a zombie until its parent, or init once its parent has died, reaps it, and `kill(-pgid, 0)` still finds a zombie. On Linux, `isProcessGroupAlive` then reads `/proc/<pid>/stat` of every process and reads the group gone when each process of it in view is a zombie, so a group whose last processes are never reaped, as under a container's PID 1 without an init, reads gone. On macOS it does not scan, so a zombie still reads alive until launchd reaps it. The model has no zombies: a killed process ends at once. A process that `/proc` refuses to show, as `hidepid=1` (EPERM) or a security module (EACCES) does for other users, reads alive. With `hidepid=2` or `hidepid=4` (`invisible` and `ptraceable` on newer kernels), `/proc` can leave such a process out of its listing, so the probe reads the last `/proc` line of `/proc/self/mountinfo`, skips the scan and reads a group with a zombie alive, as on macOS. With a token, neither a zombie nor a process that `/proc` refuses to show witnesses the token. When no live member is in view, `isProgramGroupAlive` reads the group as `isProcessGroupAlive` does, with the zombie scan, the refused reads and the same `hidepid` check. So under any of those `hidepid` modes, a group that a process of another user took after the program's group ended reads alive, and `destroy` ends with `HOST_TIMEOUT` until that process ends.
- A destroy that lands between reconcile's last read and its write is still overwritten with failed. The re-read after the group wait keeps that window to the write itself (coder/agent-tty#203 follow-up).
- The idle time-out calls the same `hangUpProgram` as `initiateShutdown`: SIGHUP, then the group kill after `SHUTDOWN_KILL_GRACE_MS`. When the program exits on that SIGHUP, `handlePtyExit` kills the group too, so a process that ignores SIGHUP does not outlive the idle time-out. An idle time-out still ends exited. The model leaves both group kills out: they go through `stopProgramGroup` like every kill, and a process that outlives them is one that the program left, which the model keeps after a normal exit anyway.
- Windows has no process groups, so there `processGroupTarget` gives the program's pid, and every kill reaches only that process. `destroy` never re-runs on Windows.
- A destroy that the program runs, or that someone types into the program's interactive shell, runs inside the program's session, and `rerunInNewSession` runs it again in a new session. The model lets such a destroy start while the program's leader runs, and assumes that it kept `AGENT_TTY_SESSION_ID`, which every process of the program inherits at spawn. A destroy whose environment lost the variable, or whose `create --env` overrode it, is seen through the id comparison only. On Linux that compares the CLI's session id with `childPid`, so it misses such a destroy only before the host's start-up write. Other POSIX systems compare only the process group, through `ps`, so on macOS such a destroy typed into an interactive shell's job also dies, because the job runs in a group of its own.
- The program's processes stay in its process group. A process that leaves the group (`setsid`, or the job control of an interactive shell) is out of reach of the group kill, and it is no witness for the token either. That is case 4 of coder/agent-tty#203, a documented limit with no code change.
- A process that the program left when it exited on its own stays in the program's group and session, so it carries the token. `destroy` of the terminal session kills it through `program.json` (case 1 of coder/agent-tty#203, coder/agent-tty#204). Nothing else stops it: the host does not kill at a normal exit, and gc removes `program.json` with the folder, so a process that a session removed by gc left stays unproven. The model drops a process of another user at a normal exit.
- The `destroy` RPC is one step: the host's handler does the work. `destroySession`'s own `reconcileSession` calls are the reconciles of the other command, so `destroy` itself only reads after them. A poll that reads an active status is either retried later or is the last of its 50 tries.
- Only the "destroying" write of `initiateShutdown` can wait for its turn while the in-memory status changes, so only it keeps its snapshot in the model. The start-up, resize and exit writes carry a status that cannot change before their turn.

It leaves out: a second `destroy` or a second SIGTERM, a SIGTERM before the host registers its handler (a crash covers it), a `destroy` RPC that fails for a reason other than an unreachable host (it writes nothing), `gc --stale-only` and `--older-than` (they only skip more), `gc --dry-run` (the other command covers its reconcile), the `rm` in `create`'s error path and in `doctor`, the Home registry, the artifact commands (`snapshot`, `screenshot`, `record export`, see the next paragraph), the contents of the event log and of the renderer, a program that exits before the capture read its token (its record has none), a destroy inside the program's session that starts after the program's leader ended or that dies before its check, the time between SIGHUP and the kill timer and the length of every wait (the model has no clock), and the socket liveness probe in `rpcServer.listen`. A pass covers the model, not the whole product.

The artifact commands never create the session folder (coder/agent-tty#198). `ensureArtifactsDir` creates only `artifacts/` in an existing session folder and reports `SESSION_NOT_FOUND` when gc removed it, and their file writes create no folder. Unit tests remove the folder before `ensureArtifactsDir`, the artifact manifest write, the snapshot write, the screenshot write and its rename, and the video copy. The asciicast write uses the same write as the snapshot, and its unit test checks only its `createParentFolders: false` option.

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
