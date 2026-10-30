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
(*           handler, the destroy handler, the SIGTERM handler, and the    *)
(*           exit path (handlePtyExit, initiateShutdown)                   *)
(*   gc      src/cli/commands/gc.ts gcSessions, one entry, not --dry-run   *)
(*   list    another command that calls reconcileSession: gc --dry-run,    *)
(*           the create time-out and the reconciles in destroySession      *)
(*           always do; list, inspect and the dashboard do after their own *)
(*           read shows an active status. This process may reconcile at    *)
(*           any time, so it covers all of them.                           *)
(*   destroy src/host/lifecycle.ts destroySession, with or without --force *)
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
    HostStopsAfterTerminalWrite, \* manifestWriter.ts: write nothing after a
                            \*   terminal record
    ShutdownChecksCommandable, \* hostMain.ts: initiateShutdown requests
                            \*   destroy only while the session is commandable
    DestroyRecordsDestroyed, \* lifecycle.ts: every successful destroySession
                            \*   records destroyed through recordDestroyed
    DestroyKeepsExitCode,   \* lifecycle.ts: recordDestroyed writes
                            \*   { ...manifest, status, updatedAt } only
    MaxListReconciles       \* how many times the "list" process reconciles

ASSUME MaxListReconciles \in 1..3
ASSUME \A b \in {GcSkipsNonCollectable, GcFinalCheck, ReconcileSkipsTerminal,
                 ReconcileSkipsLiveHost, CreateRecordsHostPid,
                 HostWaitsForManifest, ReconcileRereads,
                 HostSerializesWrites, HostStopsAfterTerminalWrite,
                 ShutdownChecksCommandable,
                 DestroyRecordsDestroyed, DestroyKeepsExitCode} : b \in BOOLEAN

Readers == {"gc", "list"}   \* the two processes that run reconcileSession
NoRead == [pid |-> FALSE, origin |-> "none", code |-> FALSE]

VARIABLES
    dir,         \* the session directory exists
    mst,         \* manifest status on disk; "none" when there is no manifest
    mpid,        \* the manifest on disk records a hostPid
    morigin,     \* failureOrigin on disk: "none", "host-death", "unknown"
    mcode,       \* the manifest on disk records the program's exit code
    wasTerminal, \* ghost: the manifest has shown a terminal status
    wasExited,   \* ghost: the manifest has shown "exited"
    startFailed, \* ghost: the host died because its files were missing
    sock,        \* the RPC socket file exists (it is outside the directory)
    cpc,         \* create: "alloc", "write", "launch", "done"
    hostAlive,   \* the detached host process is alive
    hpc,         \* host start-up path: "none", "boot", "open", "pidwrite",
                 \*   "sockdir", "serving", "idle", "dead"
    hex,         \* host exit path: "none", "wait" (the program runs),
                 \*   "exitwrite" (its exit write is queued), "done", "gone"
    rsz,         \* one resize RPC: "none", "pending" (its write is in flight),
                 \*   "done"
    hst,         \* the host's in-memory status (SessionState): "running",
                 \*   "destroying", "exited", "destroyed"
    hsd,         \* initiateShutdown: "none", "write" (its "destroying" write
                 \*   is queued), "wait" (it waits for the program and the
                 \*   listen), "closed" (rpcServer.close unlinked the socket)
    dsnap,       \* the snapshot that the queued "destroying" write took when
                 \*   its turn started; "none" while it waits for its turn
    hwt,         \* the host's writer has written a terminal record
    sig,         \* the host got its one SIGTERM
    pc,          \* pc["gc"] and pc["list"]
    rd,          \* rd[p]: the manifest that reconcileSession read in process p
    gres,        \* what gc did: "pending", "skipped", "removed"
    lruns,       \* how many reconciles "list" has started
    dpc,         \* destroy: "read", "twrite", "tunlink", "kill", "reread",
                 \*   "rpc", "poll", "final", "done"
    dforce,      \* destroy runs with --force
    drd,         \* the manifest copy that destroy writes "destroyed" from
    dres,        \* what destroy reported: "pending", "ok", "error"
    dsaw,        \* ghost: destroy wrote "destroyed" or read it last
    dkill        \* ghost: destroy --force killed a live host

diskVars == <<dir, mst, mpid, morigin, mcode, wasTerminal, wasExited>>
ghostVars == <<startFailed>>
hostVars == <<hostAlive, hpc, hex, rsz>>
shutVars == <<hst, hsd, dsnap, hwt, sig>>
readerVars == <<pc, rd, gres, lruns>>
destroyVars == <<dpc, dforce, drd, dres, dsaw, dkill>>
vars == <<diskVars, ghostVars, sock, cpc, hostVars, shutVars, readerVars,
          destroyVars>>

Init ==
    /\ dir = FALSE /\ mst = "none" /\ mpid = FALSE /\ morigin = "none"
    /\ mcode = FALSE
    /\ wasTerminal = FALSE /\ wasExited = FALSE /\ startFailed = FALSE
    /\ sock = FALSE
    /\ cpc = "alloc"
    /\ hostAlive = FALSE /\ hpc = "none" /\ hex = "none" /\ rsz = "none"
    /\ hst = "running" /\ hsd = "none" /\ dsnap = "none" /\ hwt = FALSE
    /\ sig = FALSE
    /\ pc = [p \in Readers |-> IF p = "gc" THEN "stat" ELSE "idle"]
    /\ rd = [p \in Readers |-> [st |-> "none", pid |-> FALSE, code |-> FALSE]]
    /\ gres = "pending"
    /\ lruns = 0
    /\ dpc = "read" /\ dforce \in BOOLEAN /\ drd = NoRead /\ dres = "pending"
    /\ dsaw = FALSE /\ dkill = FALSE

\* writeManifest -> writeTextFileAtomic in src/storage/manifests.ts: mkdir -p
\* the session directory, write a temp file, rename it over session.json.
\* The rename is the visible step. The mkdir brings back a removed directory.
Write(s, pid, origin, code) ==
    /\ dir' = TRUE
    /\ mst' = s
    /\ mpid' = pid
    /\ morigin' = origin
    /\ mcode' = code
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
    /\ UNCHANGED <<mst, mpid, morigin, mcode, wasTerminal, wasExited,
                   ghostVars, sock, hostVars, shutVars, readerVars,
                   destroyVars>>

\* allocateSession: writeManifest with status "running".
CreateWritesManifest ==
    /\ cpc = "write"
    /\ Write("running", CreateRecordsHostPid, "none", FALSE)
    /\ cpc' = IF CreateRecordsHostPid THEN "done" ELSE "launch"
    /\ UNCHANGED <<ghostVars, sock, hostVars, shutVars, readerVars,
                   destroyVars>>

\* launchHost spawns the detached `_host` process.
CreateLaunchesHost ==
    /\ cpc = "launch"
    /\ hostAlive' = TRUE
    /\ hpc' = "boot"
    /\ cpc' = IF CreateRecordsHostPid THEN "write" ELSE "done"
    /\ UNCHANGED <<diskVars, ghostVars, sock, hex, rsz, shutVars, readerVars,
                   destroyVars>>

\* -------------------------------------------------------------------------
\* The host's serial manifest writer (createSerialManifestWriter). Each write
\* takes its snapshot of the in-memory state when its turn starts, which is
\* right after the write before it lands, or at the call when no write is
\* queued. Only the "destroying" write of initiateShutdown can wait for its
\* turn while the state changes, so only it keeps its snapshot in a variable.
\* The other writes carry a status that cannot change before their turn.

WriteQueued == hpc = "pidwrite" \/ rsz = "pending" \/ hex = "exitwrite"

\* Reachable only without ShutdownChecksCommandable: destroy requested after
\* the program ended.
ExitWriteAheadOfDestroying == hex = "exitwrite" /\ hst = "destroying"

DestroyingWriteAheadOfExit == hsd = "write" /\ hst = "destroyed"

WriterStopped == HostSerializesWrites /\ HostStopsAfterTerminalWrite /\ hwt

\* A host write lands, or writes nothing once the writer has stopped. The
\* record carries the exit code once recordExit or recordDestroyed ran.
HostWrite(s, code) ==
    IF WriterStopped
    THEN UNCHANGED <<diskVars, hwt>>
    ELSE /\ Write(s, TRUE, "none", code)
         /\ hwt' = (hwt \/ s \in Terminal)

\* A write lands. When the queued "destroying" write is next, its turn starts
\* in the same microtask chain and it takes its snapshot.
NextTurn(stillAhead) ==
    IF hsd = "write" /\ dsnap = "none" /\ ~stillAhead THEN hst ELSE dsnap

\* initiateShutdown up to its first await: abort, clearIdleTimeout, and
\* `if (isSessionCommandable(state))` pty.kill(), state.requestDestroy() and
\* persistManifest(). It runs once; a later call returns the same promise.
\* Without ShutdownChecksCommandable it requests destroy also after the
\* program exited (requestDestroy accepts "exited").
StartShutdown(ahead) ==
    IF hsd # "none"
    THEN UNCHANGED <<hst, hsd, dsnap>>
    ELSE IF hst = "running" \/ (~ShutdownChecksCommandable /\ hst = "exited")
    THEN /\ hst' = "destroying"
         /\ hsd' = "write"
         /\ dsnap' = IF HostSerializesWrites /\ ahead THEN "none"
                     ELSE "destroying"
    ELSE /\ hsd' = "wait"
         /\ UNCHANGED <<hst, dsnap>>

\* -------------------------------------------------------------------------
\* host start-up path (runHost)

\* The host reads its manifest. With HostWaitsForManifest it waits while the
\* manifest is missing (create writes it right after the spawn); it gives up
\* only when the create process has exited, which HostCrashes covers. A
\* missing manifest without the wait, or a status other than "running",
\* throws, and the host exits.
HostReadsManifest ==
    /\ hostAlive /\ hpc = "boot"
    /\ ~(HostWaitsForManifest /\ mst = "none")
    /\ IF mst = "running"
          THEN /\ hpc' = "open" /\ UNCHANGED <<hostAlive, hex, rsz, ghostVars>>
          ELSE HostFailsToStart
    /\ UNCHANGED <<diskVars, sock, cpc, shutVars, readerVars, destroyVars>>

\* EventLog.open(events.jsonl, 'a') throws when the directory is gone. From
\* there to `await writeManifest(mPath, state.snapshot())` near the end of
\* runHost the code is synchronous: createPty spawns the program,
\* process.on('SIGTERM') registers the handler, and the manifest write
\* starts with status "running" and both pids.
HostOpensLogAndSpawns ==
    /\ hostAlive /\ hpc = "open"
    /\ IF dir
          THEN /\ hpc' = "pidwrite" /\ hex' = "wait"
               /\ UNCHANGED <<hostAlive, rsz, ghostVars>>
          ELSE HostFailsToStart
    /\ UNCHANGED <<diskVars, sock, cpc, shutVars, readerVars, destroyVars>>

\* The start-up write lands. It is the host's in-memory record, so it
\* replaces whatever another process wrote after the host read the manifest.
HostWritesPids ==
    /\ hostAlive /\ hpc = "pidwrite"
    /\ HostWrite("running", FALSE)
    /\ hpc' = "sockdir"
    /\ dsnap' = NextTurn(ExitWriteAheadOfDestroying)
    /\ UNCHANGED <<ghostVars, sock, cpc, hostAlive, hex, rsz, hst, hsd, sig,
                   readerVars, destroyVars>>

\* `if (!isSessionCommandable(state))` initiateShutdown, else
\* rpcServer.listen().
HostListens ==
    /\ hostAlive /\ hpc = "sockdir"
    /\ IF hst = "running"
          THEN /\ sock' = TRUE /\ hpc' = "serving"
               /\ UNCHANGED <<hst, hsd, dsnap>>
          ELSE /\ hpc' = "idle" /\ UNCHANGED sock
               /\ StartShutdown(WriteQueued)
    /\ UNCHANGED <<diskVars, ghostVars, cpc, hostAlive, hex, rsz, hwt, sig,
                   readerVars, destroyVars>>

\* The resize handler: assertSessionCommandable, setDimensions in memory,
\* then writeManifest with status "running". No write is queued then, so the
\* snapshot is taken at once.
HostStartsResize ==
    /\ hostAlive /\ hpc = "serving" /\ hst = "running" /\ rsz = "none"
    /\ rsz' = "pending"
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostAlive, hpc, hex,
                   shutVars, readerVars, destroyVars>>

HostResizeWriteLands ==
    /\ hostAlive /\ rsz = "pending"
    /\ HostWrite("running", FALSE)
    /\ rsz' = "done"
    /\ dsnap' = NextTurn(ExitWriteAheadOfDestroying)
    /\ UNCHANGED <<ghostVars, sock, cpc, hostAlive, hpc, hex, hst, hsd, sig,
                   readerVars, destroyVars>>

\* -------------------------------------------------------------------------
\* host shutdown: the destroy handler, the SIGTERM handler, initiateShutdown

\* process.on('SIGTERM', () => startShutdown()). Before HostOpensLogAndSpawns
\* registers it, a SIGTERM kills the host, which HostCrashes covers.
HostGetsSigterm ==
    /\ hostAlive /\ ~sig /\ hpc \in {"pidwrite", "sockdir", "serving", "idle"}
    /\ sig' = TRUE
    /\ StartShutdown(WriteQueued)
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, hwt, readerVars,
                   destroyVars>>

\* initiateShutdown's `await persistManifest()` lands, then its finally block
\* starts.
HostWritesDestroying ==
    /\ hostAlive /\ hsd = "write" /\ dsnap # "none"
    /\ HostWrite(dsnap, dsnap = "destroyed")
    /\ hsd' = "wait" /\ dsnap' = "none"
    /\ UNCHANGED <<ghostVars, sock, cpc, hostVars, hst, sig, readerVars,
                   destroyVars>>

\* The finally block of initiateShutdown: await ptyExitPromise (the program
\* ended), await rpcListenPromise, eventLog.close, rendererManager.dispose,
\* then rpcServer.close, which unlinks the socket file also when the server
\* never listened.
HostClosesSocket ==
    /\ hostAlive /\ hsd = "wait" /\ hex \in {"exitwrite", "done"}
    /\ sock' = FALSE /\ hsd' = "closed"
    /\ UNCHANGED <<diskVars, ghostVars, cpc, hostVars, hst, dsnap, hwt, sig,
                   readerVars, destroyVars>>

\* -------------------------------------------------------------------------
\* host exit path (pty.onExit -> handlePtyExit)

\* The program ends: on its own, by the idle time-out, by a signal, or by
\* the pty.kill of initiateShutdown. handlePtyExit: recordDestroyed when the
\* status is "destroying", else recordExit (both in memory), then the 'exit'
\* event append and persistManifest; no other process can see this step.
ProgramExits ==
    /\ hostAlive /\ hex = "wait"
    /\ hex' = "exitwrite"
    /\ hst' = IF hst = "destroying" THEN "destroyed" ELSE "exited"
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostAlive, hpc, rsz, hsd,
                   dsnap, hwt, sig, readerVars, destroyVars>>

\* handlePtyExit's persistManifest lands: "exited" or "destroyed" with the
\* exit code. In the code nothing changes the status after recordExit or
\* recordDestroyed, so the write carries hst. Then
\* `finally { await initiateShutdown() }`.
HostWritesExit ==
    /\ hostAlive /\ hex = "exitwrite"
    /\ HostSerializesWrites =>
          (hpc # "pidwrite" /\ rsz # "pending" /\ ~DestroyingWriteAheadOfExit)
    /\ HostWrite(hst, TRUE)
    /\ hex' = "done"
    /\ IF hsd = "none"
          THEN StartShutdown(FALSE)
          ELSE /\ dsnap' = NextTurn(FALSE) /\ UNCHANGED <<hst, hsd>>
    /\ UNCHANGED <<ghostVars, sock, cpc, hostAlive, hpc, rsz, sig, readerVars,
                   destroyVars>>

\* runHost has returned and every handle is closed, so the `_host` process
\* exits.
HostProcessEnds ==
    /\ hostAlive /\ hsd = "closed" /\ hex = "done"
    /\ hpc \in {"serving", "idle"} /\ rsz # "pending"
    /\ hostAlive' = FALSE
    /\ hpc' = "dead"
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hex, rsz, shutVars,
                   readerVars, destroyVars>>

\* SIGKILL, OOM, or an uncaught error, at any point. The socket file stays.
HostCrashes ==
    /\ hostAlive
    /\ HostDies
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, shutVars, readerVars,
                   destroyVars>>

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
               /\ rd' = [rd EXCEPT ![p] = [st |-> mst, pid |-> mpid,
                                           code |-> mcode]]
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, shutVars, gres,
                   lruns, destroyVars>>

\* One synchronous block: isProcessAlive(hostPid), the pid check, and the
\* kill of the child process if it is alive.
ReconcileChecksHost(p) ==
    /\ pc[p] = "r_check"
    /\ pc' = [pc EXCEPT ![p] =
                IF SkipsHost(rd[p]) THEN AfterReconcile(p)
                ELSE IF ReconcileRereads THEN "r_reread"
                ELSE "r_write"]
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, shutVars, rd,
                   gres, lruns, destroyVars>>

\* With ReconcileRereads: `current = readManifestIfExists`, taken after the
\* host was found dead, so no host write can follow it; return when it is
\* null or terminal, else reconcile from it.
ReconcileRereadsManifest(p) ==
    /\ pc[p] = "r_reread"
    /\ IF mst = "none" \/ mst \in Terminal
          THEN /\ pc' = [pc EXCEPT ![p] = AfterReconcile(p)]
               /\ UNCHANGED rd
          ELSE /\ pc' = [pc EXCEPT ![p] = "r_write"]
               /\ rd' = [rd EXCEPT ![p] = [st |-> mst, pid |-> mpid,
                                           code |-> mcode]]
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, shutVars, gres,
                   lruns, destroyVars>>

\* writeManifest(reconciledManifest): "running" becomes failed/host-death,
\* "destroying" becomes destroyed, any other status that gets here becomes
\* failed/unknown (the default branch). hostPid and childPid become null.
ReconcileWrites(p) ==
    /\ pc[p] = "r_write"
    /\ CASE rd[p].st = "running" ->
              Write("failed", FALSE, "host-death", rd[p].code)
         [] rd[p].st = "destroying" ->
              Write("destroyed", FALSE, "none", rd[p].code)
         [] OTHER -> Write("failed", FALSE, "unknown", rd[p].code)
    /\ pc' = [pc EXCEPT ![p] = "r_unlink"]
    /\ UNCHANGED <<ghostVars, sock, cpc, hostVars, shutVars, rd, gres, lruns,
                   destroyVars>>

\* unlinkIfPresent(socketPath(sessionDirectory))
ReconcileUnlinksSocket(p) ==
    /\ pc[p] = "r_unlink"
    /\ sock' = FALSE
    /\ pc' = [pc EXCEPT ![p] = AfterReconcile(p)]
    /\ UNCHANGED <<diskVars, ghostVars, cpc, hostVars, shutVars, rd, gres,
                   lruns, destroyVars>>

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
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, shutVars, rd,
                   lruns, destroyVars>>

\* manifestBefore = readManifestIfExists; skip when it is missing.
GcReadsManifest ==
    /\ pc["gc"] = "readbefore"
    /\ IF mst = "none" THEN GcSkips ELSE GcGoesTo("r_read")
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, shutVars, rd,
                   lruns, destroyVars>>

\* manifestAfter = readManifestIfExists; skip when it is missing or not
\* collectable ("session host is still alive").
GcReadsReconciled ==
    /\ pc["gc"] = "readafter"
    /\ IF mst = "none" \/ (GcSkipsNonCollectable /\ mst \notin Collectable)
          THEN GcSkips
          ELSE GcGoesTo("final")
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, shutVars, rd,
                   lruns, destroyVars>>

\* finalManifest = readManifestIfExists; skip when it is there and not
\* collectable ("session restarted between check and delete").
GcFinalRead ==
    /\ pc["gc"] = "final"
    /\ IF GcFinalCheck /\ mst # "none" /\ mst \notin Collectable
          THEN GcSkips
          ELSE GcGoesTo("rm")
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, shutVars, rd,
                   lruns, destroyVars>>

\* rm(sessionDirectory, { recursive: true, force: true })
GcRemoves ==
    /\ pc["gc"] = "rm"
    /\ dir' = FALSE /\ mst' = "none" /\ mpid' = FALSE /\ morigin' = "none"
    /\ mcode' = FALSE
    /\ pc' = [pc EXCEPT !["gc"] = "done"]
    /\ gres' = "removed"
    /\ UNCHANGED <<wasTerminal, wasExited, ghostVars, sock, cpc, hostVars,
                   shutVars, rd, lruns, destroyVars>>

\* -------------------------------------------------------------------------
\* list: another command that reconciles this session (see the header)

ListStartsReconcile ==
    /\ pc["list"] = "idle" /\ lruns < MaxListReconciles
    /\ pc' = [pc EXCEPT !["list"] = "r_read"]
    /\ lruns' = lruns + 1
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, shutVars, rd,
                   gres, destroyVars>>

\* -------------------------------------------------------------------------
\* destroy (destroySession). Its reconcileSession calls are the "list"
\* process's reconciles, so after each one this process only reads.

ReadCopy == [pid |-> mpid, origin |-> morigin, code |-> mcode]

DestroyEnds(result) ==
    /\ dpc' = "done" /\ dres' = result /\ drd' = NoRead
    /\ UNCHANGED dsaw

\* A terminal copy with DestroyRecordsDestroyed: recordDestroyed writes
\* destroyed from it unless it already says destroyed. Without it, destroy
\* returns on any terminal copy.
DestroyFinishes ==
    IF ~DestroyRecordsDestroyed
    THEN /\ dpc' = "done" /\ dres' = "ok" /\ drd' = NoRead
         /\ dsaw' = (mst = "destroyed")
    ELSE IF mst = "destroyed"
    THEN /\ dpc' = "tunlink" /\ dsaw' = TRUE /\ drd' = NoRead
         /\ UNCHANGED dres
    ELSE /\ dpc' = "twrite" /\ drd' = ReadCopy
         /\ UNCHANGED <<dres, dsaw>>

\* readSessionManifestOrThrow throws SESSION_NOT_FOUND on a missing manifest,
\* then destroySession throws SESSION_ALREADY_DESTROYED on a destroyed one. A
\* terminal copy goes to recordDestroyed, an active one to --force or to the
\* destroy RPC.
DestroyReads ==
    /\ dpc = "read"
    /\ IF mst \in {"none", "destroyed"}
          THEN DestroyEnds("error")
          ELSE IF mst \in Terminal
          THEN /\ dpc' = "twrite" /\ drd' = ReadCopy
               /\ UNCHANGED <<dres, dsaw>>
          ELSE IF dforce
          THEN /\ dpc' = "kill" /\ drd' = ReadCopy
               /\ UNCHANGED <<dres, dsaw>>
          ELSE /\ dpc' = "rpc" /\ UNCHANGED <<drd, dres, dsaw>>
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, shutVars,
                   readerVars, dforce, dkill>>

\* recordDestroyed: writeManifest({ ...manifest, status: 'destroyed' }) from
\* the copy that destroy read. Its mkdir brings back a folder that gc
\* removed in the meantime (coder/agent-tty#196).
DestroyWritesDestroyed ==
    /\ dpc = "twrite"
    /\ Write("destroyed", drd.pid, drd.origin, DestroyKeepsExitCode /\ drd.code)
    /\ dpc' = "tunlink" /\ drd' = NoRead /\ dsaw' = TRUE
    /\ UNCHANGED <<ghostVars, sock, cpc, hostVars, shutVars, readerVars,
                   dforce, dres, dkill>>

\* recordDestroyed: unlinkIfPresent(socketFile). destroy reports success.
DestroyUnlinksSocket ==
    /\ dpc = "tunlink"
    /\ sock' = FALSE
    /\ dpc' = "done" /\ dres' = "ok"
    /\ UNCHANGED <<diskVars, ghostVars, cpc, hostVars, shutVars, readerVars,
                   dforce, drd, dsaw, dkill>>

\* --force, stopSessionProcesses: killProcessBestEffort(childPid) and
\* killProcessBestEffort(hostPid), one synchronous block. The program ends
\* with the host, so waitForProcessesToExit then returns at once. With
\* DestroyRecordsDestroyed destroy reads the manifest again. Without it,
\* destroy goes to the reconcile and final read of the code before
\* recordDestroyed.
DestroyKills ==
    /\ dpc = "kill"
    /\ IF drd.pid /\ hostAlive
          THEN /\ HostDies /\ dkill' = TRUE
          ELSE UNCHANGED <<hostVars, dkill>>
    /\ dpc' = IF DestroyRecordsDestroyed THEN "reread" ELSE "final"
    /\ drd' = NoRead
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, shutVars, readerVars,
                   dforce, dres, dsaw>>

\* readSessionManifestOrThrow after both processes died, so no host write
\* can follow it. stopSessionProcesses(current) stops a program that only
\* this read names, and recordDestroyed writes from it.
DestroyRereads ==
    /\ dpc = "reread"
    /\ IF mst = "none"
          THEN DestroyEnds("error")
          ELSE IF mst = "destroyed"
          THEN /\ dpc' = "tunlink" /\ dsaw' = TRUE /\ UNCHANGED <<drd, dres>>
          ELSE /\ dpc' = "twrite" /\ drd' = ReadCopy
               /\ UNCHANGED <<dres, dsaw>>
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, shutVars,
                   readerVars, dforce, dkill>>

\* sendRpc(socketFile, 'destroy') reaches the host, whose destroy handler
\* calls startShutdown and answers. The host does the work, so this is one
\* step.
DestroySendsRpc ==
    /\ dpc = "rpc" /\ sock /\ hostAlive
    /\ StartShutdown(WriteQueued)
    /\ dpc' = "poll"
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, hwt, sig,
                   readerVars, dforce, drd, dres, dsaw, dkill>>

\* No socket file, or nobody listens on it: HOST_UNREACHABLE. destroy then
\* reconciles and reads the manifest.
DestroyRpcFails ==
    /\ dpc = "rpc" /\ ~(sock /\ hostAlive)
    /\ dpc' = "final"
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, shutVars,
                   readerVars, dforce, drd, dres, dsaw, dkill>>

\* waitForTerminalManifest: readManifest until it is terminal. A missing
\* manifest throws. A read that is not terminal is either retried or the
\* last one; destroy then reconciles and reads again.
DestroyPolls ==
    /\ dpc = "poll"
    /\ IF mst = "none"
          THEN DestroyEnds("error")
          ELSE IF mst \in Terminal
          THEN DestroyFinishes
          ELSE /\ dpc' = "final" /\ UNCHANGED <<drd, dres, dsaw>>
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, shutVars,
                   readerVars, dforce, dkill>>

\* readSessionManifestOrThrow after destroy's own reconcile: terminal means
\* success, anything else throws.
DestroyFinalRead ==
    /\ dpc = "final"
    /\ IF mst \in Terminal THEN DestroyFinishes ELSE DestroyEnds("error")
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, shutVars,
                   readerVars, dforce, dkill>>

\* Every process is finished. This step keeps TLC from reporting the end
\* states as deadlocks. Any other state without a step is a model error.
AllFinished ==
    /\ cpc = "done" /\ ~hostAlive /\ pc["gc"] = "done"
    /\ pc["list"] = "idle" /\ lruns = MaxListReconciles
    /\ dpc = "done"
    /\ UNCHANGED vars

Next ==
    \/ CreateMakesDirectory \/ CreateWritesManifest \/ CreateLaunchesHost
    \/ HostReadsManifest \/ HostOpensLogAndSpawns \/ HostWritesPids
    \/ HostListens \/ HostStartsResize \/ HostResizeWriteLands
    \/ HostGetsSigterm \/ HostWritesDestroying \/ HostClosesSocket
    \/ ProgramExits \/ HostWritesExit \/ HostProcessEnds
    \/ HostCrashes
    \/ \E p \in Readers :
          \/ ReconcileReads(p) \/ ReconcileChecksHost(p)
          \/ ReconcileRereadsManifest(p)
          \/ ReconcileWrites(p) \/ ReconcileUnlinksSocket(p)
    \/ GcFindsDirectory \/ GcReadsManifest \/ GcReadsReconciled
    \/ GcFinalRead \/ GcRemoves
    \/ ListStartsReconcile
    \/ DestroyReads \/ DestroyWritesDestroyed \/ DestroyUnlinksSocket
    \/ DestroyKills \/ DestroyRereads \/ DestroySendsRpc \/ DestroyRpcFails
    \/ DestroyPolls \/ DestroyFinalRead
    \/ AllFinished

Spec == Init /\ [][Next]_vars

\* -------------------------------------------------------------------------
\* Rules. check.sh runs each one on its own.

TypeOK ==
    /\ {dir, mpid, wasTerminal, wasExited, startFailed, sock, hostAlive, sig,
        dforce, dsaw, dkill} \subseteq BOOLEAN
    /\ mst \in {"none", "running", "destroying", "exited", "failed",
                "destroyed"}
    /\ morigin \in {"none", "host-death", "unknown"}
    /\ hst \in {"running", "destroying", "exited", "destroyed"}
    /\ hsd \in {"none", "write", "wait", "closed"}
    /\ dsnap \in {"none", "destroying", "destroyed"}
    /\ (mst # "none") => dir
    /\ (dir /\ mst = "none") => cpc # "done"
    /\ gres \in {"pending", "skipped", "removed"}
    /\ lruns \in 0..MaxListReconciles
    /\ dres \in {"pending", "ok", "error"}
    /\ {hwt, mcode} \subseteq BOOLEAN
    /\ (mst = "none") => ~mcode
    /\ (hostAlive /\ hsd = "write" /\ dsnap = "none") =>
          (hpc = "pidwrite" \/ rsz = "pending" \/ ExitWriteAheadOfDestroying)

HostMayStillWrite ==
    /\ hostAlive /\ ~WriterStopped
    /\ \/ hex \in {"none", "wait", "exitwrite"}
       \/ hpc = "pidwrite"
       \/ rsz = "pending"
       \/ hsd = "write"

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

\* R4: once the manifest records that the program exited, only destroy
\* changes it, to destroyed, and destroy keeps the exit code.
\* design/20260319_agent-tty-v1/02-cli-contract.md 17.2:
\* "if the PTY child already exited, destroy still reconciles the session
\* to destroyed".
RecordedExitKept ==
    wasExited => (mst = "none" \/ (mst \in {"exited", "destroyed"} /\ mcode))

\* R5: while the host serves a session whose program still runs, the socket
\* file that every command connects to exists.
RunningSessionReachable ==
    (hostAlive /\ hpc = "serving" /\ hex = "wait") => sock

\* R6: a host never fails to start because its files were missing or were
\* rewritten by another process. Only an outside crash stops a start-up.
HostStartsWhenCreated == ~startFailed

\* R7: a terminal manifest is the host's last write, so gc, which removes
\* terminal sessions, never races a host write.
TerminalIsLastWrite == mst \in Terminal => ~HostMayStillWrite

\* R8: the manifest says destroyed only after the program has ended. A dead
\* host ends its program (see the Scope section of SKILL.md).
DestroyedOnlyWhenEnded ==
    (mst = "destroyed" /\ hostAlive) => hex \in {"exitwrite", "done"}

\* R9: destroy reports success only after it wrote destroyed or read it.
DestroyEndsDestroyed == dres = "ok" => dsaw

\* Witnesses. check.sh expects TLC to report each one VIOLATED, which shows
\* that the model reaches the state: the rules above are not true only
\* because the model can never get there.
WitnessGcRemovesSession == gres # "removed"
WitnessSessionServes == ~(hpc = "serving" /\ sock /\ mst = "running" /\ mpid)
WitnessResizeLands == ~(rsz = "done" /\ hostAlive /\ mst = "running")
WitnessCleanExitRecorded == ~(mst = "exited" /\ ~hostAlive)
WitnessCrashReconciled ==
    ~(mst = "failed" /\ morigin = "host-death" /\ hpc = "dead")
WitnessDestroyCompletes ==
    ~(dres = "ok" /\ ~dforce /\ ~sig /\ ~wasExited /\ mst = "destroyed"
      /\ hex = "done" /\ ~hostAlive)
WitnessSigtermRecorded ==
    ~(sig /\ dpc = "read" /\ mst = "destroyed" /\ hex = "done" /\ ~hostAlive)
WitnessDestroyExitedSession ==
    ~(wasExited /\ mst = "destroyed" /\ dres = "ok")
WitnessForceDestroyRecorded == ~(dkill /\ dres = "ok" /\ mst = "destroyed")
=============================================================================
