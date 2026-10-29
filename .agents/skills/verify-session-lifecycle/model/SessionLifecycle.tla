--------------------------- MODULE SessionLifecycle ---------------------------
(***************************************************************************)
(* One agent-tty Session while other agent-tty processes use the same     *)
(* Home. Every action is one indivisible step of the real code: one file   *)
(* read, one rename that makes a manifest write visible, one rm, one       *)
(* unlink, one process start or end, or one synchronous block with no      *)
(* await in it. Processes:                                                 *)
(*                                                                         *)
(*   create  src/cli/commands/create.ts runCreateCommand, with             *)
(*           src/host/lifecycle.ts allocateSession and launchHost          *)
(*   host    src/host/hostMain.ts runHost: the start-up path, the resize   *)
(*           handler, and the exit path (handlePtyExit, initiateShutdown)  *)
(*   gc      src/cli/commands/gc.ts gcSessions, one entry, not --dry-run   *)
(*   list    another command that calls reconcileSession: gc --dry-run,    *)
(*           the create time-out and the destroy fallback always do;       *)
(*           list, inspect and the dashboard do after their own read       *)
(*           shows an active status. This process may reconcile at any     *)
(*           time, so it covers all of them.                               *)
(*                                                                         *)
(* facts.mjs reads the guard constants from the source. FALSE means the    *)
(* guard is not in the code, and the model then runs the code without it.  *)
(* Collectable and Terminal come from the SESSION_STATUS_POLICIES table in *)
(* src/protocol/sessionStatusPolicy.ts.                                    *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    Collectable,            \* statuses whose policy says collectable
    Terminal,               \* statuses whose policy says terminal
    GcSkipsNonCollectable,  \* gc.ts: skip when manifestAfter is not collectable
    GcFinalCheck,           \* gc.ts: re-read before rm, skip if not collectable
    ReconcileSkipsTerminal, \* lifecycle.ts: return when the manifest is terminal
    ReconcileSkipsLiveHost, \* lifecycle.ts: return when hostPid is set and alive
    CreateRecordsHostPid,   \* lifecycle.ts: launch the host, then write the
                            \*   first manifest with its pid
    HostWaitsForManifest,   \* hostMain.ts: wait for the manifest to appear
    ReconcileRereads,       \* lifecycle.ts: re-read the manifest after the
                            \*   host is found dead, write from that copy
    HostSerializesWrites,   \* hostMain.ts: one writer, writes in call order
    MaxListReconciles       \* how many times the "list" process reconciles

ASSUME MaxListReconciles \in 1..3
ASSUME \A b \in {GcSkipsNonCollectable, GcFinalCheck, ReconcileSkipsTerminal,
                 ReconcileSkipsLiveHost, CreateRecordsHostPid,
                 HostWaitsForManifest, ReconcileRereads,
                 HostSerializesWrites} : b \in BOOLEAN

Readers == {"gc", "list"}   \* the two processes that run reconcileSession

VARIABLES
    dir,         \* the session directory exists
    mst,         \* manifest status on disk; "none" when there is no manifest
    mpid,        \* the manifest on disk records a hostPid
    morigin,     \* failureOrigin on disk: "none", "host-death", "unknown"
    wasTerminal, \* ghost: the manifest has shown a terminal status
    wasExited,   \* ghost: the manifest has shown "exited"
    startFailed, \* ghost: the host died because its files were missing
    sock,        \* the RPC socket file exists (it is outside the directory)
    cpc,         \* create: "alloc", "write", "launch", "done"
    hostAlive,   \* the detached host process is alive
    hpc,         \* host start-up path: "none", "boot", "open", "pidwrite",
                 \*   "sockdir", "serving", "idle", "dead"
    hex,         \* host exit path: "none", "wait", "exitwrite", "shutdown",
                 \*   "done", "gone"
    rsz,         \* one resize RPC: "none", "pending" (its write is in flight),
                 \*   "done"
    pc,          \* pc["gc"] and pc["list"]
    rd,          \* rd[p]: the manifest that reconcileSession read in process p
    gres,        \* what gc did: "pending", "skipped", "removed"
    lruns        \* how many reconciles "list" has started

diskVars == <<dir, mst, mpid, morigin, wasTerminal, wasExited>>
ghostVars == <<startFailed>>
hostVars == <<hostAlive, hpc, hex, rsz>>
readerVars == <<pc, rd, gres, lruns>>
vars == <<diskVars, ghostVars, sock, cpc, hostVars, readerVars>>

Init ==
    /\ dir = FALSE /\ mst = "none" /\ mpid = FALSE /\ morigin = "none"
    /\ wasTerminal = FALSE /\ wasExited = FALSE /\ startFailed = FALSE
    /\ sock = FALSE
    /\ cpc = "alloc"
    /\ hostAlive = FALSE /\ hpc = "none" /\ hex = "none" /\ rsz = "none"
    /\ pc = [p \in Readers |-> IF p = "gc" THEN "stat" ELSE "idle"]
    /\ rd = [p \in Readers |-> [st |-> "none", pid |-> FALSE]]
    /\ gres = "pending"
    /\ lruns = 0

\* writeManifest -> writeTextFileAtomic in src/storage/manifests.ts: mkdir -p
\* the session directory, write a temp file, rename it over session.json.
\* The rename is the visible step. The mkdir brings back a removed directory.
Write(s, pid, origin) ==
    /\ dir' = TRUE
    /\ mst' = s
    /\ mpid' = pid
    /\ morigin' = origin
    /\ wasTerminal' = (wasTerminal \/ s \in Terminal)
    /\ wasExited' = (wasExited \/ s = "exited")

\* The host fails to start because its files are missing or were rewritten.
HostFailsToStart ==
    /\ startFailed' = TRUE
    /\ hostAlive' = FALSE
    /\ hpc' = "dead"
    /\ hex' = IF hex = "none" THEN "none" ELSE "gone"
    /\ rsz' = rsz

\* The host process ends abnormally. Its exit path ends with it.
HostDies ==
    /\ hostAlive' = FALSE
    /\ hpc' = "dead"
    /\ hex' = IF hex = "none" THEN "none" ELSE "gone"
    /\ rsz' = IF rsz = "pending" THEN "done" ELSE rsz

\* -------------------------------------------------------------------------
\* create

\* With CreateRecordsHostPid, allocateSession calls launch (launchHost) and
\* then writes the first manifest with the pid that launch returned, so no
\* manifest exists without its hostPid. Without it, allocateSession writes a
\* manifest with hostPid null, and create calls launchHost after that.

\* allocateSession: mkdir(sessionDirectory), chmod 0o700.
CreateMakesDirectory ==
    /\ cpc = "alloc"
    /\ dir' = TRUE
    /\ cpc' = IF CreateRecordsHostPid THEN "launch" ELSE "write"
    /\ UNCHANGED <<mst, mpid, morigin, wasTerminal, wasExited, ghostVars, sock,
                   hostVars, readerVars>>

\* allocateSession: writeManifest with status "running".
CreateWritesManifest ==
    /\ cpc = "write"
    /\ Write("running", CreateRecordsHostPid, "none")
    /\ cpc' = IF CreateRecordsHostPid THEN "done" ELSE "launch"
    /\ UNCHANGED <<ghostVars, sock, hostVars, readerVars>>

\* launchHost spawns the detached `_host` process.
CreateLaunchesHost ==
    /\ cpc = "launch"
    /\ hostAlive' = TRUE
    /\ hpc' = "boot"
    /\ cpc' = IF CreateRecordsHostPid THEN "write" ELSE "done"
    /\ UNCHANGED <<diskVars, ghostVars, sock, hex, rsz, readerVars>>

\* -------------------------------------------------------------------------
\* host start-up path (runHost)

\* The host reads its manifest. With HostWaitsForManifest it waits while the
\* manifest is missing (create writes it right after the spawn); it gives up
\* after a time-out, which HostCrashes covers. A missing manifest without the
\* wait, or a status other than "running", throws, and the host exits.
HostReadsManifest ==
    /\ hostAlive /\ hpc = "boot"
    /\ ~(HostWaitsForManifest /\ mst = "none")
    /\ IF mst = "running"
          THEN /\ hpc' = "open" /\ UNCHANGED <<hostAlive, hex, rsz, ghostVars>>
          ELSE HostFailsToStart
    /\ UNCHANGED <<diskVars, sock, cpc, readerVars>>

\* EventLog.open(events.jsonl, 'a') throws when the directory is gone. From
\* there to `await writeManifest(mPath, state.snapshot())` near the end of
\* runHost the code is synchronous: createPty spawns the program, and the
\* manifest write starts with status "running" and both pids.
HostOpensLogAndSpawns ==
    /\ hostAlive /\ hpc = "open"
    /\ IF dir
          THEN /\ hpc' = "pidwrite" /\ hex' = "wait"
               /\ UNCHANGED <<hostAlive, rsz, ghostVars>>
          ELSE HostFailsToStart
    /\ UNCHANGED <<diskVars, sock, cpc, readerVars>>

\* The start-up write lands. It is the host's in-memory record, so it
\* replaces whatever another process wrote after the host read the manifest.
HostWritesPids ==
    /\ hostAlive /\ hpc = "pidwrite"
    /\ Write("running", TRUE, "none")
    /\ hpc' = "sockdir"
    /\ UNCHANGED <<ghostVars, sock, cpc, hostAlive, hex, rsz, readerVars>>

\* `if (!isSessionCommandable(state))` shut down, else rpcServer.listen().
\* The program has ended exactly when the exit path has left "wait".
HostListens ==
    /\ hostAlive /\ hpc = "sockdir"
    /\ IF hex = "wait"
          THEN /\ sock' = TRUE /\ hpc' = "serving"
          ELSE /\ hpc' = "idle" /\ UNCHANGED sock
    /\ UNCHANGED <<diskVars, ghostVars, cpc, hostAlive, hex, rsz, readerVars>>

\* The resize handler: setDimensions in memory, then writeManifest with
\* status "running". The write starts here and lands in the next step.
HostStartsResize ==
    /\ hostAlive /\ hpc = "serving" /\ hex = "wait" /\ rsz = "none"
    /\ rsz' = "pending"
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostAlive, hpc, hex,
                   readerVars>>

HostResizeWriteLands ==
    /\ hostAlive /\ rsz = "pending"
    /\ Write("running", TRUE, "none")
    /\ rsz' = "done"
    /\ UNCHANGED <<ghostVars, sock, cpc, hostAlive, hpc, hex, readerVars>>

\* -------------------------------------------------------------------------
\* host exit path (pty.onExit -> handlePtyExit -> initiateShutdown)

\* The program ends: on its own, by the idle time-out, or by a signal.
\* recordExit (in memory) and the 'exit' event append; no other process can
\* see this step.
ProgramExits ==
    /\ hostAlive /\ hex = "wait"
    /\ hex' = "exitwrite"
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostAlive, hpc, rsz,
                   readerVars>>

\* writeManifest with status "exited" and the exit code. With
\* HostSerializesWrites, createSerialManifestWriter runs the host's writes
\* in call order, so this write lands after a start-up or resize write that
\* was already in flight. Without it, nothing orders them.
HostWritesExit ==
    /\ hostAlive /\ hex = "exitwrite"
    /\ HostSerializesWrites => (hpc # "pidwrite" /\ rsz # "pending")
    /\ Write("exited", TRUE, "none")
    /\ hex' = "shutdown"
    /\ UNCHANGED <<ghostVars, sock, cpc, hostAlive, hpc, rsz, readerVars>>

\* initiateShutdown: eventLog.close, renderer dispose, rpcServer.close. close
\* unlinks the socket file also when the server never listened.
HostClosesSocket ==
    /\ hostAlive /\ hex = "shutdown"
    /\ sock' = FALSE
    /\ hex' = "done"
    /\ UNCHANGED <<diskVars, ghostVars, cpc, hostAlive, hpc, rsz, readerVars>>

\* The process ends when both paths are finished and no write is in flight.
HostProcessEnds ==
    /\ hostAlive /\ hex = "done" /\ hpc \in {"serving", "idle"}
    /\ rsz # "pending"
    /\ hostAlive' = FALSE
    /\ hpc' = "dead"
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hex, rsz, readerVars>>

\* SIGKILL, OOM, or an uncaught error, at any point. The socket file stays.
HostCrashes ==
    /\ hostAlive
    /\ HostDies
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, readerVars>>

\* -------------------------------------------------------------------------
\* reconcileSession, run by process p

AfterReconcile(p) == IF p = "gc" THEN "readafter" ELSE "idle"

\* `if (manifest.hostPid !== null && hostAlive) return`, where hostAlive is
\* isProcessAlive(manifest.hostPid). A null hostPid reads as a dead host.
SkipsHost(read) == ReconcileSkipsLiveHost /\ read.pid /\ hostAlive

\* readManifestIfExists; return when it is null or terminal.
ReconcileReads(p) ==
    /\ pc[p] = "r_read"
    /\ IF mst = "none" \/ (ReconcileSkipsTerminal /\ mst \in Terminal)
          THEN /\ pc' = [pc EXCEPT ![p] = AfterReconcile(p)]
               /\ UNCHANGED rd
          ELSE /\ pc' = [pc EXCEPT ![p] = "r_check"]
               /\ rd' = [rd EXCEPT ![p] = [st |-> mst, pid |-> mpid]]
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, gres, lruns>>

\* One synchronous block: isProcessAlive(hostPid), the pid check, and the
\* kill of the child process if it is alive.
ReconcileChecksHost(p) ==
    /\ pc[p] = "r_check"
    /\ pc' = [pc EXCEPT ![p] =
                IF SkipsHost(rd[p]) THEN AfterReconcile(p)
                ELSE IF ReconcileRereads THEN "r_reread"
                ELSE "r_write"]
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, rd, gres, lruns>>

\* With ReconcileRereads: `current = readManifestIfExists`, taken after the
\* host was found dead, so no host write can follow it; return when it is
\* null or terminal, else reconcile from it.
ReconcileRereadsManifest(p) ==
    /\ pc[p] = "r_reread"
    /\ IF mst = "none" \/ mst \in Terminal
          THEN /\ pc' = [pc EXCEPT ![p] = AfterReconcile(p)]
               /\ UNCHANGED rd
          ELSE /\ pc' = [pc EXCEPT ![p] = "r_write"]
               /\ rd' = [rd EXCEPT ![p] = [st |-> mst, pid |-> mpid]]
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, gres, lruns>>

\* writeManifest(reconciledManifest): "running" becomes failed/host-death,
\* any other status that gets here becomes failed/unknown (the default
\* branch). hostPid and childPid become null.
ReconcileWrites(p) ==
    /\ pc[p] = "r_write"
    /\ Write("failed", FALSE,
             IF rd[p].st = "running" THEN "host-death" ELSE "unknown")
    /\ pc' = [pc EXCEPT ![p] = "r_unlink"]
    /\ UNCHANGED <<ghostVars, sock, cpc, hostVars, rd, gres, lruns>>

\* unlinkIfPresent(socketPath(sessionDirectory))
ReconcileUnlinksSocket(p) ==
    /\ pc[p] = "r_unlink"
    /\ sock' = FALSE
    /\ pc' = [pc EXCEPT ![p] = AfterReconcile(p)]
    /\ UNCHANGED <<diskVars, ghostVars, cpc, hostVars, rd, gres, lruns>>

\* -------------------------------------------------------------------------
\* gc

GcSkips ==
    /\ pc' = [pc EXCEPT !["gc"] = "done"]
    /\ gres' = "skipped"

GcGoesTo(next) ==
    /\ pc' = [pc EXCEPT !["gc"] = next]
    /\ UNCHANGED gres

\* readdir(sessions) and stat(sessionDirectory). Both only skip when the
\* directory is gone, so they are one step here.
GcFindsDirectory ==
    /\ pc["gc"] = "stat"
    /\ IF dir THEN GcGoesTo("readbefore") ELSE GcSkips
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, rd, lruns>>

\* manifestBefore = readManifestIfExists; skip when it is missing.
GcReadsManifest ==
    /\ pc["gc"] = "readbefore"
    /\ IF mst = "none" THEN GcSkips ELSE GcGoesTo("r_read")
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, rd, lruns>>

\* manifestAfter = readManifestIfExists; skip when it is missing or not
\* collectable ("session host is still alive").
GcReadsReconciled ==
    /\ pc["gc"] = "readafter"
    /\ IF mst = "none" \/ (GcSkipsNonCollectable /\ mst \notin Collectable)
          THEN GcSkips
          ELSE GcGoesTo("final")
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, rd, lruns>>

\* finalManifest = readManifestIfExists; skip when it is there and not
\* collectable ("session restarted between check and delete").
GcFinalRead ==
    /\ pc["gc"] = "final"
    /\ IF GcFinalCheck /\ mst # "none" /\ mst \notin Collectable
          THEN GcSkips
          ELSE GcGoesTo("rm")
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, rd, lruns>>

\* rm(sessionDirectory, { recursive: true, force: true })
GcRemoves ==
    /\ pc["gc"] = "rm"
    /\ dir' = FALSE /\ mst' = "none" /\ mpid' = FALSE /\ morigin' = "none"
    /\ pc' = [pc EXCEPT !["gc"] = "done"]
    /\ gres' = "removed"
    /\ UNCHANGED <<wasTerminal, wasExited, ghostVars, sock, cpc, hostVars, rd,
                   lruns>>

\* -------------------------------------------------------------------------
\* list: another command that reconciles this session (see the header)

ListStartsReconcile ==
    /\ pc["list"] = "idle" /\ lruns < MaxListReconciles
    /\ pc' = [pc EXCEPT !["list"] = "r_read"]
    /\ lruns' = lruns + 1
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, rd, gres>>

\* Every process is finished. This step keeps TLC from reporting the end
\* states as deadlocks. Any other state without a step is a model error.
AllFinished ==
    /\ cpc = "done" /\ ~hostAlive /\ pc["gc"] = "done"
    /\ pc["list"] = "idle" /\ lruns = MaxListReconciles
    /\ UNCHANGED vars

Next ==
    \/ CreateMakesDirectory \/ CreateWritesManifest \/ CreateLaunchesHost
    \/ HostReadsManifest \/ HostOpensLogAndSpawns \/ HostWritesPids
    \/ HostListens \/ HostStartsResize \/ HostResizeWriteLands
    \/ ProgramExits \/ HostWritesExit \/ HostClosesSocket \/ HostProcessEnds
    \/ HostCrashes
    \/ \E p \in Readers :
          \/ ReconcileReads(p) \/ ReconcileChecksHost(p)
          \/ ReconcileRereadsManifest(p)
          \/ ReconcileWrites(p) \/ ReconcileUnlinksSocket(p)
    \/ GcFindsDirectory \/ GcReadsManifest \/ GcReadsReconciled
    \/ GcFinalRead \/ GcRemoves
    \/ ListStartsReconcile
    \/ AllFinished

Spec == Init /\ [][Next]_vars

\* -------------------------------------------------------------------------
\* Rules. check.sh runs each one on its own.

TypeOK ==
    /\ {dir, mpid, wasTerminal, wasExited, startFailed, sock, hostAlive}
          \subseteq BOOLEAN
    /\ mst \in {"none", "running", "exited", "failed"}
    /\ morigin \in {"none", "host-death", "unknown"}
    /\ (mst # "none") => dir
    /\ (dir /\ mst = "none") => cpc # "done"
    /\ gres \in {"pending", "skipped", "removed"}
    /\ lruns \in 0..MaxListReconciles

\* The host can still write the session's files: it is alive and has not yet
\* written its "exited" record, or one of its manifest writes is in flight.
HostMayStillWrite ==
    /\ hostAlive
    /\ \/ hex \notin {"shutdown", "done"}
       \/ hpc = "pidwrite"
       \/ rsz = "pending"

\* R1: gc never removes the directory of a session whose host can still
\* write to it.
NoLiveSessionDeleted == HostMayStillWrite => dir

\* R2: the manifest blames a dead host only when the host is dead.
HostDeathOnlyWhenDead ==
    (mst = "failed" /\ morigin = "host-death") => ~hostAlive

\* R3: once the manifest shows a terminal status, it never shows an active
\* status again. CONTEXT.md: a Terminal Session "has reached a final
\* persisted state".
TerminalIsFinal == wasTerminal => mst \in Terminal \cup {"none"}

\* R4: once the manifest records that the program exited, no process
\* replaces that record with another status.
RecordedExitKept == wasExited => mst \in {"exited", "none"}

\* R5: while the host serves a session whose program still runs, the socket
\* file that every command connects to exists.
RunningSessionReachable ==
    (hostAlive /\ hpc = "serving" /\ hex = "wait") => sock

\* R6: a host never fails to start because its files were missing or were
\* rewritten by another process. Only an outside crash stops a start-up.
HostStartsWhenCreated == ~startFailed

\* Witnesses. check.sh expects TLC to report each one VIOLATED, which shows
\* that the model reaches the state: the rules above are not true only
\* because the model can never get there.
WitnessGcRemovesSession == gres # "removed"
WitnessSessionServes == ~(hpc = "serving" /\ sock /\ mst = "running" /\ mpid)
WitnessResizeLands == ~(rsz = "done" /\ hostAlive /\ mst = "running")
WitnessCleanExitRecorded == ~(mst = "exited" /\ ~hostAlive)
WitnessCrashReconciled ==
    ~(mst = "failed" /\ morigin = "host-death" /\ hpc = "dead")
=============================================================================
