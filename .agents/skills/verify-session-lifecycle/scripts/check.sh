#!/usr/bin/env bash
# Model-check the agent-tty session lifecycle: create, the session host,
# reconcileSession, gc, and destroy, all acting on one session at the same
# time.
#
#   .agents/skills/verify-session-lifecycle/scripts/check.sh [--update-coverage | --drift-only]
#
# --drift-only compares the facts and the covered code with coverage.json
# and runs no TLC, so it needs no Java: exit 0 or 3 as below.
#
# Exit 0: every TLC run gave the expected result and the covered code is
#         unchanged since the last sync.
# Exit 1: a run gave an unexpected result (a new bug, a fixed finding, or a
#         model error). The summary names each one.
# Exit 3: every result was as expected, but covered code changed since the
#         sync. That is not a pass: re-read the changed code first. When
#         both apply, the exit code is 1.
# Exit 2: the tools could not run.
#
# Needs: node (the repo's), Java 11 or newer, and the network once, to fetch
# the pinned TLC jar. Env: JAVA (default java), TLA2TOOLS_JAR (use this jar),
# CHECK_OUT (keep the results in this folder), CHECK_JOBS (default 4),
# CHECK_SHARD=<i>/<n> (run only the i-th of n shares of the runs; CI runs
# the shares in parallel jobs).
set -euo pipefail

UPDATE_COVERAGE=0
DRIFT_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --update-coverage) UPDATE_COVERAGE=1 ;;
    --drift-only) DRIFT_ONLY=1 ;;
    *)
      echo "usage: $0 [--update-coverage | --drift-only]" >&2
      exit 2
      ;;
  esac
done
[ $((UPDATE_COVERAGE + DRIFT_ONLY)) -le 1 ] ||
  { echo "usage: $0 [--update-coverage | --drift-only]" >&2; exit 2; }

SKILL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
REPO=$(git -C "$SKILL_DIR" rev-parse --show-toplevel)
SPEC="$SKILL_DIR/model/SessionLifecycle.tla"
COVERAGE="$SKILL_DIR/coverage.json"
JAVA=${JAVA:-java}
JOBS=${CHECK_JOBS:-4}
SHARD=${CHECK_SHARD:-1/1}
TLC_VERSION=1.7.4
TLC_SHA256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
TLC_URL="https://github.com/tlaplus/tlaplus/releases/download/v$TLC_VERSION/tla2tools.jar"
JAR=${TLA2TOOLS_JAR:-$SKILL_DIR/.cache/tla2tools-$TLC_VERSION.jar}

die() {
  echo "check.sh: $*" >&2
  exit 2
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# --- tools ---------------------------------------------------------------

case "$JOBS" in
  *[!0-9]* | 0*) die "CHECK_JOBS must be a positive integer, not '$JOBS'" ;;
esac
SHARD_INDEX=${SHARD%%/*}
SHARD_COUNT=${SHARD#*/}
[[ $SHARD =~ ^[1-9][0-9]*/[1-9][0-9]*$ ]] && [ "$SHARD_INDEX" -le "$SHARD_COUNT" ] ||
  die "CHECK_SHARD must be <i>/<n> with 1 <= i <= n, not '$SHARD'"
command -v node >/dev/null 2>&1 || die "node is not on PATH"
if [ "$DRIFT_ONLY" -eq 0 ]; then
  # `java -version` prints `version "11.0.2"`, or `version "1.8.0_292"` for Java 8.
  java_out=$("$JAVA" -version 2>&1) || die "Java 11+ is needed (set JAVA=/path/to/java)"
  java_version=$(sed -n 's/.* version "\([^"]*\)".*/\1/p' <<<"$java_out" | head -1)
  [ -n "$java_version" ] || die "Java 11+ is needed (set JAVA=/path/to/java)"
  java_major=${java_version#1.}
  java_major=${java_major%%[!0-9]*}
  [ -n "$java_major" ] && [ "$java_major" -ge 11 ] ||
    die "Java 11+ is needed, $JAVA is version $java_version (set JAVA=/path/to/java)"
  if [ ! -f "$JAR" ]; then
    mkdir -p "$(dirname "$JAR")"
    echo "Fetching TLC $TLC_VERSION into $JAR"
    curl -fsSL -o "$JAR.part" "$TLC_URL" || die "could not download $TLC_URL"
    mv "$JAR.part" "$JAR"
fi
[ "$(sha256 "$JAR")" = "$TLC_SHA256" ] || die "$JAR does not match the pinned sha256 of TLC $TLC_VERSION"
fi

OUT=${CHECK_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/session-lifecycle-check.XXXXXX")}
mkdir -p "$OUT"

# --- facts from the code -------------------------------------------------

node "$SKILL_DIR/scripts/facts.mjs" "$REPO" >"$OUT/facts.json" ||
  die "facts.mjs failed: a covered function moved or was renamed (see the error above)"

if [ "$UPDATE_COVERAGE" -eq 1 ]; then
  node -e '
    const fs = require("node:fs");
    const facts = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const record = {
      constants: facts.constants,
      fingerprints: facts.fingerprints,
      callSites: facts.callSites,
    };
    fs.writeFileSync(process.argv[2], JSON.stringify(record, null, 2) + "\n");
  ' "$OUT/facts.json" "$COVERAGE"
  echo "Rewrote $COVERAGE. Commit it only after you have confirmed that the model"
  echo "describes the code: that commit becomes the sync commit."
fi

# Prints one line per fact, covered function or call site that changed. The
# facts come from the source text with its comments, and the hashes leave
# comments out, so a new comment in a guarded block can turn a guard FALSE
# while every hash stays the same.
node -e '
  const fs = require("node:fs");
  const facts = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const record = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const recorded = record.constants ?? {};
  for (const [key, value] of Object.entries(facts.constants)) {
    const before = key in recorded ? JSON.stringify(recorded[key]) : "not recorded";
    if (before !== JSON.stringify(value)) {
      console.log(`fact ${key} changed: was ${before}, now ${JSON.stringify(value)}`);
    }
  }
  for (const key of Object.keys(recorded)) {
    if (!(key in facts.constants)) console.log(`fact ${key} is no longer read`);
  }
  for (const [key, value] of Object.entries(facts.fingerprints)) {
    if (record.fingerprints[key] !== value) console.log(`changed: ${key}`);
  }
  for (const key of Object.keys(record.fingerprints)) {
    if (!(key in facts.fingerprints)) console.log(`no longer covered: ${key}`);
  }
  for (const [kind, sites] of Object.entries(facts.callSites)) {
    const before = (record.callSites[kind] ?? []).join("\n");
    if (sites.join("\n") !== before) {
      console.log(`call sites of ${kind} changed: now ${sites.join(", ")}`);
    }
  }
' "$OUT/facts.json" "$COVERAGE" >"$OUT/drift.txt"

if [ "$DRIFT_ONLY" -eq 1 ]; then
  if [ -s "$OUT/drift.txt" ]; then
    echo "STALE: covered code changed since the last sync. Re-read each item,"
    echo "update the model if it no longer describes the code, then run with --update-coverage:"
    sed 's/^/  /' "$OUT/drift.txt"
    exit 3
  fi
  echo "Covered code matches the sync record."
  exit 0
fi

COLLECTABLE=$(node -e '
  const c = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).constants;
  console.log("{" + c.Collectable.map((s) => JSON.stringify(s)).join(", ") + "}");
' "$OUT/facts.json")
TERMINAL=$(node -e '
  const c = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).constants;
  console.log("{" + c.Terminal.map((s) => JSON.stringify(s)).join(", ") + "}");
' "$OUT/facts.json")
GUARDS="GcSkipsNonCollectable GcFinalCheck GcKeepsLiveGroup GcProbesUnseenGroup GcFreezesUnseenGroup ReconcileSkipsTerminal ReconcileSkipsLiveHost CreateRecordsHostPid HostWaitsForManifest ReconcileRereads HostSerializesWrites HostStopsAfterTerminalWrite ShutdownChecksCommandable DestroyRecordsDestroyed DestroyKeepsExitCode ManifestWriteNeedsFolder KillsProgramGroup ProbeCountsDeniedGroup HostWaitsForGroup ReconcileWaitsForGroup ReRunsInNewSession InsideCheckReadsEnv RecordsProgramSync ProvesGroupOwnership DestroyStopsLeftovers FallbackNeedsFolder ReconcileRepairsDestroyed ReconcileRepairsMarked CreateStopsOnGiveUp TokenNamesProgram ReusedIdReadsGone ProvesHostPid CreateRecordsHost FreezesUnseenGroup UnsharedGroupReadsUnknown HostChecksCreateFailed HostPollsCreateFailed CreateRetriesMarker ForceSkipsUnreadableGroup"
# One "Guard=TRUE|FALSE" word per guard, read from the code by facts.mjs.
FACTS_LINE=$(node -e '
  const c = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).constants;
  console.log(process.argv.slice(2).map((g) => {
    if (typeof c[g] !== "boolean") throw new Error(`facts.mjs gave no boolean for ${g}`);
    return `${g}=${c[g] ? "TRUE" : "FALSE"}`;
  }).join(" "));
' "$OUT/facts.json" $GUARDS) || die "facts.json lacks a guard fact"

NO_TOKEN_RULES="NoLiveSessionDeleted HostDeathOnlyWhenDead TerminalIsFinal RecordedExitKept RunningSessionReachable HostStartsWhenCreated TerminalIsLastWrite DestroyedOnlyWhenEnded DestroyEndsDestroyed RemovedFolderStaysRemoved DestroyedProgramStopped LiveGroupStaysNamed DestroyOutlivesProgram FailedCreateStopped DestroyedStaysDestroyed NoUnrelatedHostKilled"
# R15, R16 and R20 are what the token adds, so only the runs with Token
# check them.
RULES="$NO_TOKEN_RULES NoUnrelatedGroupKilled DestroyedSessionStopped RemovedSessionStopped"
NO_TOKEN_WITNESSES="WitnessCreateGivesUp WitnessCrashReconciled WitnessDestroyExitedSession WitnessForceDestroyRecorded WitnessProgramOutlivesHost WitnessForeignOutlivesDestroy WitnessForeignOutlivesForce WitnessReconcileRepairs"
WITNESSES="WitnessGcRemovesSession WitnessCreateGivesUp WitnessSessionServes WitnessResizeLands WitnessCleanExitRecorded WitnessCrashReconciled WitnessDestroyCompletes WitnessSigtermRecorded WitnessDestroyExitedSession WitnessForceDestroyRecorded WitnessProgramOutlivesHost WitnessForeignOutlivesDestroy WitnessForeignOutlivesForce WitnessLeftoverMeetsDestroy WitnessReusedIdMeetsKill WitnessRecordNamesProgram WitnessUnrecordedProgramOutlives WitnessReconcileRepairs WitnessMarkedRepaired WitnessDeadRepairRepaired WitnessWaitPassesReusedId WitnessReusedHostMeetsKill WitnessMarkerPolled"

# --- runs ----------------------------------------------------------------

# write_run NAME EXPECT "INVARIANTS" "GUARD=FALSE ..." NOTE [RULE]
# RULE: for an expected violation, the rule that TLC must report.
# TOKEN: whether the host's capture finds the program's session token.
RUNS=""
TOKEN=TRUE
# UNSEEN: whether no scan of /proc shows a live process of the program.
UNSEEN=FALSE
# ZOMBIES: whether, with UNSEEN, the scans show zombies of the program's
# group, as under a PID 1 that never reaps.
ZOMBIES=FALSE
# OTHER: whether destroy, list and gc run in another pid space than the host.
OTHER=FALSE
# WIN32: whether SIGTERM ends the host at once, as on Windows.
WIN32=FALSE
# CHECKFAILS: whether destroy, list and gc fail every read of program.json.
CHECKFAILS=FALSE
# REFUSED: whether /proc of destroy, list and gc refuses the program's
# autogroup.
REFUSED=FALSE
write_run() {
  local name=$1 expect=$2 invariants=$3 overrides=$4 note=$5 must=${6:-}
  local dir="$OUT/$name" fact guard value
  # A reused CHECK_OUT still holds the last run's files, such as actions.txt.
  rm -rf "$dir"
  mkdir -p "$dir"
  cp "$SPEC" "$dir/SessionLifecycle.tla"
  {
    echo "\\* $name: expect $expect. $note"
    echo "CONSTANTS"
    echo "  Collectable = $COLLECTABLE"
    echo "  Terminal = $TERMINAL"
    for fact in $FACTS_LINE; do
      guard=${fact%%=*}
      value=${fact#*=}
      case " $overrides " in *" $guard=FALSE "*) value=FALSE ;; esac
      echo "  $guard = $value"
    done
    echo "  Token = $TOKEN"
    echo "  Unseen = $UNSEEN"
    echo "  ZombiesInView = $ZOMBIES"
    echo "  OtherPidSpace = $OTHER"
    echo "  Win32 = $WIN32"
    echo "  CheckFails = $CHECKFAILS"
    echo "  Refused = $REFUSED"
    echo "  MaxListReconciles = 2"
    echo "SPECIFICATION Spec"
    echo "CHECK_DEADLOCK TRUE"
    echo "INVARIANTS TypeOK $invariants"
  } >"$dir/SessionLifecycle.cfg"
  printf '%s\t%s\t%s\n' "$expect" "$note" "$must" >"$dir/expect.txt"
  RUNS="$RUNS $name"
}

write_run current pass "$RULES" "" "the code as it is: every rule holds"
for witness in $WITNESSES; do
  write_run "witness-$witness" violated "$witness" "" "the model reaches this state"
done
# Each mutant removes one guard and checks only the rule that it protects.
write_run mutant-CreateRecordsHostPid violated NoLiveSessionDeleted "CreateRecordsHostPid=FALSE" "without the pid in the first manifest, gc removes a starting session" NoLiveSessionDeleted
write_run mutant-HostWaitsForManifest violated HostStartsWhenCreated "HostWaitsForManifest=FALSE" "without the wait, the host reads before create writes the manifest" HostStartsWhenCreated
write_run mutant-ReconcileRereads violated RecordedExitKept "ReconcileRereads=FALSE" "without the re-read, reconcile writes over an exit it did not read" RecordedExitKept
write_run mutant-HostSerializesWrites violated TerminalIsFinal "HostSerializesWrites=FALSE" "without one writer, a late start-up write replaces the exit record" TerminalIsFinal
write_run mutant-ReconcileSkipsLiveHost violated HostDeathOnlyWhenDead "ReconcileSkipsLiveHost=FALSE" "without the live-host return, reconcile fails a live session" HostDeathOnlyWhenDead
write_run mutant-HostStopsAfterTerminalWrite violated TerminalIsLastWrite "HostStopsAfterTerminalWrite=FALSE" "without the stop, the exit write follows a destroyed record" TerminalIsLastWrite
write_run mutant-DestroyRecordsDestroyed violated DestroyEndsDestroyed "DestroyRecordsDestroyed=FALSE" "without recordDestroyed, destroy succeeds on a session that is not destroyed" DestroyEndsDestroyed
write_run mutant-DestroyKeepsExitCode violated RecordedExitKept "DestroyKeepsExitCode=FALSE" "without it, destroy writes destroyed without the exit code" RecordedExitKept
write_run mutant-ManifestWriteNeedsFolder violated RemovedFolderStaysRemoved "ManifestWriteNeedsFolder=FALSE" "without it, a write after gc's rm brings the folder back" RemovedFolderStaysRemoved
write_run mutant-KillsProgramGroup violated DestroyedProgramStopped "KillsProgramGroup=FALSE" "with pid kills and pid waits only, a process of the program outlives destroy" DestroyedProgramStopped
write_run mutant-HostWaitsForGroup violated DestroyedProgramStopped "HostWaitsForGroup=FALSE" "without the wait, the host records destroyed while a process of another user runs" DestroyedProgramStopped
write_run mutant-ReconcileWaitsForGroup violated LiveGroupStaysNamed "ReconcileWaitsForGroup=FALSE" "without the wait, reconcile drops childPid while the group runs" LiveGroupStaysNamed
write_run mutant-ReRunsInNewSession violated DestroyOutlivesProgram "ReRunsInNewSession=FALSE" "without the re-run, a destroy inside the program's session dies before it reports" DestroyOutlivesProgram
write_run mutant-InsideCheckReadsEnv violated DestroyOutlivesProgram "InsideCheckReadsEnv=FALSE" "without the variable, the check misses a destroy that runs before the host's start-up write" DestroyOutlivesProgram
write_run mutant-RecordsProgramSync violated DestroyedSessionStopped "RecordsProgramSync=FALSE" "with program.json written after the start-up write, a host death in that write leaves a program that destroy cannot stop" DestroyedSessionStopped
write_run mutant-ProvesGroupOwnership violated NoUnrelatedGroupKilled "ProvesGroupOwnership=FALSE" "without the check before the kill, a kill reaches a group that took the id" NoUnrelatedGroupKilled
write_run mutant-DestroyStopsLeftovers violated DestroyedSessionStopped "DestroyStopsLeftovers=FALSE" "without the kill, destroy of an exited session records destroyed while a process it left runs" DestroyedSessionStopped
write_run mutant-FallbackNeedsFolder violated NoUnrelatedGroupKilled "FallbackNeedsFolder=FALSE" "without the folder check, a childPid that gc's removal left stale gets the kill" NoUnrelatedGroupKilled
write_run mutant-ReconcileRepairsDestroyed violated DestroyedStaysDestroyed "ReconcileRepairsDestroyed=FALSE" "without the marker, a reconcile writes failed over the destroyed that destroy reported" DestroyedStaysDestroyed
write_run mutant-CreateStopsOnGiveUp violated FailedCreateStopped "CreateStopsOnGiveUp=FALSE" "without the SIGTERM, a create that gave up leaves its host serving the session" FailedCreateStopped
write_run mutant-HostChecksCreateFailed pass FailedCreateStopped "HostChecksCreateFailed=FALSE" "redundant off Windows: the SIGTERM stops the host"
write_run mutant-HostPollsCreateFailed pass FailedCreateStopped "HostPollsCreateFailed=FALSE" "redundant off Windows: the SIGTERM stops the host"
write_run mutant-TokenNamesProgram violated DestroyedSessionStopped "TokenNamesProgram=FALSE" "with the host's autogroup as the token, no member carries it, and destroy records destroyed while the program's group runs" DestroyedSessionStopped
write_run mutant-ReusedIdReadsGone pass WitnessWaitPassesReusedId "ReusedIdReadsGone=FALSE" "with a group that took the id read alive, no wait of destroy passes while that group runs"
write_run mutant-ProvesHostPid violated NoUnrelatedHostKilled "ProvesHostPid=FALSE" "without the start-up record, destroy --force kills a process that took the host's pid" NoUnrelatedHostKilled
write_run witness-WitnessUnrecordedHostMeetsKill violated WitnessUnrecordedHostMeetsKill "CreateRecordsHost=FALSE" "without a record from create, as when its capture fails, a kill meets a host that host.json does not name yet"
write_run mutant-ReconcileRepairsMarked violated DestroyedStaysDestroyed "ReconcileRepairsMarked=FALSE" "without the repair at the first read, a list that died between its write and its repair leaves failed, and the next reconcile skips it" DestroyedStaysDestroyed
write_run mutant-ReconcileSkipsTerminal pass RecordedExitKept "ReconcileSkipsTerminal=FALSE" "redundant: the re-read returns on a terminal manifest"
write_run mutant-GcSkipsNonCollectable pass NoLiveSessionDeleted "GcSkipsNonCollectable=FALSE" "redundant: the final check still skips"
write_run mutant-GcFinalCheck pass NoLiveSessionDeleted "GcFinalCheck=FALSE" "redundant: the first check still skips"
write_run mutant-GcBothChecks violated NoLiveSessionDeleted "GcSkipsNonCollectable=FALSE GcFinalCheck=FALSE" "with neither gc check, gc removes live sessions" NoLiveSessionDeleted
write_run mutant-GcKeepsLiveGroup violated RemovedSessionStopped "GcKeepsLiveGroup=FALSE" "without the group check, gc removes program.json while a process that the program left runs" RemovedSessionStopped
write_run mutant-ShutdownChecksCommandable pass TerminalIsFinal "ShutdownChecksCommandable=FALSE" "redundant: the writer writes nothing after a terminal record"
write_run mutant-ShutdownBothChecks violated TerminalIsFinal "ShutdownChecksCommandable=FALSE HostStopsAfterTerminalWrite=FALSE" "with neither, shutdown writes destroying over an exit record" TerminalIsFinal

# A fork chain: each process of the program forks its successor and ends
# between scans, so the kill through the token sees no member until the
# group is frozen.
UNSEEN=TRUE
write_run current-unseen pass "$RULES" "" "the code with a program that no scan shows: every rule holds"
write_run mutant-FreezesUnseenGroup-unseen violated DestroyedProgramStopped "FreezesUnseenGroup=FALSE" "without the freeze, the kill finds no member in view, and destroy records destroyed while a fork chain runs" DestroyedProgramStopped
write_run mutant-GcProbesUnseenGroup-unseen violated RemovedSessionStopped "GcProbesUnseenGroup=FALSE" "without the probe, gc removes program.json while a fork chain that the program left runs" RemovedSessionStopped
# Under a PID 1 that never reaps, the chain also leaves zombies in view.
# With every guard, that changes nothing, so current-unseen covers it.
ZOMBIES=TRUE
write_run mutant-GcFreezesUnseenGroup-unseen-zombies violated RemovedSessionStopped "GcFreezesUnseenGroup=FALSE" "without the freeze, gc reads a fork chain behind its zombies ended and removes program.json while it runs" RemovedSessionStopped
ZOMBIES=FALSE
UNSEEN=FALSE

# destroy, list and gc run without /proc, or in another pid namespace or on
# another machine than the host, so they cannot see the program's group.
OTHER=TRUE
write_run current-otherspace pass "$RULES" "" "the code with destroy, list and gc in another pid space: every rule holds"
write_run witness-WitnessUnsharedDestroyCompletes-otherspace violated WitnessUnsharedDestroyCompletes "" "a plain destroy from another pid space still succeeds"
write_run witness-WitnessUnsharedGcRemovesLeftover-otherspace violated WitnessUnsharedGcRemovesLeftover "" "gc in another pid space cannot check the group, so it removes an exited session while a process that the program left runs"
write_run mutant-UnsharedGroupReadsUnknown-otherspace violated DestroyedSessionStopped "UnsharedGroupReadsUnknown=FALSE" "with the group read gone where no scan or probe shows it, destroy of an exited session records destroyed while a process it left runs" DestroyedSessionStopped
write_run mutant-CreateRecordsHost-otherspace violated HostDeathOnlyWhenDead "CreateRecordsHost=FALSE" "without the record from create, a reconcile in another pid space reads the starting host dead and records it failed" HostDeathOnlyWhenDead
OTHER=FALSE

# destroy, list and gc cannot read program.json (EACCES), or /proc fails with
# a system error. gc keeps the session, and destroy --force ends it without
# the read.
CHECKFAILS=TRUE
write_run current-checkfails pass "$RULES" "" "the code with program.json unreadable for destroy, list and gc: every rule holds"
write_run witness-WitnessUncheckedForceDestroys-checkfails violated WitnessUncheckedForceDestroys "" "destroy --force ends a session whose group it cannot read while a process that the program left runs"
write_run mutant-ForceSkipsUnreadableGroup-checkfails pass WitnessUncheckedForceDestroys "ForceSkipsUnreadableGroup=FALSE" "without the fallback, destroy --force fails on the read, so no command removes the session"
CHECKFAILS=FALSE

# /proc of destroy, list and gc refuses the autogroup of the program's
# processes. gc cannot check the group, and destroy cannot prove it.
REFUSED=TRUE
write_run current-refused pass "$RULES" "" "the code with a /proc that refuses the program's autogroup: every rule holds"
write_run witness-WitnessRefusedGcRemovesLeftover-refused violated WitnessRefusedGcRemovesLeftover "" "gc cannot check the group, so it removes an exited session while a process that the program left runs"
REFUSED=FALSE

# Without a token every kill falls back to the id that a manifest or the
# host's own record names, as before program.json existed.
TOKEN=FALSE
write_run current-no-token pass "$NO_TOKEN_RULES" "" "the code without a token: R1 to R14 and R17 to R19 hold"
for witness in $NO_TOKEN_WITNESSES; do
  write_run "witness-$witness-no-token" violated "$witness" "" "the model reaches this state without a token"
done
write_run mutant-ProbeCountsDeniedGroup-no-token violated DestroyedProgramStopped "ProbeCountsDeniedGroup=FALSE" "without a token, a wait that reads EPERM as gone records destroyed while a process of another user runs" DestroyedProgramStopped
write_run mutant-KillsProgramGroup-no-token violated DestroyedProgramStopped "KillsProgramGroup=FALSE" "without a token, with pid kills and pid waits only, a process of the program outlives destroy" DestroyedProgramStopped
write_run mutant-HostWaitsForGroup-no-token violated DestroyedProgramStopped "HostWaitsForGroup=FALSE" "without a token, the host records destroyed while a process of another user runs" DestroyedProgramStopped
write_run mutant-ReconcileWaitsForGroup-no-token violated LiveGroupStaysNamed "ReconcileWaitsForGroup=FALSE" "without a token, reconcile drops childPid while the group runs" LiveGroupStaysNamed

# Windows: no token, and a SIGTERM ends the host at once, so create sends it
# only when the manifest names the program.
WIN32=TRUE
write_run current-win32 pass "$NO_TOKEN_RULES" "" "the code on Windows: R1 to R14 and R17 to R19 hold"
write_run mutant-HostChecksCreateFailed-win32 violated FailedCreateStopped "HostChecksCreateFailed=FALSE" "without the marker, a host that the manifest does not name yet keeps serving after create gave up" FailedCreateStopped
write_run mutant-HostPollsCreateFailed-win32 violated FailedCreateStopped "HostPollsCreateFailed=FALSE" "without the watch, a host that checked for the marker before create wrote it keeps serving when create cannot read the manifest" FailedCreateStopped
write_run mutant-CreateRetriesMarker-win32 violated FailedCreateStopped "CreateRetriesMarker=FALSE" "without the retries, a marker write that fails once leaves a host that the manifest does not name yet serving after create gave up" FailedCreateStopped
write_run witness-WitnessMarkerRetried-win32 violated WitnessMarkerRetried "" "the model reaches this state on Windows"
WIN32=FALSE

# A run that expects pass explores the whole model and takes minutes, and a
# run that expects a violation stops at the first one, mostly in seconds. So
# a share takes every n-th run of each kind, which spreads the long runs.
if [ "$SHARD_COUNT" -gt 1 ]; then
  passes=0
  others=0
  share=""
  for name in $RUNS; do
    if [ "$(cut -f1 "$OUT/$name/expect.txt")" = pass ]; then
      [ $((passes % SHARD_COUNT + 1)) -eq "$SHARD_INDEX" ] && share="$share $name"
      passes=$((passes + 1))
    else
      [ $((others % SHARD_COUNT + 1)) -eq "$SHARD_INDEX" ] && share="$share $name"
      others=$((others + 1))
    fi
  done
  RUNS=$share
  echo "Share $SHARD of the runs:$RUNS"
fi

# A run that expects pass explores the whole model and takes the longest, so
# the runs that expect pass and run at the same time share the CPUs, each
# with at least 1 TLC worker. A run that expects a violation keeps 1 worker,
# which finds the shortest trace.
CPUS=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)
passes=0
for name in $RUNS; do
  if [ "$(cut -f1 "$OUT/$name/expect.txt")" = pass ]; then
    passes=$((passes + 1))
  fi
done
concurrent=$((passes < JOBS ? passes : JOBS))
PASS_WORKERS=1
if [ "$concurrent" -gt 0 ] && [ "$CPUS" -gt "$concurrent" ]; then
  PASS_WORKERS=$((CPUS / concurrent))
fi

run_tlc() {
  local dir rc=0 workers=1
  dir=$(cd "$OUT/$1" && pwd)
  mkdir -p "$dir/tmp"
  if [ "$(cut -f1 "$dir/expect.txt")" = pass ]; then
    workers=$PASS_WORKERS
  fi
  (cd "$dir" && "$JAVA" -XX:+UseParallelGC -Xmx2g -Djava.io.tmpdir="$dir/tmp" \
    -cp "$JAR" tlc2.TLC -workers "$workers" -config SessionLifecycle.cfg \
    -metadir "$dir/states" SessionLifecycle.tla >tlc.out 2>&1) || rc=$?
  echo "$rc" >"$dir/rc"
}

# A pool: a new run starts as soon as one ends. The bash 3.2 of macOS has
# no `wait -n`, so there each batch of $JOBS runs waits for its slowest.
running=0
for name in $RUNS; do
  run_tlc "$name" &
  running=$((running + 1))
  if [ "$running" -ge "$JOBS" ]; then
    if wait -n 2>/dev/null; then
      running=$((running - 1))
    else
      wait
      running=0
    fi
  fi
done
wait

# --- results -------------------------------------------------------------

unexpected=0
printf '\n%-40s %-10s %-10s %s\n' RUN EXPECTED RESULT DETAIL
for name in $RUNS; do
  dir="$OUT/$name"
  IFS=$'\t' read -r expect note must <"$dir/expect.txt"
  rc=$(cat "$dir/rc")
  rule=$(sed -n 's/^Error: Invariant \([A-Za-z]*\) is violated.*/\1/p' "$dir/tlc.out" | head -1)
  case "$rc" in
    0) result=pass ;;
    12) result=violated ;;
    11) result=deadlock ;;
    *) result="error($rc)" ;;
  esac
  if [ "$result" = violated ] && [ "$rule" = TypeOK ]; then
    result=model-error
  fi
  if [ "$result" = violated ]; then
    # The action of each step, for a quick look. Read the trace itself with
    # the /statechart skill on this folder's .tla and .cfg.
    sed -n 's/^State [0-9]*: <\([A-Za-z]*\).*/\1/p' "$dir/tlc.out" | paste -sd' ' - >"$dir/actions.txt"
  fi
  mark=ok
  if [ "$result" != "$expect" ] || { [ -n "$must" ] && [ "$rule" != "$must" ]; }; then
    mark=UNEXPECTED
    unexpected=1
  fi
  detail="$note"
  [ -n "$rule" ] && detail="$rule; $note"
  printf '%-40s %-10s %-10s %s %s\n' "$name" "$expect" "$result" "$mark" "$detail"
  if [ "$mark" = UNEXPECTED ] && [ -f "$dir/actions.txt" ]; then
    echo "    steps: $(cat "$dir/actions.txt")"
  fi
  if [ "$mark" = UNEXPECTED ] && [ "$result" != pass ] && [ "$result" != violated ]; then
    grep -m3 -E 'Error|Deadlock|Exception' "$dir/tlc.out" | sed 's/^/    /'
  fi
done

# The sync commit is the last commit that changed coverage.json. Deriving it
# from git keeps it right after a squash merge, which rewrites branch commits.
SYNC=$(git -C "$REPO" log -1 --format=%H -- "$COVERAGE" 2>/dev/null || true)
echo
echo "Facts: $FACTS_LINE"
echo "       Collectable=$COLLECTABLE Terminal=$TERMINAL"
for name in current current-no-token; do
  case " $RUNS " in *" $name "*) ;; *) continue ;; esac
  echo "Distinct states of $name: $(sed -n 's/.* \([0-9]*\) distinct states found.*/\1/p' "$OUT/$name/tlc.out" | tail -1)."
done
echo "A violated run stops at its first violation."
echo "Sync commit (last change to coverage.json): ${SYNC:-none yet}"
echo "Results: $OUT"

drift=0
if [ -s "$OUT/drift.txt" ]; then
  drift=1
  echo
  echo "STALE: covered code changed since the last sync ($SYNC). Re-read each item,"
  echo "update the model if it no longer describes the code, then run with --update-coverage:"
  sed 's/^/  /' "$OUT/drift.txt"
fi
if [ -n "$SYNC" ] && git -C "$REPO" cat-file -e "$SYNC^{commit}" 2>/dev/null; then
  commits=$(git -C "$REPO" log --oneline "$SYNC..HEAD" -- src/host src/cli/commands/gc.ts \
    src/cli/commands/create.ts src/cli/commands/destroy.ts src/storage/manifests.ts \
    src/protocol/sessionStatusPolicy.ts)
  if [ -n "$commits" ]; then
    echo
    echo "Commits since the sync commit that touch covered folders:"
    echo "$commits" | sed 's/^/  /'
  fi
fi

if [ "$unexpected" -ne 0 ]; then
  exit 1
fi
if [ "$drift" -ne 0 ]; then
  exit 3
fi
echo
echo "All results as expected; covered code matches the sync record."
