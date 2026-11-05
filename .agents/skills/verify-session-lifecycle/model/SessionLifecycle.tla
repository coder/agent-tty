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
(*   destroy src/cli/commands/destroy.ts runDestroyCommand and             *)
(*           src/host/lifecycle.ts destroySession, with or without --force *)
(*   program the PTY child and the processes it starts. node-pty starts it  *)
(*           as a session leader, so its pid is its process group id.       *)
(*                                                                         *)
(* The host records the program in program.json with its session token:    *)
(* the boot id and the autogroup id that setsid() gave the program's       *)
(* session (src/host/programGroup.ts). With Token, that capture succeeds,  *)
(* as on Linux with autogroups, and every kill of the group checks that a  *)
(* live member carries the token, so a kill never reaches another group    *)
(* that took the id after the program's group ended. Without Token there   *)
(* is no token: on macOS, on a kernel without autogroups, when the capture *)
(* read none, and for a session that an older agent-tty created. Every     *)
(* kill then targets the id as it is, as before program.json existed.      *)
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
    GcKeepsLiveGroup,       \* gc.ts: skip a session that is not destroyed
                            \*   while program.json proves that its group
                            \*   runs
    GcProbesUnseenGroup,    \* programGroup.ts: provenProgramGroupRuns also
                            \*   counts a group id that the probe finds
                            \*   while no scan shows a member
    GcFreezesUnseenGroup,   \* programGroup.ts: gc sends SIGSTOP to a group
                            \*   whose scans show only zombies while the
                            \*   probe finds its id, and judges it again
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
    ManifestWriteNeedsFolder, \* manifests.ts: writeManifest runs no mkdir
    KillsProgramGroup,      \* programGroup.ts, lifecycle.ts, hostMain.ts:
                            \*   every kill of the program SIGKILLs its
                            \*   process group, and waitForProcessesToExit
                            \*   waits for the group
    ProbeCountsDeniedGroup, \* programGroup.ts: isProcessGroupAlive reads
                            \*   EPERM (a process of another user) as alive
    HostWaitsForGroup,      \* hostMain.ts: handlePtyExit records destroyed
                            \*   only after the group reads gone
    ReconcileWaitsForGroup, \* lifecycle.ts: reconcileSession writes only
                            \*   after the group reads gone
    ReRunsInNewSession,     \* destroy.ts: a destroy inside the program's
                            \*   session runs again in a new session
    InsideCheckReadsEnv,    \* lifecycle.ts: that check matches
                            \*   AGENT_TTY_SESSION_ID before it reads the
                            \*   manifest
    RecordsProgramSync,     \* hostMain.ts: program.json is written in the
                            \*   synchronous block that spawns the program,
                            \*   with a token only beside host.json
    ProvesGroupOwnership,   \* programGroup.ts: every group kill goes
                            \*   through stopProgramGroup, which kills only
                            \*   while a live member carries the token
    DestroyStopsLeftovers,  \* lifecycle.ts: destroy of a terminal session
                            \*   kills the group that program.json proves
    FallbackNeedsFolder,    \* programGroup.ts: a group that only a childPid
                            \*   names gets the kill, and reads alive, only
                            \*   while the session folder exists
    ReconcileRepairsDestroyed, \* lifecycle.ts: recordDestroyed writes the
                            \*   destroy marker before destroyed, and a
                            \*   reconcile that finds it after its own write
                            \*   writes destroyed again
    ReconcileRepairsMarked, \* lifecycle.ts: a reconcile that reads a
                            \*   terminal manifest other than destroyed next
                            \*   to the destroy marker writes destroyed
    CreateStopsOnGiveUp,    \* create.ts: a create that gives up on its
                            \*   host sends it SIGTERM, so the host stops
                            \*   its program and ends the session
    HostChecksCreateFailed, \* create.ts, hostMain.ts: a create that gives
                            \*   up writes the create-failed marker before
                            \*   it reads the manifest, and the host checks
                            \*   for it before the spawn and right after its
                            \*   start-up write, and then ends the session
    HostPollsCreateFailed,  \* hostMain.ts: from its start-up check on, the
                            \*   host checks for the create-failed marker
                            \*   while its creator runs and once after, and
                            \*   then ends the session
    CreateRetriesMarker,    \* create.ts: on Windows, while the marker write
                            \*   fails and the manifest names no program,
                            \*   create writes the marker again and reads
                            \*   the manifest after each write, up to 50
                            \*   times, while the host runs
    ForceSkipsUnreadableGroup, \* lifecycle.ts: destroy --force of a session
                            \*   whose host is gone records destroyed also
                            \*   when the read of the group fails with a
                            \*   system error, after it stops the host alone
    TokenNamesProgram,      \* programGroup.ts: captureToken records an
                            \*   autogroup only once the program leads its
                            \*   own session in an autogroup other than the
                            \*   host's
    ReusedIdReadsGone,      \* programGroup.ts: isProgramGroupAlive reads a
                            \*   group gone when its live members carry
                            \*   another autogroup (unproven)
    CreateRecordsHost,      \* lifecycle.ts: allocateSession writes host.json
                            \*   for the launched host before the first
                            \*   manifest
    ProvesHostPid,          \* lifecycle.ts, hostRecord.ts: destroy --force
                            \*   kills the host only while its pid shows the
                            \*   boot id and start time that host.json holds
    WaitProbesUnseenGroup,  \* programGroup.ts: isProcessGroupAlive probes
                            \*   the group again when no scan shows a member,
                            \*   and reads it alive while the probe finds it
    FreezesUnseenGroup,     \* programGroup.ts: stopProgramGroup sends
                            \*   SIGSTOP to a group that no scan shows and
                            \*   judges it again
    UnsharedGroupReadsUnknown, \* programGroup.ts, lifecycle.ts: a group with
                            \*   a token that the caller cannot prove it
                            \*   shares the host's pid space with reads
                            \*   alive and gets no kill, and destroy trusts
                            \*   a destroyed record of such a session
    Token,                  \* the environment: the host's capture finds the
                            \*   program's session token
    Unseen,                 \* the environment: no scan of /proc shows a
                            \*   live process of the program, as for a fork
                            \*   chain whose processes each live about 2 ms
    FreezeMisses,           \* the environment: with Unseen, no freeze of
                            \*   stopProgramGroup brings a member into view,
                            \*   as when a SIGCONT from another process comes
                            \*   before each judgement
    ZombiesInView,          \* the environment: with Unseen, the scans show
                            \*   zombies of the program's group, as under a
                            \*   PID 1 that never reaps
    OtherPidSpace,          \* the environment: destroy, list and gc run
                            \*   where no scan and no probe shows the host's
                            \*   processes (no /proc, an empty /proc,
                            \*   another pid namespace or another machine),
                            \*   and host.json names the host's pid space
    Win32,                  \* the environment: Windows, where SIGTERM ends
                            \*   the host at once, so create sends it only
                            \*   when the manifest names the program
    CheckFails,             \* the environment: while program.json names
                            \*   the program, every read of it by destroy,
                            \*   list and gc fails with a system error (EACCES,
                            \*   or EIO on /proc), as does every judgement
    Refused,                \* the environment: /proc of destroy, list and gc
                            \*   refuses the autogroup of the program's
                            \*   processes, so no judgement proves the group
    MaxListReconciles       \* how many times the "list" process reconciles

ASSUME MaxListReconciles \in 1..3
ASSUME Token \in BOOLEAN
ASSUME Unseen \in BOOLEAN
ASSUME FreezeMisses \in BOOLEAN
ASSUME ZombiesInView \in BOOLEAN
ASSUME OtherPidSpace \in BOOLEAN
ASSUME Win32 \in BOOLEAN
ASSUME CheckFails \in BOOLEAN
ASSUME Refused \in BOOLEAN
ASSUME \A b \in {GcSkipsNonCollectable, GcFinalCheck, GcKeepsLiveGroup,
                 GcProbesUnseenGroup, GcFreezesUnseenGroup,
                 ReconcileSkipsTerminal,
                 ReconcileSkipsLiveHost, CreateRecordsHostPid,
                 HostWaitsForManifest, ReconcileRereads,
                 HostSerializesWrites, HostStopsAfterTerminalWrite,
                 ShutdownChecksCommandable,
                 DestroyRecordsDestroyed, DestroyKeepsExitCode,
                 ManifestWriteNeedsFolder, KillsProgramGroup,
                 ProbeCountsDeniedGroup, HostWaitsForGroup,
                 ReconcileWaitsForGroup, ReRunsInNewSession,
                 InsideCheckReadsEnv, RecordsProgramSync,
                 ProvesGroupOwnership, DestroyStopsLeftovers,
                 FallbackNeedsFolder, CreateStopsOnGiveUp,
                 HostChecksCreateFailed, HostPollsCreateFailed,
                 CreateRetriesMarker, ForceSkipsUnreadableGroup,
                 ReconcileRepairsDestroyed, ReconcileRepairsMarked,
                 TokenNamesProgram,
                 ReusedIdReadsGone, ProvesHostPid, CreateRecordsHost,
                 FreezesUnseenGroup, WaitProbesUnseenGroup,
                 UnsharedGroupReadsUnknown} : b \in BOOLEAN

Readers == {"gc", "list"}   \* the two processes that run reconcileSession
\* The group that a kill went through, and that the wait after it probes:
\* "proven" (program.json with a token), "numeric" (a childPid without a
\* token), "bare" (the host's own record without a token), "blind" (destroy
\* --force could not read the group, see ForceSkipsUnreadableGroup) or
\* "none".
GroupKinds == {"none", "proven", "numeric", "bare", "blind"}
NoRead == [pid |-> FALSE, origin |-> "none", code |-> FALSE, child |-> FALSE,
           grp |-> "none"]

VARIABLES
    dir,         \* the session directory exists
    mst,         \* manifest status on disk; "none" when there is no manifest
    mpid,        \* the manifest on disk records a hostPid
    morigin,     \* failureOrigin on disk: "none", "host-death", "unknown"
    mcode,       \* the manifest on disk records the program's exit code
    mchild,      \* the manifest on disk records the program's pid (childPid)
    wasTerminal, \* ghost: the manifest has shown a terminal status
    wasExited,   \* ghost: the manifest has shown "exited"
    wasNamed,    \* ghost: a manifest has recorded the program's pid
    dmark,       \* the destroy marker file exists in the session directory
    cmark,       \* the create-failed marker file exists in it
    rec,         \* program.json names the program with its token
    startFailed, \* ghost: the host died because its files were missing
    readRepaired, \* ghost: a reconcile wrote destroyed from its first read
    lostRepair,  \* ghost: a reconcile died between its write and its
                 \*   repair while the marker existed, and no reconcile has
                 \*   read the manifest since
    diedBeforeRepair, \* ghost: such a death happened
    polled,      \* ghost: the host's watch found the create-failed marker
                 \*   next to the destroy marker
    sock,        \* the RPC socket file exists (it is outside the directory)
    cpc,         \* create: "alloc", "write", "launch", "done", "giveup"
                 \*   (Windows: the marker is written, the manifest read
                 \*   is next), "retry" (Windows: the marker write failed
                 \*   and the manifest named no program, so the next
                 \*   write is due), "failed" (it gave up on its host),
                 \*   "exhausted" (Windows: it gave up after its last
                 \*   marker write failed too, see R17)
    hostAlive,   \* the detached host process is alive
    hpc,         \* host start-up path: "none", "boot", "open", "record"
                 \*   (the program runs, program.json is not written yet),
                 \*   "pidwrite", "markcheck" (the start-up write landed,
                 \*   the marker check is next), "sockdir", "serving",
                 \*   "idle", "dead"
    hex,         \* host exit path: "none", "wait" (the program runs),
                 \*   "groupwait" (the program ended during a destroy, and
                 \*   the host waits for its group), "exitwrite" (its exit
                 \*   write is queued), "giveup" (the wait gave up, and an
                 \*   exit write that keeps "destroying" is queued), "done",
                 \*   "gone"
    rsz,         \* one resize RPC: "none", "pending" (its write is in flight),
                 \*   "done"
    prog,        \* a process of the program's process group runs
    foreign,     \* a process of another user runs in that group, such as
                 \*   the root child of `sudo cmd &`. Our SIGKILL does not
                 \*   reach it.
    left,        \* a process that the program started still runs after the
                 \*   program exited on its own
    reused,      \* the program's group has ended, and its id now names an
                 \*   unrelated process group
    hitUnrelated, \* ghost: a kill reached that unrelated group
    diedUnrecorded, \* ghost: the host died after it started the program and
                 \*   before program.json named it
    passedReused, \* ghost: a wait of destroy through program.json read the
                 \*   group gone while an unrelated group held its id
    hrec,        \* host.json names the host with its boot id and start time
    hreused,     \* the host has ended, and its pid now names an unrelated
                 \*   process
    hitUnrelatedHost, \* ghost: a host kill reached that unrelated process
    hst,         \* the host's in-memory status (SessionState): "running",
                 \*   "destroying", "exited", "destroyed"
    hsd,         \* initiateShutdown: "none", "write" (its "destroying" write
                 \*   is queued), "wait" (it waits for the program and the
                 \*   listen), "closed" (rpcServer.close unlinked the socket)
    dsnap,       \* the snapshot that the queued "destroying" write took when
                 \*   its turn started; "none" while it waits for its turn
    hwt,         \* the host's writer has written a terminal record
    sig,         \* the host got its one SIGTERM
    pc,          \* pc["gc"] and pc["list"]; "r_record": reconcileSession
                 \*   reads program.json, "r_wait": it waits for the
                 \*   program's group, "r_repair": it checks the destroy
                 \*   marker after its write
    rd,          \* rd[p]: the manifest that reconcileSession read in process p
    gres,        \* what gc did: "pending", "skipped", "removed"
    lruns,       \* how many reconciles "list" has started
    dpc,         \* destroy: "check", "read", "tkill", "twait", "tmark",
                 \*   "twrite", "tunlink", "kill", "kwait", "reread", "rkill", "rwait",
                 \*   "rpc", "poll", "final", "done"
    dforce,      \* destroy runs with --force
    dinside,     \* destroy runs inside the program's session (a copy that
                 \*   rerunInNewSession started runs outside)
    drd,         \* the manifest copy that destroy writes "destroyed" from
    dres,        \* what destroy reported: "pending", "ok", "error", or
                 \*   "killed" (it died before it reported)
    dsaw,        \* ghost: destroy wrote "destroyed" or read it last
    dkill,       \* ghost: destroy --force killed a live host
    dblind       \* ghost: destroy --force wrote the destroy marker or
                 \*   destroyed without a read of the program's group
                 \*   (CheckFails); a reconcile then repairs to destroyed

diskVars == <<dir, mst, mpid, morigin, mcode, mchild, wasTerminal, wasExited,
              wasNamed, dmark, cmark>>
ghostVars == <<startFailed, readRepaired, lostRepair, diedBeforeRepair,
               polled>>
hostVars == <<hostAlive, hpc, hex, rsz, prog, foreign, left>>
groupVars == <<rec, reused, hitUnrelated, diedUnrecorded, passedReused,
               hrec, hreused, hitUnrelatedHost>>
shutVars == <<hst, hsd, dsnap, hwt, sig>>
readerVars == <<pc, rd, gres, lruns>>
destroyVars == <<dpc, dforce, dinside, drd, dres, dsaw, dkill, dblind>>
vars == <<diskVars, ghostVars, sock, cpc, hostVars, shutVars, readerVars,
          destroyVars, groupVars>>

Init ==
    /\ dir = FALSE /\ mst = "none" /\ mpid = FALSE /\ morigin = "none"
    /\ mcode = FALSE /\ mchild = FALSE
    /\ wasTerminal = FALSE /\ wasExited = FALSE /\ wasNamed = FALSE
    /\ dmark = FALSE /\ cmark = FALSE
    /\ rec = FALSE /\ startFailed = FALSE /\ readRepaired = FALSE
    /\ lostRepair = FALSE /\ diedBeforeRepair = FALSE /\ polled = FALSE
    /\ sock = FALSE
    /\ cpc = "alloc"
    /\ hostAlive = FALSE /\ hpc = "none" /\ hex = "none" /\ rsz = "none"
    /\ prog = FALSE /\ foreign = FALSE /\ left = FALSE
    /\ reused = FALSE /\ hitUnrelated = FALSE /\ diedUnrecorded = FALSE
    /\ passedReused = FALSE
    /\ hrec = FALSE /\ hreused = FALSE /\ hitUnrelatedHost = FALSE
    /\ hst = "running" /\ hsd = "none" /\ dsnap = "none" /\ hwt = FALSE
    /\ sig = FALSE
    /\ pc = [p \in Readers |-> IF p = "gc" THEN "stat" ELSE "idle"]
    /\ rd = [p \in Readers |->
              [st |-> "none", pid |-> FALSE, code |-> FALSE, child |-> FALSE,
               grp |-> "none"]]
    /\ gres = "pending"
    /\ lruns = 0
    /\ dpc = "check" /\ dforce \in BOOLEAN /\ dinside = FALSE
    /\ drd = NoRead /\ dres = "pending"
    /\ dsaw = FALSE /\ dkill = FALSE /\ dblind = FALSE

\* writeManifest in src/storage/manifests.ts: write a temp file in the session
\* directory and rename it over session.json. The rename is the visible step.
\* WriteLands: with ManifestWriteNeedsFolder there is no mkdir, so a write into
\* a removed directory throws SESSION_NOT_FOUND and creates nothing. Without
\* it, the write runs mkdir first and brings the directory back.
WriteLands == dir \/ ~ManifestWriteNeedsFolder

Write(s, pid, origin, code, child) ==
    /\ dir' = TRUE
    /\ mst' = s
    /\ mpid' = pid
    /\ morigin' = origin
    /\ mcode' = code
    /\ mchild' = child
    /\ wasTerminal' = (wasTerminal \/ s \in Terminal)
    /\ wasExited' = (wasExited \/ s = "exited")
    /\ wasNamed' = (wasNamed \/ child)
    /\ dmark' = dmark /\ cmark' = cmark

\* SIGKILL of the program's group ends every process of our user in it.
\* Without KillsProgramGroup the code kills only the program's pid, and a
\* process that the program started can still run.
KillsOurs ==
    /\ prog' \in IF KillsProgramGroup THEN {FALSE} ELSE {FALSE, prog}
    /\ left' = (left /\ ~KillsProgramGroup)
    /\ UNCHANGED hitUnrelated

\* A kill of the group id as it is. Once the program's group has ended and
\* an unrelated group took its id, the kill reaches that group.
KillsGroupId ==
    IF reused
    THEN /\ hitUnrelated' = TRUE /\ UNCHANGED <<prog, left>>
    ELSE KillsOurs

NoKill == UNCHANGED <<prog, left, hitUnrelated>>

\* stopProgramGroup through a record with a token: in one synchronous block
\* it reads the process table, finds a live member of the group whose
\* session id is the program's pid and whose autogroup and boot id are the
\* recorded ones, reads that member again, and kills the group. A group that
\* took the id later has another autogroup, so it gets no kill. When /proc
\* refuses the boot id or a member's autogroup, the code kills nothing
\* either. The model has no refused reads (see Scope). Without
\* ProvesGroupOwnership the code kills the id as it is. Without
\* TokenNamesProgram the capture can read the program's autogroup before the
\* program called setsid(), so the record holds the host's autogroup, which
\* no member of the group carries, and the kill never comes. With Unseen no
\* scan shows a process of the program, so unless a process of another user
\* in the group is the witness, the group reads gone and gets no kill.
\* FreezesUnseenGroup then sends the group SIGSTOP, which every member gets,
\* also one forked during the delivery, and a stopped member stays in view,
\* so the next judge finds the witness.
ProvenKill ==
    IF ~TokenNamesProgram THEN NoKill
    ELSE IF ProvesGroupOwnership /\ reused THEN NoKill
    ELSE IF Unseen /\ (~FreezesUnseenGroup \/ FreezeMisses) /\ ~reused
            /\ ~foreign THEN NoKill
    ELSE KillsGroupId

\* Without a token, readProgramGroup falls back to the childPid of the
\* manifest copy that the caller read before it, `named`. With
\* FallbackNeedsFolder, stopProgramGroup kills that id, and
\* isProgramGroupAlive probes it, only while the session folder exists: a
\* PR 2 session names its childPid only after program.json, so a missing
\* record in a folder that still exists marks a session that never had one.
FallbackReaches == dir \/ ~FallbackNeedsFolder

\* `const group = await readProgramGroup(...)` reads program.json, then
\* stopProgramGroup(group) runs in the same synchronous block: through the
\* record when it names the program with its token, else through `named`.
KillThrough(named) ==
    IF rec THEN ProvenKill
    ELSE IF named /\ FallbackReaches THEN KillsGroupId
    ELSE NoKill
KindThrough(named) ==
    IF rec THEN "proven" ELSE IF named THEN "numeric" ELSE "none"

\* stopProgramGroup(program) in the host, through its own record: with
\* Token as ProvenKill, else the kill of the program's pid as it is, with
\* no folder check.
HostKill == IF Token THEN ProvenKill ELSE KillsGroupId
HostKind == IF Token THEN "proven" ELSE "bare"

GroupAlive == prog \/ foreign

\* isProcessGroupAlive probes kill(-pgid, 0): every process with that group
\* id reads alive, also one of an unrelated group that took it. EPERM, when
\* every process left belongs to another user, reads alive only with
\* ProbeCountsDeniedGroup. When the probe finds the group, the scans after it
\* decide: with Unseen they show no process of the program, and with
\* WaitProbesUnseenGroup a second probe that still finds the group reads it
\* alive. Scans that show only zombies read the group ended either way.
ProbeFindsUnseen == WaitProbesUnseenGroup /\ ~ZombiesInView
ProbeSees ==
    \/ (prog \/ left) /\ (~Unseen \/ ProbeFindsUnseen)
    \/ reused \/ (ProbeCountsDeniedGroup /\ foreign)

\* isProgramGroupAlive in waitForProcessesToExit, for the group that the
\* kill before it went through. With a token it reads the group alive while
\* a live member carries the token, which a process of another user in the
\* program's session also does. The code also reads it alive while /proc
\* refuses the boot id or the autogroup of a member in the program's
\* session, which the model leaves out. Without a token it is the probe,
\* and for a childPid only while the folder exists. Without
\* KillsProgramGroup the wait probes only the program's pid, and every wait
\* comes after the program's kill or exit, so it reads gone. Without
\* TokenNamesProgram no member carries the recorded autogroup, so the group
\* reads gone. Without ReusedIdReadsGone a group that took the id reads
\* alive, because its members carry another autogroup. With Unseen the scans
\* show no process of the program, so the group reads gone, and the probe
\* after them decides (ProbeFindsUnseen). GroupJudged leaves out that probe
\* of a group with a token: gc judges such a group with its own probe
\* (GcSeesGroup).
GroupJudged(kind) ==
    /\ KillsProgramGroup
    /\ \/ kind = "proven" /\ TokenNamesProgram
          /\ (((prog \/ left) /\ ~Unseen) \/ foreign)
       \/ kind = "proven" /\ ~ReusedIdReadsGone /\ reused
       \/ kind = "bare" /\ ProbeSees
       \/ kind = "numeric" /\ FallbackReaches /\ ProbeSees

GroupSeen(kind) ==
    \/ GroupJudged(kind)
    \/ /\ KillsProgramGroup /\ kind = "proven"
       /\ Unseen /\ ProbeFindsUnseen /\ (prog \/ left)

\* The group as destroy and reconcile see it. With OtherPidSpace no scan and
\* no probe of theirs shows the program's processes: a group with a token
\* reads gone, and gets no kill, because no member is in view.
\* readProgramGroup gives no group without a token there, because
\* sharesHostPids reads host.json. With UnsharedGroupReadsUnknown,
\* readProgramGroup and readProvenProgramGroup give a group with a token
\* that reads alive instead, so their waits time out. The host always runs
\* in its own pid space, so it keeps GroupSeen and HostKill. CliHostAlive
\* gives the CLI's view of the host. With Refused a live member of the
\* program's session shows no autogroup, so a group with a token reads
\* unknown, which reads alive, while a process of it runs, and it gets no
\* kill, because nothing proves it.
CliGroupSeen(kind) ==
    IF OtherPidSpace
    THEN kind = "proven" /\ UnsharedGroupReadsUnknown
    ELSE IF Refused /\ kind = "proven"
    THEN KillsProgramGroup /\ (prog \/ left \/ foreign)
    ELSE GroupSeen(kind)
CliKillThrough(named) ==
    IF OtherPidSpace \/ (Refused /\ rec) THEN NoKill ELSE KillThrough(named)

\* With CheckFails every read of program.json by destroy, list and gc fails
\* while the record exists, and so does every judgement of the group that
\* it names.
Unreadable == CheckFails /\ rec

\* The host fails to start because its files are missing or were rewritten.
HostFailsToStart ==
    /\ startFailed' = TRUE
    /\ readRepaired' = readRepaired
    /\ lostRepair' = lostRepair /\ diedBeforeRepair' = diedBeforeRepair
    /\ polled' = polled
    /\ hostAlive' = FALSE
    /\ hpc' = "dead"
    /\ hex' = IF hex = "none" THEN "none" ELSE "gone"
    /\ rsz' = rsz
    /\ diedUnrecorded' = (diedUnrecorded \/ hpc = "record")

\* The host process ends abnormally. Its exit path ends with it.
HostDies ==
    /\ hostAlive' = FALSE
    /\ hpc' = "dead"
    /\ hex' = IF hex = "none" THEN "none" ELSE "gone"
    /\ rsz' = IF rsz = "pending" THEN "done" ELSE rsz
    /\ diedUnrecorded' = (diedUnrecorded \/ hpc = "record")

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
    /\ UNCHANGED <<mst, mpid, morigin, mcode, mchild, wasTerminal, wasExited,
                   wasNamed, dmark, cmark, ghostVars, sock, hostVars,
                   shutVars, readerVars, destroyVars, groupVars>>

\* allocateSession: writeManifest with status "running". gc skips a directory
\* without a manifest, so this write always finds its directory (TypeOK
\* checks that).
CreateWritesManifest ==
    /\ cpc = "write"
    /\ Write("running", CreateRecordsHostPid, "none", FALSE, FALSE)
    /\ cpc' = IF CreateRecordsHostPid THEN "done" ELSE "launch"
    /\ UNCHANGED <<ghostVars, sock, hostVars, shutVars, readerVars,
                   destroyVars, groupVars>>

\* launchHost spawns the detached `_host` process. With CreateRecordsHost,
\* captureHost reads the new host in the same synchronous block, and
\* writeHostRecord writes host.json, which fails once gc removed the folder.
\* The model leaves out a capture that fails (no /proc, or off Linux), after
\* which only the host writes the record.
CreateLaunchesHost ==
    /\ cpc = "launch"
    /\ hostAlive' = TRUE
    /\ hpc' = "boot"
    /\ cpc' = IF CreateRecordsHostPid THEN "write" ELSE "done"
    /\ hrec' = (CreateRecordsHost /\ dir)
    /\ UNCHANGED <<diskVars, ghostVars, sock, hex, rsz, prog, foreign, left,
                   shutVars, readerVars, destroyVars, rec, reused,
                   hitUnrelated, diedUnrecorded, passedReused, hreused,
                   hitUnrelatedHost>>

\* runCreateCommand's readiness loop gives up after 50 inspect RPCs that
\* fail, which the model lets happen at any step after the start-up, since
\* it has no clock. With HostChecksCreateFailed, create first writes the
\* create-failed marker, an empty file written with no mkdir, so the write
\* fails when gc removed the directory, and create goes on. Then it reads
\* the manifest. With CreateStopsOnGiveUp, create sends its host SIGTERM
\* and reports the error. HostGetsSigterm takes that SIGTERM as the host's
\* one SIGTERM, and HostCrashes covers one that ends a host before it spawns
\* the program. create writes nothing else: without a token only the host
\* knows which group is the program's. Without the guard, create only
\* reports the error. On Linux and macOS the manifest read changes nothing,
\* so the model joins the marker write, the read and the SIGTERM. The
\* marker write can also fail for a reason of its own, such as an antivirus
\* lock on its temp file. Off Windows the SIGTERM then still stops the host.
CreateGivesUp ==
    /\ cpc = "done"
    /\ \E written \in BOOLEAN :
          cmark' = (cmark \/ (HostChecksCreateFailed /\ dir /\ written))
    /\ cpc' = IF Win32 THEN "giveup" ELSE "failed"
    /\ UNCHANGED <<dir, mst, mpid, morigin, mcode, mchild, wasTerminal,
                   wasExited, wasNamed, dmark, ghostVars, sock, hostVars,
                   shutVars, readerVars, destroyVars, groupVars>>

\* On Windows, create's SIGTERM to a host that the manifest names.
CreateStopsNamedHost(readOk) ==
    IF CreateStopsOnGiveUp /\ readOk /\ mchild /\ hostAlive
       THEN /\ HostDies
            /\ UNCHANGED <<prog, foreign, left, rec, reused, hitUnrelated,
                           hrec, hreused, hitUnrelatedHost, passedReused>>
       ELSE UNCHANGED <<hostVars, groupVars>>

\* On Windows the SIGTERM ends the host at once, without its handlers, so
\* create sends it only when the manifest that it reads after the marker
\* write names the program. The next reconcile then records failed and ends
\* the program. That read can fail, for example when the file is not
\* readable, and then create sends nothing. With CreateRetriesMarker, a
\* create whose marker write failed and whose read named no program writes
\* the marker again while the host runs.
CreateStopsHostOnWindows ==
    /\ cpc = "giveup"
    /\ \E readOk \in BOOLEAN :
       IF CreateRetriesMarker /\ HostChecksCreateFailed /\ ~cmark
          /\ ~(readOk /\ mchild) /\ hostAlive
          THEN /\ cpc' = "retry"
               /\ UNCHANGED <<hostVars, groupVars>>
          ELSE /\ cpc' = "failed"
               /\ CreateStopsNamedHost(readOk)
    /\ UNCHANGED <<diskVars, ghostVars, sock, shutVars, readerVars,
                   destroyVars>>

\* One more marker write, 100 ms after the last one, then a manifest read.
\* create goes on while the write fails, the read names no program and the
\* host runs. The model has no clock, so after any write that failed it can
\* also stop as if its 50th write had failed ("exhausted"). Then the host
\* that the manifest does not name yet sees no marker and serves the
\* session. The SKILL.md Scope section states this residual.
CreateRewritesMarker ==
    /\ cpc = "retry"
    /\ \E written \in BOOLEAN, readOk \in BOOLEAN, more \in BOOLEAN :
       /\ cmark' = (cmark \/ (dir /\ written))
       /\ IF ~(dir /\ written) /\ ~(readOk /\ mchild) /\ hostAlive
             THEN /\ cpc' = IF more THEN "retry" ELSE "exhausted"
                  /\ UNCHANGED <<hostVars, groupVars>>
             ELSE /\ cpc' = "failed"
                  /\ CreateStopsNamedHost(readOk)
    /\ UNCHANGED <<dir, mst, mpid, morigin, mcode, mchild, wasTerminal,
                   wasExited, wasNamed, dmark, ghostVars, sock, shutVars,
                   readerVars, destroyVars>>

\* -------------------------------------------------------------------------
\* The host's serial manifest writer (createSerialManifestWriter). Each write
\* takes its snapshot of the in-memory state when its turn starts, which is
\* right after the write before it lands, or at the call when no write is
\* queued. Only the "destroying" write of initiateShutdown can wait for its
\* turn while the state changes, so only it keeps its snapshot in a variable.
\* The other writes carry a status that cannot change before their turn.

WriteQueued ==
    hpc = "pidwrite" \/ rsz = "pending" \/ hex \in {"exitwrite", "giveup"}

\* Reachable only without ShutdownChecksCommandable: destroy requested after
\* the program ended.
ExitWriteAheadOfDestroying == hex = "exitwrite" /\ hst = "destroying"

\* The program ended during a destroy, so the "destroying" write was queued
\* before the exit write.
DestroyingWriteAheadOfExit ==
    hsd = "write" /\ (hst = "destroyed" \/ hex = "giveup")

WriterStopped == HostSerializesWrites /\ HostStopsAfterTerminalWrite /\ hwt

\* A host write lands, or writes nothing once the writer has stopped. The
\* record carries the exit code once recordExit or recordDestroyed ran, and
\* the program's pid, which setChildPid records before the first host write.
\* WriteLands is false here only in a state that already breaks R1.
HostWrite(s, code) ==
    IF WriterStopped
    THEN UNCHANGED <<diskVars, hwt>>
    ELSE /\ WriteLands
         /\ Write(s, TRUE, "none", code, TRUE)
         /\ hwt' = (hwt \/ s \in Terminal)

\* A write lands. When the queued "destroying" write is next, its turn starts
\* in the same microtask chain and it takes its snapshot.
NextTurn(stillAhead) ==
    IF hsd = "write" /\ dsnap = "none" /\ ~stillAhead THEN hst ELSE dsnap

\* initiateShutdown up to its first await: abort, clearIdleTimeout, and
\* `if (isSessionCommandable(state))` hangUpProgram() (pty.kill() and the
\* kill timer), state.requestDestroy() and persistManifest(). It runs once;
\* a later call returns the same promise.
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
\* throws, and the host exits. Right after the read, with no await between,
\* the host writes host.json with writeHostRecord: its pid, the boot id and
\* its start time from /proc/self/stat. The model leaves out a capture that
\* fails (a refused read of the stat, the boot id or the pid namespace),
\* after which the host writes no host.json and records no token
\* (RecordsProgramSync).
HostReadsManifest ==
    /\ hostAlive /\ hpc = "boot"
    /\ ~(HostWaitsForManifest /\ mst = "none")
    /\ IF mst = "running"
          THEN /\ hpc' = "open" /\ hrec' = TRUE
               /\ UNCHANGED <<hostAlive, hex, rsz, ghostVars, diedUnrecorded,
                              passedReused>>
          ELSE HostFailsToStart /\ UNCHANGED hrec
    /\ UNCHANGED <<diskVars, sock, cpc, prog, foreign, left, rec, reused,
                   hitUnrelated, hreused, hitUnrelatedHost, shutVars,
                   readerVars, destroyVars, passedReused>>

\* EventLog.open(events.jsonl, 'a') throws when the directory is gone. From
\* there to `await persistManifest()` near the end of runHost the code is
\* synchronous: createPty spawns the program, setChildPid records its pid in
\* memory, captureProgram reads its session token, process.on('SIGTERM')
\* registers the handler, writeProgramRecord renames program.json into
\* place (HostRecordsProgram), and the manifest write starts with status
\* "running" and both pids. The program runs from the spawn on, so a host
\* death before the record leaves a program that no file names. No event
\* handler of the host runs inside this block.
HostOpensLogAndSpawns ==
    /\ hostAlive /\ hpc = "open"
    /\ IF ~dir
          THEN HostFailsToStart /\ UNCHANGED prog
       ELSE IF HostChecksCreateFailed /\ cmark
          THEN HostDies /\ UNCHANGED <<prog, ghostVars, passedReused>>
       ELSE /\ hpc' = IF RecordsProgramSync THEN "record" ELSE "pidwrite"
            /\ hex' = "wait" /\ prog' = TRUE
            /\ UNCHANGED <<hostAlive, rsz, ghostVars, diedUnrecorded,
                           passedReused>>
    /\ UNCHANGED <<diskVars, sock, cpc, foreign, left, rec, reused,
                   hitUnrelated, hrec, hreused, hitUnrelatedHost, shutVars,
                   readerVars, destroyVars, passedReused>>

\* writeProgramRecord(sessDir, program), the first statement of runHost's
\* last try: a temp file and renameSync, with no mkdir, so it throws when gc
\* removed the folder, which only a state that already breaks R1 reaches.
\* Without Token the record holds no token, which reads as no record.
HostRecordsProgram ==
    /\ hostAlive /\ hpc = "record"
    /\ IF dir
          THEN /\ rec' = Token /\ hpc' = "pidwrite"
               /\ UNCHANGED <<hostAlive, hex, rsz, ghostVars, diedUnrecorded,
                              passedReused>>
          ELSE HostFailsToStart /\ UNCHANGED rec
    /\ UNCHANGED <<diskVars, sock, cpc, prog, foreign, left, reused,
                   hitUnrelated, hrec, hreused, hitUnrelatedHost, shutVars,
                   readerVars, destroyVars, passedReused>>

\* The start-up write lands. It is the host's in-memory record, so it
\* replaces whatever another process wrote after the host read the manifest.
\* Without RecordsProgramSync, program.json is written right after this
\* write lands, in the same step.
HostWritesPids ==
    /\ hostAlive /\ hpc = "pidwrite"
    /\ HostWrite("running", FALSE)
    /\ hpc' = IF HostChecksCreateFailed THEN "markcheck" ELSE "sockdir"
    /\ dsnap' = NextTurn(ExitWriteAheadOfDestroying)
    /\ rec' = (rec \/ (Token /\ ~RecordsProgramSync /\ dir))
    /\ UNCHANGED <<ghostVars, sock, cpc, hostAlive, hex, rsz, prog, foreign,
                   left, reused, hitUnrelated, diedUnrecorded, hrec, hreused,
                   hitUnrelatedHost, hst, hsd, sig, readerVars, destroyVars,
                   passedReused>>

\* Right after the start-up write lands, the host checks for the
\* create-failed marker and shuts down when it finds it, as for a SIGTERM.
HostChecksMarker ==
    /\ hostAlive /\ hpc = "markcheck"
    /\ IF cmark
          THEN /\ hpc' = "idle" /\ StartShutdown(WriteQueued)
          ELSE /\ hpc' = "sockdir" /\ UNCHANGED <<hst, hsd, dsnap>>
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostAlive, hex, rsz, prog,
                   foreign, left, hwt, sig, readerVars, destroyVars,
                   groupVars>>

\* `if (!isSessionCommandable(state))` initiateShutdown, else mkdir and
\* chmod of the socket directory and rpcServer.listen(), which the host
\* repeats when another session's destroy removed that directory.
HostListens ==
    /\ hostAlive /\ hpc = "sockdir"
    /\ IF hst = "running"
          THEN /\ sock' = TRUE /\ hpc' = "serving"
               /\ UNCHANGED <<hst, hsd, dsnap>>
          ELSE /\ hpc' = "idle" /\ UNCHANGED sock
               /\ StartShutdown(WriteQueued)
    /\ UNCHANGED <<diskVars, ghostVars, cpc, hostAlive, hex, rsz, prog,
                   foreign, left, hwt, sig, readerVars, destroyVars,
                   groupVars>>

\* The resize handler: assertSessionCommandable, setDimensions in memory,
\* then writeManifest with status "running". No write is queued then, so the
\* snapshot is taken at once.
HostStartsResize ==
    /\ hostAlive /\ hpc = "serving" /\ hst = "running" /\ rsz = "none"
    /\ rsz' = "pending"
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostAlive, hpc, hex, prog,
                   foreign, left, shutVars, readerVars, destroyVars,
                   groupVars>>

HostResizeWriteLands ==
    /\ hostAlive /\ rsz = "pending"
    /\ HostWrite("running", FALSE)
    /\ rsz' = "done"
    /\ dsnap' = NextTurn(ExitWriteAheadOfDestroying)
    /\ UNCHANGED <<ghostVars, sock, cpc, hostAlive, hpc, hex, prog, foreign,
                   left, hst, hsd, sig, readerVars, destroyVars, groupVars>>

\* -------------------------------------------------------------------------
\* host shutdown: the destroy handler, the SIGTERM handler, initiateShutdown

\* runHost registers its SIGTERM handler before it waits for the manifest.
\* A SIGTERM before the spawn makes the host return before it spawns, which
\* HostCrashes covers at "boot" and "open". From the spawn on the handler
\* calls startShutdown, and it runs only after the synchronous start-up
\* block.
HostGetsSigterm ==
    /\ ~Win32
    /\ hostAlive /\ ~sig
    /\ hpc \in {"pidwrite", "markcheck", "sockdir", "serving", "idle"}
    /\ sig' = TRUE
    /\ StartShutdown(WriteQueued)
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, hwt, readerVars,
                   destroyVars, groupVars>>

\* watchCreateFailed: from right after the start-up check on, the host
\* checks for the create-failed marker every 100 ms while its creator runs,
\* and once after the creator exited. create writes the marker before it
\* exits, so the watch finds every marker. On the marker it calls
\* startShutdown, as for a SIGTERM.
HostPollsMarker ==
    /\ HostPollsCreateFailed
    /\ hostAlive /\ cmark /\ hsd = "none"
    /\ hpc \in {"sockdir", "serving"}
    /\ polled' = TRUE
    /\ StartShutdown(WriteQueued)
    /\ UNCHANGED <<diskVars, startFailed, readRepaired, lostRepair,
                   diedBeforeRepair, sock, cpc, hostVars, hwt, sig,
                   readerVars, destroyVars, groupVars>>

\* initiateShutdown's `await persistManifest()` lands, then its finally block
\* starts.
HostWritesDestroying ==
    /\ hostAlive /\ hsd = "write" /\ dsnap # "none"
    /\ HostWrite(dsnap, dsnap = "destroyed")
    /\ hsd' = "wait" /\ dsnap' = "none"
    /\ UNCHANGED <<ghostVars, sock, cpc, hostVars, hst, sig, readerVars,
                   destroyVars, groupVars>>

\* The finally block of initiateShutdown: await ptyExitPromise (the program
\* ended; handlePtyExit settles it before its wait for the group), await
\* rpcListenPromise, eventLog.close, the dispose of both renderer managers,
\* then rpcServer.close, which unlinks the socket file also when the server
\* never listened.
HostClosesSocket ==
    /\ hostAlive /\ hsd = "wait"
    /\ hex \in {"groupwait", "exitwrite", "giveup", "done"}
    /\ sock' = FALSE /\ hsd' = "closed"
    /\ UNCHANGED <<diskVars, ghostVars, cpc, hostVars, hst, dsnap, hwt, sig,
                   readerVars, destroyVars, groupVars>>

\* The kill timer of hangUpProgram fires: SHUTDOWN_KILL_GRACE_MS after
\* pty.kill(), stopProgramGroup(program), whose kill ignores ESRCH and
\* EPERM. handlePtyExit clears it, so it fires only before the host
\* handles the exit. It can fire after the program ended and before
\* handlePtyExit runs; the kill then reaches the group's other processes or
\* finds none. The host then sees the exit (ProgramExits). The rules do not
\* depend on this kill, because handlePtyExit kills the group too. It makes
\* destroy end within its wait, a time bound that the model does not check.
\* The idle time-out arms the same timer while the status is "running", and
\* handlePtyExit then kills the group too, because the timer was armed. The
\* model leaves both kills out: they go through stopProgramGroup like every
\* kill, and a process that outlives them is one that the program left
\* (`left`), which the normal exit (ProgramExits) can keep anyway.
HostKillsProgram ==
    /\ hostAlive /\ hst = "destroying" /\ hex = "wait" /\ prog
    /\ prog' = FALSE
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostAlive, hpc, hex, rsz,
                   foreign, left, shutVars, readerVars, destroyVars,
                   groupVars>>

\* -------------------------------------------------------------------------
\* host exit path (pty.onExit -> handlePtyExit)

\* The program ends: on its own, by a signal, or by hangUpProgram (pty.kill
\* and the kill timer), which the idle time-out and initiateShutdown call.
\* handlePtyExit: clearTimeout(groupKillTimer), then when the status is
\* "destroying" stopProgramGroup(program), else recordExit (in memory),
\* after the same kill when the idle time-out armed the timer,
\* markPtyExited, and the 'exit' event append; no other process can
\* see this step. The kill goes through the host's own record of the
\* program (HostKill), and node-pty has reaped the program before this
\* runs, so its group can have ended and its id can name another group by
\* now. Without
\* HostWaitsForGroup the host records destroyed right after the kill and
\* queues its exit write, as the code did before the wait. A program that
\* exits on its own can leave a process that it started running in its
\* group (`left`), unless a kill ended the group first. The model drops one
\* of another user.
ProgramExits ==
    /\ hostAlive /\ hex = "wait"
    /\ RecordsProgramSync => hpc # "record"
    /\ IF hst = "destroying"
          THEN /\ HostKill
               /\ UNCHANGED foreign
               /\ IF HostWaitsForGroup
                     THEN hex' = "groupwait" /\ UNCHANGED hst
                     ELSE hex' = "exitwrite" /\ hst' = "destroyed"
          ELSE /\ hex' = "exitwrite" /\ hst' = "exited"
               /\ prog' = FALSE /\ foreign' = FALSE /\ left' \in {FALSE, prog}
               /\ UNCHANGED hitUnrelated
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostAlive, hpc, rsz, hsd,
                   dsnap, hwt, sig, readerVars, destroyVars, rec, reused,
                   diedUnrecorded, hrec, hreused, hitUnrelatedHost,
                   passedReused>>

\* With HostWaitsForGroup, the async block of handlePtyExit:
\* `if (currentStatus === 'destroying' && (await waitForProcessesToExit(null,
\* program))) state.recordDestroyed(...)`, then persistManifest. The wait
\* polls isProgramGroupAlive until it reads false, or gives up after about
\* 5 seconds; then persistManifest writes the record as it is, "destroying"
\* with no exit code, and a later reconcile retries the kill. The model lets
\* the wait give up at any poll that reads the group alive.
HostPollsGroup ==
    /\ hostAlive /\ hex = "groupwait"
    /\ IF GroupSeen(HostKind)
          THEN hex' = "giveup" /\ UNCHANGED hst
          ELSE hex' = "exitwrite" /\ hst' = "destroyed"
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostAlive, hpc, rsz, prog,
                   foreign, left, hsd, dsnap, hwt, sig, readerVars, destroyVars,
                   groupVars>>

\* handlePtyExit's persistManifest lands: "exited" or "destroyed" with the
\* exit code, or "destroying" without it when the wait gave up. In the code
\* nothing changes the status after recordExit or recordDestroyed, so the
\* write carries hst. Then `finally { await initiateShutdown() }`.
HostWritesExit ==
    /\ hostAlive /\ hex \in {"exitwrite", "giveup"}
    /\ HostSerializesWrites =>
          (hpc # "pidwrite" /\ rsz # "pending" /\ ~DestroyingWriteAheadOfExit)
    /\ HostWrite(hst, hex = "exitwrite")
    /\ hex' = "done"
    /\ IF hsd = "none"
          THEN StartShutdown(FALSE)
          ELSE /\ dsnap' = NextTurn(FALSE) /\ UNCHANGED <<hst, hsd>>
    /\ UNCHANGED <<ghostVars, sock, cpc, hostAlive, hpc, rsz, prog, foreign,
                   left, sig, readerVars, destroyVars, groupVars>>

\* runHost has returned and every handle is closed, so the `_host` process
\* exits.
HostProcessEnds ==
    /\ hostAlive /\ hsd = "closed" /\ hex = "done"
    /\ hpc \in {"serving", "idle"} /\ rsz # "pending"
    /\ hostAlive' = FALSE
    /\ hpc' = "dead"
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hex, rsz, prog, foreign,
                   left, shutVars, readerVars, destroyVars, groupVars>>

\* SIGKILL, OOM, or an uncaught error, at any point. The socket file stays.
\* The program can outlive the host: the closed PTY sends it SIGHUP, which a
\* program can ignore. The model keeps it running, the worst case.
HostCrashes ==
    /\ hostAlive
    /\ HostDies
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, prog, foreign, left,
                   shutVars, readerVars, destroyVars, rec, reused,
                   hitUnrelated, hrec, hreused, hitUnrelatedHost,
                   passedReused>>

\* A process of the program starts a process of another user in its group,
\* such as `sudo cmd &`, whose child runs as root.
ForeignStarts ==
    /\ prog /\ ~foreign
    /\ foreign' = TRUE
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostAlive, hpc, hex, rsz,
                   prog, left, shutVars, readerVars, destroyVars, groupVars>>

\* That process ends on its own, at any time.
ForeignEnds ==
    /\ foreign
    /\ foreign' = FALSE
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostAlive, hpc, hex, rsz,
                   prog, left, shutVars, readerVars, destroyVars, groupVars>>

\* A process that the program left ends on its own, at any time.
LeftoverEnds ==
    /\ left
    /\ left' = FALSE
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostAlive, hpc, hex, rsz,
                   prog, foreign, shutVars, readerVars, destroyVars,
                   groupVars>>

\* The environment: once every process of the program's group has ended,
\* the kernel can give its id to a new process that leads a new, unrelated
\* group. Nothing ends that group in the model.
GroupIdReused ==
    /\ hex # "none" /\ ~prog /\ ~foreign /\ ~left /\ ~reused
    /\ reused' = TRUE
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, shutVars,
                   readerVars, destroyVars, rec, hitUnrelated,
                   diedUnrecorded, hrec, hreused, hitUnrelatedHost,
                   passedReused>>

\* The environment: once the host has ended, the kernel can give its pid to
\* a new, unrelated process, which has another start time. Nothing ends
\* that process in the model.
HostPidReused ==
    /\ hpc # "none" /\ ~hostAlive /\ ~hreused
    /\ hreused' = TRUE
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, shutVars,
                   readerVars, destroyVars, rec, reused, hitUnrelated,
                   diedUnrecorded, hrec, hitUnrelatedHost, passedReused>>

\* -------------------------------------------------------------------------
\* reconcileSession, run by process p

AfterReconcile(p) == IF p = "gc" THEN "readafter" ELSE "idle"

\* isHostAlive as destroy, list and gc see it. In another pid space,
\* judgeHost reads a host that host.json names as unknown, which reads alive
\* also after the host ended. Before host.json exists it probes the pid in
\* its own pid space, where no process has it, and reads the host dead.
CliHostAlive == IF OtherPidSpace THEN hrec ELSE hostAlive

\* `if (manifest.hostPid !== null && hostAlive) return`, where hostAlive is
\* isHostAlive(manifest.hostPid). A null hostPid reads as a dead host.
SkipsHost(read) == ReconcileSkipsLiveHost /\ read.pid /\ CliHostAlive

\* readManifestIfExists. With ReconcileRepairsMarked, a terminal manifest
\* other than destroyed next to the destroy marker (isMarkedDestroyed) goes
\* to the repair write from this copy ("r_marked"). Otherwise it returns when
\* the manifest is null or terminal. A reconcile that died before its
\* repair left its failed record, and this read is the next chance to
\* repair it.
ReconcileReads(p) ==
    /\ pc[p] = "r_read"
    /\ lostRepair' = FALSE /\ diedBeforeRepair' = diedBeforeRepair
    /\ polled' = polled
    /\ IF ReconcileRepairsMarked /\ dmark /\ mst \in Terminal
          /\ mst # "destroyed"
          THEN /\ pc' = [pc EXCEPT ![p] = "r_marked"]
               /\ rd' = [rd EXCEPT ![p] = [st |-> mst, pid |-> mpid,
                                           code |-> mcode, child |-> mchild,
                                           grp |-> "none"]]
               /\ UNCHANGED <<diskVars, readRepaired>>
       ELSE IF mst = "none" \/ (ReconcileSkipsTerminal /\ mst \in Terminal)
          THEN /\ pc' = [pc EXCEPT ![p] = AfterReconcile(p)]
               /\ UNCHANGED <<rd, diskVars, readRepaired>>
          ELSE /\ pc' = [pc EXCEPT ![p] = "r_check"]
               /\ rd' = [rd EXCEPT ![p] = [st |-> mst, pid |-> mpid,
                                           code |-> mcode, child |-> mchild,
                                           grp |-> "none"]]
               /\ UNCHANGED <<diskVars, readRepaired>>
    /\ UNCHANGED <<startFailed, sock, cpc, hostVars, shutVars, gres, lruns,
                   destroyVars, groupVars>>

\* After its group kill, reconcileSession waits for the group, or, without
\* ReconcileWaitsForGroup, writes at once.
AfterGroupKill == IF ReconcileWaitsForGroup THEN "r_wait" ELSE "r_write"

\* One synchronous block: isProcessAlive(hostPid) and the pid check. The
\* code kills the program after its re-read. Without ReconcileRereads it
\* kills the program that the first copy names, here.
ReconcileChecksHost(p) ==
    /\ pc[p] = "r_check"
    /\ pc' = [pc EXCEPT ![p] =
                IF SkipsHost(rd[p]) THEN AfterReconcile(p)
                ELSE IF ReconcileRereads THEN "r_reread"
                ELSE AfterGroupKill]
    /\ IF SkipsHost(rd[p]) \/ ReconcileRereads
          THEN NoKill /\ UNCHANGED rd
          ELSE /\ CliKillThrough(rd[p].child)
               /\ rd' = [rd EXCEPT ![p].grp = KindThrough(rd[p].child)]
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostAlive, hpc, hex, rsz,
                   foreign, shutVars, gres, lruns, destroyVars, rec, reused,
                   diedUnrecorded, hrec, hreused, hitUnrelatedHost,
                   passedReused>>

\* With ReconcileRereads: `current = readManifestIfExists`, taken after the
\* host was found dead, so no host write can follow it; return when it is
\* null or terminal, else read the program's group and reconcile from this
\* copy.
ReconcileRereadsManifest(p) ==
    /\ pc[p] = "r_reread"
    /\ IF mst = "none" \/ mst \in Terminal
          THEN /\ pc' = [pc EXCEPT ![p] = AfterReconcile(p)]
               /\ UNCHANGED rd
          ELSE /\ pc' = [pc EXCEPT ![p] = "r_record"]
               /\ rd' = [rd EXCEPT ![p] = [st |-> mst, pid |-> mpid,
                                           code |-> mcode, child |-> mchild,
                                           grp |-> "none"]]
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, shutVars, gres,
                   lruns, destroyVars, groupVars>>

\* `const group = await readProgramGroup(sessionDirectory,
\* current.childPid)` reads program.json, then stopProgramGroup(group).
\* With Unreadable the read throws, and so does reconcileSession: gc skips
\* the session ("failed to reconcile session (destroy --force removes it)"),
\* and list goes on.
ReconcileReadsRecord(p) ==
    /\ pc[p] = "r_record"
    /\ IF Unreadable
          THEN /\ NoKill /\ UNCHANGED rd
               /\ pc' = [pc EXCEPT ![p] = IF p = "gc" THEN "done"
                                          ELSE AfterReconcile(p)]
               /\ gres' = IF p = "gc" THEN "skipped" ELSE gres
          ELSE /\ CliKillThrough(rd[p].child)
               /\ rd' = [rd EXCEPT ![p].grp = KindThrough(rd[p].child)]
               /\ pc' = [pc EXCEPT ![p] = AfterGroupKill]
               /\ UNCHANGED gres
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostAlive, hpc, hex, rsz,
                   foreign, shutVars, lruns, destroyVars, rec, reused,
                   diedUnrecorded, hrec, hreused, hitUnrelatedHost,
                   passedReused>>

\* With ReconcileWaitsForGroup: `if (!(await waitForProcessesToExit(null,
\* group))) return`. The wait polls isProgramGroupAlive until it
\* reads false, or gives up after about 5 seconds; reconcileSession then
\* returns with no write, and childPid stays for a later reconcile. The
\* model lets the wait give up at any poll that reads the group alive.
\* After the wait the code reads the manifest again (`latest`), returns
\* when it is null or terminal, and builds its record from that copy. The
\* model leaves that read out and writes from rd[p]. The host is dead, so
\* only a terminal write or gc's rm can land after the re-read, and the
\* code's read only turns the write over it into a return. A write that
\* lands between that read and the write is still overwritten, as here;
\* with ReconcileRepairsDestroyed, ReconcileRepairs then restores destroyed.
ReconcilePollsGroup(p) ==
    /\ pc[p] = "r_wait"
    /\ pc' = [pc EXCEPT ![p] = IF CliGroupSeen(rd[p].grp)
                               THEN AfterReconcile(p) ELSE "r_write"]
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, shutVars, rd, gres,
                   lruns, destroyVars, groupVars>>

\* writeManifest(reconciledManifest): "running" becomes failed/host-death,
\* "destroying" becomes destroyed, any other status that gets here becomes
\* failed/unknown (the default branch). hostPid and childPid become null.
\* When the directory is gone, the write throws SESSION_NOT_FOUND and
\* reconcileSession returns.
ReconcileWrites(p) ==
    /\ pc[p] = "r_write"
    /\ IF WriteLands
          THEN /\ CASE rd[p].st = "running" ->
                         Write("failed", FALSE, "host-death", rd[p].code, FALSE)
                    [] rd[p].st = "destroying" ->
                         Write("destroyed", FALSE, "none", rd[p].code, FALSE)
                    [] OTHER ->
                         Write("failed", FALSE, "unknown", rd[p].code, FALSE)
               /\ pc' = [pc EXCEPT ![p] = IF ReconcileRepairsDestroyed
                                          THEN "r_repair" ELSE "r_unlink"]
          ELSE /\ pc' = [pc EXCEPT ![p] = AfterReconcile(p)]
               /\ UNCHANGED diskVars
    /\ UNCHANGED <<ghostVars, sock, cpc, hostVars, shutVars, rd, gres, lruns,
                   destroyVars, groupVars>>

\* With ReconcileRepairsDestroyed, in the same try as the write:
\* `existsSync(destroyMarkerPath(sessionDirectory))`, and when the marker is
\* there and the write was not destroyed, writeManifest of destroyed from
\* the same copy, with hostPid and childPid null and no failure. Only a
\* destroy writes the marker, right before its destroyed write, so the write
\* above landed after the marker and may have replaced that record. gc's rm
\* takes the marker with the directory, and then nothing is written.
ReconcileRepairs(p) ==
    /\ pc[p] = "r_repair"
    /\ IF dmark /\ rd[p].st # "destroying"
          THEN Write("destroyed", FALSE, "none", rd[p].code, FALSE)
          ELSE UNCHANGED diskVars
    /\ pc' = [pc EXCEPT ![p] = "r_unlink"]
    /\ UNCHANGED <<ghostVars, sock, cpc, hostVars, shutVars, rd, gres, lruns,
                   destroyVars, groupVars>>

\* writeMarkedDestroyed: writeManifest destroyed from the copy that the read
\* took, with hostPid and childPid null and the exit code kept. When gc
\* removed the folder in the meantime, the write throws SESSION_NOT_FOUND,
\* and reconcile returns. Otherwise it unlinks the socket and returns.
ReconcileWritesMarked(p) ==
    /\ pc[p] = "r_marked"
    /\ IF WriteLands
          THEN /\ Write("destroyed", FALSE, "none", rd[p].code, FALSE)
               /\ pc' = [pc EXCEPT ![p] = "r_unlink"]
               /\ readRepaired' = TRUE
          ELSE /\ pc' = [pc EXCEPT ![p] = AfterReconcile(p)]
               /\ UNCHANGED <<diskVars, readRepaired>>
    /\ UNCHANGED <<startFailed, lostRepair, diedBeforeRepair, polled, sock,
                   cpc, hostVars, shutVars, rd, gres, lruns, destroyVars,
                   groupVars>>

\* unlinkIfPresent(socketPath(sessionDirectory))
ReconcileUnlinksSocket(p) ==
    /\ pc[p] = "r_unlink"
    /\ sock' = FALSE
    /\ pc' = [pc EXCEPT ![p] = AfterReconcile(p)]
    /\ UNCHANGED <<diskVars, ghostVars, cpc, hostVars, shutVars, rd, gres,
                   lruns, destroyVars, groupVars>>

\* The list process is killed between its write and its repair, for
\* example by a Ctrl-C. Its write may have replaced the destroyed record
\* of a destroy that already reported success. gc's death in the same
\* place leaves the same record, so only list dies in the model. A later
\* list starts a new reconcile.
ListDiesBeforeRepair ==
    /\ pc["list"] = "r_repair"
    /\ pc' = [pc EXCEPT !["list"] = "idle"]
    /\ lostRepair' = (lostRepair \/ (dmark /\ mst # "destroyed"))
    /\ diedBeforeRepair' = (diedBeforeRepair \/ (dmark /\ mst # "destroyed"))
    /\ UNCHANGED <<diskVars, startFailed, readRepaired, polled, sock, cpc,
                   hostVars, shutVars, rd, gres, lruns, destroyVars,
                   groupVars>>

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
                   lruns, destroyVars, groupVars>>

\* manifestBefore = readManifestIfExists; skip when it is missing.
GcReadsManifest ==
    /\ pc["gc"] = "readbefore"
    /\ IF mst = "none" THEN GcSkips ELSE GcGoesTo("r_read")
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, shutVars, rd,
                   lruns, destroyVars, groupVars>>

\* manifestAfter = readManifestIfExists; skip when it is missing or not
\* collectable ("session host is still alive").
GcReadsReconciled ==
    /\ pc["gc"] = "readafter"
    /\ IF mst = "none" \/ (GcSkipsNonCollectable /\ mst \notin Collectable)
          THEN GcSkips
          ELSE GcGoesTo("group")
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, shutVars, rd,
                   lruns, destroyVars, groupVars>>

\* provenProgramGroupRuns reads program.json and judges the group, as the
\* waits of destroy do, but it counts only a group that it proves: a live
\* member carries the token. With Unseen no scan shows the program's
\* processes, and with GcProbesUnseenGroup the probe kill(-pgid, 0) then
\* finds them while no scan shows a member, not even a zombie. With
\* ZombiesInView the scans show zombies of the group, which the probe also
\* finds, so gc needs GcFreezesUnseenGroup: it sends SIGSTOP, a stopped
\* member stays in view, and the judgement after it finds the program's
\* processes. An unrelated group that took the id is in view and reads
\* unproven. With OtherPidSpace gc cannot check the group and reads it not
\* proven, so that a session whose pid space is gone, as after a container
\* restart, does not stay forever. With GcKeepsLiveGroup gc skips a session
\* that is not destroyed while it proves the group ("the session's program
\* group still runs"). The code tests the status of manifestAfter, which
\* cannot turn from destroyed back, so this current status skips no more
\* often.
GcSeesGroup ==
    /\ ~OtherPidSpace /\ ~Refused
    /\ \/ GroupJudged("proven")
       \/ /\ GcProbesUnseenGroup /\ Unseen /\ (prog \/ left)
          /\ (~ZombiesInView \/ GcFreezesUnseenGroup)

GcChecksGroup ==
    /\ pc["gc"] = "group"
    /\ IF GcKeepsLiveGroup /\ mst # "destroyed"
          /\ (Unreadable \/ (rec /\ GcSeesGroup))
          THEN GcSkips
          ELSE GcGoesTo("final")
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, shutVars, rd,
                   lruns, destroyVars, groupVars>>

\* finalManifest = readManifestIfExists; skip when it is there and not
\* collectable ("session restarted between check and delete"). Then
\* removeDeadHostSocket judges the host of that copy: a null hostPid or a
\* dead host sends gc to "rmsock". hostAlive stands in for judgeHost, which
\* reads a dead host alive only when its pid now names another process, and
\* no rule depends on the socket of a dead host.
GcFinalRead ==
    /\ pc["gc"] = "final"
    /\ IF GcFinalCheck /\ mst # "none" /\ mst \notin Collectable
          THEN GcSkips
          ELSE GcGoesTo(IF mpid /\ CliHostAlive THEN "rm" ELSE "rmsock")
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, shutVars, rd,
                   lruns, destroyVars, groupVars>>

\* At "rmsock", removeDeadHostSocket unlinks the socket first. Then
\* rm(sessionDirectory, { recursive: true, force: true, maxRetries: 3,
\*    retryDelay: 10 })
GcRemoves ==
    /\ pc["gc"] \in {"rm", "rmsock"}
    /\ sock' = (sock /\ pc["gc"] = "rm")
    /\ dir' = FALSE /\ mst' = "none" /\ mpid' = FALSE /\ morigin' = "none"
    /\ mcode' = FALSE /\ mchild' = FALSE /\ dmark' = FALSE /\ cmark' = FALSE
    /\ rec' = FALSE /\ hrec' = FALSE
    /\ pc' = [pc EXCEPT !["gc"] = "done"]
    /\ gres' = "removed"
    /\ UNCHANGED <<wasTerminal, wasExited, wasNamed, ghostVars, cpc,
                   hostVars, shutVars, rd, lruns, destroyVars, reused,
                   hitUnrelated, diedUnrecorded, hreused, hitUnrelatedHost,
                   passedReused>>

\* -------------------------------------------------------------------------
\* list: another command that reconciles this session (see the header)

ListStartsReconcile ==
    /\ pc["list"] = "idle" /\ lruns < MaxListReconciles
    /\ pc' = [pc EXCEPT !["list"] = "r_read"]
    /\ lruns' = lruns + 1
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, shutVars, rd,
                   gres, destroyVars, groupVars>>

\* -------------------------------------------------------------------------
\* destroy (runDestroyCommand, destroySession). Its reconcileSession calls
\* are the "list" process's reconciles, so after each one this process only
\* reads.

\* A destroy inside the program's session dies once the program's leader
\* has ended or a kill reached its group: the leader's exit, and the host's
\* death, which closes the PTY, make the kernel hang up the session's
\* foreground group, and a group kill ends the CLI with the group. It takes
\* no step after that.
DestroyDoomed == dinside /\ dpc # "done" /\ (~prog \/ hex # "wait")

\* destroy is at one of `labels` and still alive.
DestroyAt(labels) == dpc \in labels /\ ~DestroyDoomed

DestroyDies ==
    /\ DestroyDoomed
    /\ dpc' = "done" /\ dres' = "killed" /\ drd' = NoRead
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, shutVars,
                   readerVars, dforce, dinside, dsaw, dkill, dblind,
                   groupVars>>

\* runDestroyCommand: cliRunsInsideProgramSession first compares
\* AGENT_TTY_SESSION_ID, which the program and its processes inherit at
\* spawn, with the session id. Then it reads the manifest and compares the
\* CLI's session id (Linux: /proc/self/stat) with its childPid; a manifest
\* that names no program reads as outside. A destroy that the program runs,
\* or that someone types into its interactive shell, runs inside the
\* program's session. The model lets it start only while the program runs,
\* with the variable kept (see the Scope section of SKILL.md). When the
\* check matches, rerunInNewSession runs the same command detached, in a new
\* session and without the variable, and the CLI only waits for it. That
\* copy does the steps below as a destroy from outside. Without
\* InsideCheckReadsEnv the check misses an inside destroy while no manifest
\* names the program.
DestroyChecksSession ==
    /\ DestroyAt({"check"})
    /\ \E inside \in IF hex = "wait" /\ prog THEN BOOLEAN ELSE {FALSE} :
          dinside' = (inside /\ ~(ReRunsInNewSession
                                  /\ (InsideCheckReadsEnv \/ mchild)))
    /\ dpc' = "read"
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, shutVars,
                   readerVars, dforce, drd, dres, dsaw, dkill, dblind,
                   groupVars>>

ReadCopy == [pid |-> mpid, origin |-> morigin, code |-> mcode, child |-> mchild,
             grp |-> "none"]

DestroyEnds(result) ==
    /\ dpc' = "done" /\ dres' = result /\ drd' = NoRead
    /\ UNCHANGED dsaw

\* With DestroyStopsLeftovers, stopLeftoversThenRecordDestroyed first stops
\* what program.json proves of the program's group (DestroyKillsLeftovers),
\* then records destroyed. Without it, destroy records at once.
AfterTerminalRead(next) == IF DestroyStopsLeftovers THEN "tkill" ELSE next

\* recordDestroyed's write: with ReconcileRepairsDestroyed it writes the
\* destroy marker first ("tmark").
Records == IF ReconcileRepairsDestroyed THEN "tmark" ELSE "twrite"

\* A terminal copy with DestroyRecordsDestroyed: recordDestroyed writes
\* destroyed from it unless it already says destroyed. Without it, destroy
\* returns on any terminal copy.
DestroyFinishes ==
    IF ~DestroyRecordsDestroyed
    THEN /\ dpc' = "done" /\ dres' = "ok" /\ drd' = NoRead
         /\ dsaw' = (mst = "destroyed")
    ELSE IF mst = "destroyed"
    THEN /\ dpc' = IF OtherPidSpace /\ UnsharedGroupReadsUnknown
                   THEN "tunlink" ELSE AfterTerminalRead("tunlink")
         /\ dsaw' = TRUE
         /\ drd' = NoRead /\ UNCHANGED dres
    ELSE /\ dpc' = AfterTerminalRead(Records) /\ drd' = ReadCopy
         /\ UNCHANGED <<dres, dsaw>>

\* readSessionManifestOrThrow throws SESSION_NOT_FOUND on a missing manifest,
\* then destroySession throws SESSION_ALREADY_DESTROYED on a destroyed one,
\* after removeDeadHostSocket unlinked the socket of a host that the copy
\* proves gone (see GcFinalRead). A terminal copy goes to recordDestroyed, an
\* active one to --force or to the destroy RPC.
DestroyReads ==
    /\ DestroyAt({"read"})
    /\ IF mst \in {"none", "destroyed"}
          THEN DestroyEnds("error")
          ELSE IF mst \in Terminal
          THEN /\ dpc' = AfterTerminalRead(Records) /\ drd' = ReadCopy
               /\ UNCHANGED <<dres, dsaw>>
          ELSE IF dforce
          THEN /\ dpc' = "kill" /\ drd' = ReadCopy
               /\ UNCHANGED <<dres, dsaw>>
          ELSE /\ dpc' = "rpc" /\ UNCHANGED <<drd, dres, dsaw>>
    /\ sock' = (sock /\ (mst # "destroyed" \/ (mpid /\ CliHostAlive)))
    /\ UNCHANGED <<diskVars, ghostVars, cpc, hostVars, shutVars,
                   readerVars, dforce, dinside, dkill, dblind, groupVars>>

\* stopLeftoversThenRecordDestroyed: stopSessionProcesses(sessionId, null,
\* await readProvenProgramGroup(sessionDirectory), ...). The program.json
\* read lands, then stopProgramGroup kills the group that it proves. A
\* record without a token, or no record, proves nothing and gets no kill.
\* Then waitForProcessesToExit (DestroyPollsGroup, at "twait").
DestroyKillsLeftovers ==
    /\ DestroyAt({"tkill"})
    /\ IF Unreadable /\ ~(dforce /\ ForceSkipsUnreadableGroup)
          THEN /\ NoKill /\ DestroyEnds("error")
          ELSE /\ IF rec /\ ~OtherPidSpace /\ ~Refused /\ ~Unreadable
                     THEN ProvenKill ELSE NoKill
               /\ drd' = [drd EXCEPT !.grp = IF Unreadable THEN "blind"
                                             ELSE IF rec THEN "proven"
                                             ELSE "none"]
               /\ dpc' = "twait"
               /\ UNCHANGED dres
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostAlive, hpc, hex, rsz,
                   foreign, shutVars, readerVars, dforce, dinside, dsaw,
                   dkill, dblind, rec, reused, diedUnrecorded, hrec, hreused,
                   hitUnrelatedHost, passedReused>>

\* recordDestroyed: writeDestroyMarker, an empty file written with no mkdir.
\* When gc removed the directory in the meantime, it throws
\* SESSION_NOT_FOUND, and destroy reports that error.
DestroyMarksFolder ==
    /\ DestroyAt({"tmark"})
    /\ IF dir
          THEN /\ dmark' = TRUE /\ dpc' = "twrite" /\ UNCHANGED <<drd, dres>>
               /\ dblind' = (dblind \/ drd.grp = "blind")
          ELSE /\ DestroyEnds("error") /\ UNCHANGED <<dmark, dblind>>
    /\ UNCHANGED <<dir, mst, mpid, morigin, mcode, mchild, wasTerminal,
                   wasExited, wasNamed, cmark, ghostVars, sock, cpc, hostVars,
                   shutVars, readerVars, dforce, dinside, dsaw, dkill,
                   groupVars>>

\* recordDestroyed: writeManifest({ ...manifest, status: 'destroyed' }) from
\* the copy that destroy read. When gc removed the directory in the meantime,
\* the write throws SESSION_NOT_FOUND, and destroy reports that error.
DestroyWritesDestroyed ==
    /\ DestroyAt({"twrite"})
    /\ IF WriteLands
          THEN /\ Write("destroyed", drd.pid, drd.origin,
                        DestroyKeepsExitCode /\ drd.code, drd.child)
               /\ dpc' = "tunlink" /\ drd' = NoRead /\ dsaw' = TRUE
               /\ dblind' = (dblind \/ drd.grp = "blind")
               /\ UNCHANGED dres
          ELSE /\ DestroyEnds("error")
               /\ UNCHANGED <<diskVars, dblind>>
    /\ UNCHANGED <<ghostVars, sock, cpc, hostVars, shutVars, readerVars,
                   dforce, dinside, dkill, groupVars>>

\* recordDestroyed: unlinkIfPresent(socketFile). destroy reports success.
DestroyUnlinksSocket ==
    /\ DestroyAt({"tunlink"})
    /\ sock' = FALSE
    /\ dpc' = "done" /\ dres' = "ok"
    /\ UNCHANGED <<diskVars, ghostVars, cpc, hostVars, shutVars, readerVars,
                   dforce, dinside, drd, dsaw, dkill, dblind, groupVars>>

\* killHostBestEffort(host) of the copy that destroy read. With
\* ProvesHostPid it kills only a host that hostMatches proves: the live host
\* once host.json names it, never a process that took its pid. Without it,
\* the kill reaches whatever has the pid. The copy that destroy read after
\* the first kill names the same host. In another pid space, hostMatches
\* never proves the host, so nothing gets the kill.
KillsHost ==
    IF dpc \in {"kill", "rkill"} /\ drd.pid /\ hostAlive /\ ~OtherPidSpace
          /\ (hrec \/ ~ProvesHostPid)
    THEN /\ HostDies /\ dkill' = TRUE /\ UNCHANGED hitUnrelatedHost
    ELSE IF dpc \in {"kill", "rkill"} /\ drd.pid /\ hreused /\ ~ProvesHostPid
    THEN /\ hitUnrelatedHost' = TRUE
         /\ UNCHANGED <<hostAlive, hpc, hex, rsz, dkill, diedUnrecorded>>
    ELSE UNCHANGED <<hostAlive, hpc, hex, rsz, dkill, diedUnrecorded,
                     hitUnrelatedHost>>

\* --force: `await readProgramGroup(sessionDirectory, childPid)` reads
\* program.json, then stopSessionProcesses: stopProgramGroup(group) and
\* killProcessBestEffort(hostPid), one synchronous block. Then
\* waitForProcessesToExit (DestroyPollsGroup). destroy does this twice:
\* after its first read ("kill") and after the read that follows the first
\* wait ("rkill").
DestroyKills ==
    /\ DestroyAt({"kill", "rkill"})
    /\ IF Unreadable /\ ~ForceSkipsUnreadableGroup
          THEN /\ NoKill /\ DestroyEnds("error")
               /\ UNCHANGED <<hostAlive, hpc, hex, rsz, dkill, diedUnrecorded,
                              hitUnrelatedHost>>
          ELSE /\ IF Unreadable THEN NoKill ELSE CliKillThrough(drd.child)
               /\ KillsHost
               /\ drd' = [drd EXCEPT !.grp = IF Unreadable THEN "blind"
                                             ELSE KindThrough(drd.child)]
               /\ dpc' = IF dpc = "kill" THEN "kwait" ELSE "rwait"
               /\ UNCHANGED dres
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, foreign, shutVars,
                   readerVars, dforce, dinside, dsaw, dblind, rec, reused,
                   hrec, hreused, passedReused>>

\* waitForProcessesToExit in stopSessionProcesses polls until the host is
\* dead and isProgramGroupAlive(group) reads false. A host that the kill
\* did not reach, because host.json did not name it yet, can still run.
\* After about 5 seconds the wait gives up, and stopSessionProcesses throws
\* HOST_TIMEOUT. The model lets the wait give up at any poll that reads the
\* group or the host alive. After the first wait ("kwait"),
\* with DestroyRecordsDestroyed destroy reads the manifest again; without
\* it, destroy goes to the reconcile and final read of the code before
\* recordDestroyed. After the second wait ("rwait"), recordDestroyed.
DestroyPollsGroup ==
    /\ DestroyAt({"kwait", "rwait", "twait"})
    /\ passedReused' = (passedReused \/
                         (reused /\ drd.grp = "proven" /\ ~CliGroupSeen(drd.grp)))
    /\ IF CliGroupSeen(drd.grp) \/ (dpc # "twait" /\ drd.pid /\ CliHostAlive)
          THEN DestroyEnds("error")
          ELSE IF dpc = "kwait"
          THEN /\ dpc' = IF DestroyRecordsDestroyed THEN "reread" ELSE "final"
               /\ drd' = NoRead /\ UNCHANGED <<dres, dsaw>>
          ELSE IF dsaw
          THEN /\ dpc' = "tunlink" /\ drd' = NoRead /\ UNCHANGED <<dres, dsaw>>
          ELSE /\ dpc' = Records /\ UNCHANGED <<drd, dres, dsaw>>
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, shutVars,
                   readerVars, dforce, dinside, dkill, dblind, rec, reused,
                   hitUnrelated, diedUnrecorded, hrec, hreused,
                   hitUnrelatedHost>>

\* readSessionManifestOrThrow after both processes died, so no host write
\* can follow it. Then destroy kills the group again ("rkill") and waits,
\* and recordDestroyed writes from this copy.
DestroyRereads ==
    /\ DestroyAt({"reread"})
    /\ IF mst = "none"
          THEN DestroyEnds("error")
          ELSE /\ dpc' = "rkill" /\ drd' = ReadCopy
               /\ dsaw' = (mst = "destroyed")
               /\ UNCHANGED dres
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, shutVars,
                   readerVars, dforce, dinside, dkill, dblind, groupVars>>

\* sendRpc(socketFile, 'destroy') reaches the host, whose destroy handler
\* calls startShutdown and answers. The host does the work, so this is one
\* step.
DestroySendsRpc ==
    /\ DestroyAt({"rpc"}) /\ sock /\ hostAlive
    /\ StartShutdown(WriteQueued)
    /\ dpc' = "poll"
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, hwt, sig,
                   readerVars, dforce, dinside, drd, dres, dsaw, dkill, dblind,
                   groupVars>>

\* No socket file, or nobody listens on it: HOST_UNREACHABLE. destroy then
\* reconciles and reads the manifest.
DestroyRpcFails ==
    /\ DestroyAt({"rpc"}) /\ ~(sock /\ hostAlive)
    /\ dpc' = "final"
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, shutVars,
                   readerVars, dforce, dinside, drd, dres, dsaw, dkill, dblind,
                   groupVars>>

\* waitForTerminalManifest: readManifest until it is terminal. A missing
\* manifest throws. A read that is not terminal is either retried or the
\* last one; destroy then reconciles and reads again.
DestroyPolls ==
    /\ DestroyAt({"poll"})
    /\ IF mst = "none"
          THEN DestroyEnds("error")
          ELSE IF mst \in Terminal
          THEN DestroyFinishes
          ELSE /\ dpc' = "final" /\ UNCHANGED <<drd, dres, dsaw>>
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, shutVars,
                   readerVars, dforce, dinside, dkill, dblind, groupVars>>

\* readSessionManifestOrThrow after destroy's own reconcile: terminal means
\* success, anything else throws.
DestroyFinalRead ==
    /\ DestroyAt({"final"})
    /\ IF mst \in Terminal THEN DestroyFinishes ELSE DestroyEnds("error")
    /\ UNCHANGED <<diskVars, ghostVars, sock, cpc, hostVars, shutVars,
                   readerVars, dforce, dinside, dkill, dblind, groupVars>>

\* Every process is finished. This step keeps TLC from reporting the end
\* states as deadlocks. Any other state without a step is a model error.
AllFinished ==
    /\ cpc \in {"done", "failed", "exhausted"} /\ ~hostAlive
    /\ pc["gc"] = "done"
    /\ pc["list"] = "idle" /\ lruns = MaxListReconciles
    /\ dpc = "done"
    /\ UNCHANGED vars

Next ==
    \/ CreateMakesDirectory \/ CreateWritesManifest \/ CreateLaunchesHost
    \/ CreateGivesUp \/ CreateStopsHostOnWindows \/ CreateRewritesMarker
    \/ HostReadsManifest \/ HostOpensLogAndSpawns \/ HostRecordsProgram
    \/ HostWritesPids \/ HostChecksMarker \/ HostPollsMarker
    \/ HostListens \/ HostStartsResize \/ HostResizeWriteLands
    \/ HostGetsSigterm \/ HostWritesDestroying \/ HostClosesSocket
    \/ HostKillsProgram \/ ProgramExits \/ HostPollsGroup \/ HostWritesExit
    \/ HostProcessEnds \/ HostCrashes
    \/ ForeignStarts \/ ForeignEnds \/ LeftoverEnds \/ GroupIdReused
    \/ HostPidReused
    \/ \E p \in Readers :
          \/ ReconcileReads(p) \/ ReconcileChecksHost(p)
          \/ ReconcileRereadsManifest(p) \/ ReconcileReadsRecord(p)
          \/ ReconcilePollsGroup(p)
          \/ ReconcileWrites(p) \/ ReconcileRepairs(p)
          \/ ReconcileWritesMarked(p) \/ ReconcileUnlinksSocket(p)
    \/ ListDiesBeforeRepair
    \/ GcFindsDirectory \/ GcReadsManifest \/ GcReadsReconciled
    \/ GcChecksGroup \/ GcFinalRead \/ GcRemoves
    \/ ListStartsReconcile
    \/ DestroyChecksSession \/ DestroyReads \/ DestroyMarksFolder
    \/ DestroyWritesDestroyed
    \/ DestroyUnlinksSocket \/ DestroyKillsLeftovers \/ DestroyKills
    \/ DestroyPollsGroup
    \/ DestroyRereads \/ DestroySendsRpc \/ DestroyRpcFails
    \/ DestroyPolls \/ DestroyFinalRead \/ DestroyDies
    \/ AllFinished

Spec == Init /\ [][Next]_vars

\* -------------------------------------------------------------------------
\* Rules. check.sh runs each one on its own.

TypeOK ==
    /\ dmark => dir
    /\ cmark => dir
    /\ {dir, mpid, mchild, wasTerminal, wasExited, wasNamed, dmark, cmark,
        startFailed,
        readRepaired, lostRepair, diedBeforeRepair, polled, sock,
        hostAlive, prog, foreign, sig, dforce, dinside, dsaw, dkill, dblind,
        rec, left,
        reused, hitUnrelated, diedUnrecorded, passedReused, hrec, hreused,
        hitUnrelatedHost}
       \subseteq BOOLEAN
    /\ hreused => ~hostAlive
    /\ hrec => dir
    /\ mst \in {"none", "running", "destroying", "exited", "failed",
                "destroyed"}
    /\ morigin \in {"none", "host-death", "unknown"}
    /\ hst \in {"running", "destroying", "exited", "destroyed"}
    /\ hsd \in {"none", "write", "wait", "closed"}
    /\ dsnap \in {"none", "destroying", "destroyed"}
    /\ (mst # "none") => dir
    /\ (dir /\ mst = "none") =>
          cpc \notin {"done", "giveup", "retry", "failed", "exhausted"}
    /\ (cpc = "write") => dir
    /\ gres \in {"pending", "skipped", "removed"}
    /\ lruns \in 0..MaxListReconciles
    /\ dres \in {"pending", "ok", "error", "killed"}
    /\ {hwt, mcode} \subseteq BOOLEAN
    /\ (mst = "none") => ~mcode /\ ~mchild
    /\ mchild => wasNamed
    /\ (hostAlive /\ hsd = "write" /\ dsnap = "none") =>
          (hpc = "pidwrite" \/ rsz = "pending" \/ ExitWriteAheadOfDestroying)
    /\ \A p \in Readers : rd[p].grp \in GroupKinds
    /\ drd.grp \in GroupKinds
    /\ reused => ~(prog \/ foreign \/ left)
    /\ rec => dir

HostMayStillWrite ==
    /\ hostAlive /\ ~WriterStopped
    /\ \/ hex \in {"none", "wait", "groupwait", "exitwrite", "giveup"}
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

\* R8: the manifest says destroyed only after the host saw the program end.
\* R11 covers a program that outlives its host.
DestroyedOnlyWhenEnded ==
    (mst = "destroyed" /\ hostAlive) => hex \in {"exitwrite", "done"}

\* R9: destroy reports success only after it wrote destroyed or read it.
DestroyEndsDestroyed == dres = "ok" => dsaw

\* R10: once gc removed the session directory, no write brings it back.
RemovedFolderStaysRemoved == gres = "removed" => ~dir

\* R11: when the manifest says destroyed, no process of the program's
\* process group runs, also none of another user. It does not count a
\* process that a program left when it exited on its own (`left`, which R16
\* covers), nor a program that no manifest named: its host died before the
\* start-up write (see the Scope section of SKILL.md).
DestroyedProgramStopped ==
    (mst = "destroyed" /\ wasNamed /\ ~dblind) => ~GroupAlive

\* R13: while a process of the program's group runs, a manifest that named
\* the program still names it, so a later destroy or reconcile can still
\* kill the group.
LiveGroupStaysNamed == (GroupAlive /\ wasNamed /\ mst # "none") => mchild

\* R14: destroy is never killed before it reports, also when it runs inside
\* the program's session.
DestroyOutlivesProgram == dres # "killed"

\* R15: no kill reaches a process group that took the program's group id
\* after the program's group ended.
NoUnrelatedGroupKilled == ~hitUnrelated

\* R16: when the manifest says destroyed, no process of the program's group
\* runs, also none that the program left when it exited on its own, unless
\* the host died after it started the program and before program.json named
\* it (see the Scope section of SKILL.md).
DestroyedSessionStopped ==
    (mst = "destroyed" /\ ~diedUnrecorded /\ ~dblind) => ~(GroupAlive \/ left)

\* R17: once create gave up, its host keeps the session "running" only
\* while create's SIGTERM is still on its way to it, or while the host has
\* yet to check for the create-failed marker. A create that gave up after
\* all its marker writes failed ends as "exhausted", which R17 does not
\* cover (see the Scope section of SKILL.md).
FailedCreateStopped ==
    (cpc = "failed" /\ hostAlive /\ hst = "running") =>
        \/ CreateStopsOnGiveUp /\ ~Win32 /\ ~sig
        \/ HostChecksCreateFailed /\ cmark
           /\ hpc \in {"boot", "open", "record", "pidwrite", "markcheck"}
        \/ HostPollsCreateFailed /\ cmark /\ hpc \in {"sockdir", "serving"}

\* R18: once destroy reported success, the manifest says destroyed while the
\* directory exists, except while a reconcile that wrote over it has yet to
\* write destroyed again, or, after that reconcile died, until the next
\* reconcile reads the manifest and writes destroyed.
DestroyedStaysDestroyed ==
    (dres = "ok" /\ dir) =>
        \/ mst = "destroyed"
        \/ \E p \in Readers : pc[p] \in {"r_repair", "r_marked"}
        \/ lostRepair

\* R19: no kill of destroy --force reaches a process that took the host's
\* pid after the host ended.
NoUnrelatedHostKilled == ~hitUnrelatedHost

\* R20: gc in the host's pid space removes the folder, and with it
\* program.json, only once no process of the program's group runs, also
\* none that the program left when it exited on its own. It does not count
\* a program that no program.json named (see R16). A gc in another pid
\* space cannot check the group, and it removes the folder as it does
\* without a token (WitnessUnsharedGcRemovesLeftover).
RemovedSessionStopped ==
    (gres = "removed" /\ ~diedUnrecorded /\ ~OtherPidSpace /\ ~Refused
     /\ ~dblind)
        => ~(GroupAlive \/ left)

\* Witnesses. check.sh expects TLC to report each one VIOLATED, which shows
\* that the model reaches the state: the rules above are not true only
\* because the model can never get there.
WitnessGcRemovesSession == gres # "removed"
WitnessReconcileRepairs ==
    ~(dmark /\ mst = "failed" /\ \E p \in Readers : pc[p] = "r_repair")
WitnessMarkedRepaired == ~readRepaired
WitnessMarkerPolled == ~polled
WitnessMarkerRetried == cpc # "retry"
WitnessDeadRepairRepaired ==
    ~(diedBeforeRepair /\ ~lostRepair /\ mst = "destroyed" /\ dir)
WitnessCreateGivesUp ==
    ~(cpc = "failed" /\ sig /\ mst = "destroyed" /\ ~hostAlive)
WitnessSessionServes == ~(hpc = "serving" /\ sock /\ mst = "running" /\ mpid)
WitnessResizeLands == ~(rsz = "done" /\ hostAlive /\ mst = "running")
WitnessCleanExitRecorded == ~(mst = "exited" /\ ~hostAlive)
WitnessCrashReconciled ==
    ~(mst = "failed" /\ morigin = "host-death" /\ hpc = "dead")
WitnessDestroyCompletes ==
    ~(dres = "ok" /\ ~dforce /\ ~sig /\ ~wasExited /\ mst = "destroyed"
      /\ hex = "done" /\ ~hostAlive)
WitnessSigtermRecorded ==
    ~(sig /\ dpc = "check" /\ mst = "destroyed" /\ hex = "done" /\ ~hostAlive)
WitnessDestroyExitedSession ==
    ~(wasExited /\ mst = "destroyed" /\ dres = "ok")
WitnessForceDestroyRecorded == ~(dkill /\ dres = "ok" /\ mst = "destroyed")
WitnessProgramOutlivesHost == ~(prog /\ ~hostAlive /\ wasNamed)
WitnessForeignOutlivesDestroy ==
    ~(foreign /\ ~dforce /\ ~sig /\ dres = "error" /\ mst = "destroying"
      /\ hex = "done" /\ ~hostAlive)
WitnessForeignOutlivesForce ==
    ~(foreign /\ dkill /\ dres = "error" /\ mchild
      /\ mst \in {"running", "destroying"})
WitnessLeftoverMeetsDestroy == ~(left /\ mst = "exited" /\ dpc = "tkill")
WitnessReusedIdMeetsKill == ~(reused /\ rec /\ dpc \in {"kill", "rkill"})
WitnessReusedHostMeetsKill ==
    ~(hreused /\ drd.pid /\ dpc \in {"kill", "rkill"})
WitnessUnrecordedHostMeetsKill ==
    ~(hostAlive /\ ~hrec /\ drd.pid /\ dpc = "kill")
WitnessRecordNamesProgram ==
    ~(rec /\ ~wasNamed /\ dkill /\ dres = "ok" /\ mst = "destroyed")
WitnessUnrecordedProgramOutlives ==
    ~(diedUnrecorded /\ prog /\ mst = "destroyed")
WitnessWaitPassesReusedId == ~passedReused
\* With OtherPidSpace a plain destroy of a session whose program ran still
\* reports success: the host ends the session, and destroy trusts its
\* destroyed record.
WitnessUnsharedDestroyCompletes ==
    ~(OtherPidSpace /\ ~dforce /\ wasNamed /\ dres = "ok")
\* With OtherPidSpace gc removes an exited session while a process that
\* the program left runs, because it cannot check the group there: the
\* state that R20 leaves out.
WitnessUncheckedForceDestroys == ~(dblind /\ dres = "ok" /\ left)
WitnessRefusedGcRemovesLeftover ==
    ~(Refused /\ gres = "removed" /\ ~diedUnrecorded /\ left)
WitnessUnsharedGcRemovesLeftover ==
    ~(OtherPidSpace /\ gres = "removed" /\ ~diedUnrecorded /\ left)
=============================================================================
