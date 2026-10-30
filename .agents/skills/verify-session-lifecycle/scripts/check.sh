#!/usr/bin/env bash
# Model-check the agent-tty session lifecycle: create, the session host,
# reconcileSession, gc, and destroy, all acting on one session at the same
# time.
#
#   .agents/skills/verify-session-lifecycle/scripts/check.sh [--update-coverage]
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
# CHECK_OUT (keep the results in this folder), CHECK_JOBS (default 4).
set -euo pipefail

UPDATE_COVERAGE=0
for arg in "$@"; do
  case "$arg" in
    --update-coverage) UPDATE_COVERAGE=1 ;;
    *)
      echo "usage: $0 [--update-coverage]" >&2
      exit 2
      ;;
  esac
done

SKILL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
REPO=$(git -C "$SKILL_DIR" rev-parse --show-toplevel)
SPEC="$SKILL_DIR/model/SessionLifecycle.tla"
COVERAGE="$SKILL_DIR/coverage.json"
JAVA=${JAVA:-java}
JOBS=${CHECK_JOBS:-4}
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
command -v node >/dev/null 2>&1 || die "node is not on PATH"
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

OUT=${CHECK_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/session-lifecycle-check.XXXXXX")}
mkdir -p "$OUT"

# --- facts from the code -------------------------------------------------

node "$SKILL_DIR/scripts/facts.mjs" "$REPO" >"$OUT/facts.json" ||
  die "facts.mjs failed: a covered function moved or was renamed (see the error above)"

if [ "$UPDATE_COVERAGE" -eq 1 ]; then
  node -e '
    const fs = require("node:fs");
    const facts = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const record = { fingerprints: facts.fingerprints, callSites: facts.callSites };
    fs.writeFileSync(process.argv[2], JSON.stringify(record, null, 2) + "\n");
  ' "$OUT/facts.json" "$COVERAGE"
  echo "Rewrote $COVERAGE. Commit it only after you have confirmed that the model"
  echo "describes the code: that commit becomes the sync commit."
fi

# Prints one line per covered function or call site that changed.
node -e '
  const fs = require("node:fs");
  const facts = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const record = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
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

COLLECTABLE=$(node -e '
  const c = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).constants;
  console.log("{" + c.Collectable.map((s) => JSON.stringify(s)).join(", ") + "}");
' "$OUT/facts.json")
TERMINAL=$(node -e '
  const c = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).constants;
  console.log("{" + c.Terminal.map((s) => JSON.stringify(s)).join(", ") + "}");
' "$OUT/facts.json")
GUARDS="GcSkipsNonCollectable GcFinalCheck ReconcileSkipsTerminal ReconcileSkipsLiveHost CreateRecordsHostPid HostWaitsForManifest ReconcileRereads HostSerializesWrites HostStopsAfterTerminalWrite ShutdownChecksCommandable DestroyRecordsDestroyed DestroyKeepsExitCode KillsProgramGroup"
# One "Guard=TRUE|FALSE" word per guard, read from the code by facts.mjs.
FACTS_LINE=$(node -e '
  const c = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).constants;
  console.log(process.argv.slice(2).map((g) => {
    if (typeof c[g] !== "boolean") throw new Error(`facts.mjs gave no boolean for ${g}`);
    return `${g}=${c[g] ? "TRUE" : "FALSE"}`;
  }).join(" "));
' "$OUT/facts.json" $GUARDS) || die "facts.json lacks a guard fact"

RULES="NoLiveSessionDeleted HostDeathOnlyWhenDead TerminalIsFinal RecordedExitKept RunningSessionReachable HostStartsWhenCreated TerminalIsLastWrite DestroyedOnlyWhenEnded DestroyEndsDestroyed DestroyedProgramStopped"
WITNESSES="WitnessGcRemovesSession WitnessSessionServes WitnessResizeLands WitnessCleanExitRecorded WitnessCrashReconciled WitnessDestroyCompletes WitnessSigtermRecorded WitnessDestroyExitedSession WitnessForceDestroyRecorded WitnessProgramOutlivesHost"

# --- runs ----------------------------------------------------------------

# write_run NAME EXPECT "INVARIANTS" "GUARD=FALSE ..." NOTE [RULE]
# RULE: for an expected violation, the rule that TLC must report.
RUNS=""
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
write_run mutant-KillsProgramGroup violated DestroyedProgramStopped "KillsProgramGroup=FALSE" "with pid kills only, a process of the program outlives destroy" DestroyedProgramStopped
write_run mutant-ReconcileSkipsTerminal pass RecordedExitKept "ReconcileSkipsTerminal=FALSE" "redundant: the re-read returns on a terminal manifest"
write_run mutant-GcSkipsNonCollectable pass NoLiveSessionDeleted "GcSkipsNonCollectable=FALSE" "redundant: the final check still skips"
write_run mutant-GcFinalCheck pass NoLiveSessionDeleted "GcFinalCheck=FALSE" "redundant: the first check still skips"
write_run mutant-GcBothChecks violated NoLiveSessionDeleted "GcSkipsNonCollectable=FALSE GcFinalCheck=FALSE" "with neither gc check, gc removes live sessions" NoLiveSessionDeleted
write_run mutant-ShutdownChecksCommandable pass TerminalIsFinal "ShutdownChecksCommandable=FALSE" "redundant: the writer writes nothing after a terminal record"
write_run mutant-ShutdownBothChecks violated TerminalIsFinal "ShutdownChecksCommandable=FALSE HostStopsAfterTerminalWrite=FALSE" "with neither, shutdown writes destroying over an exit record" TerminalIsFinal

run_tlc() {
  local dir rc=0
  dir=$(cd "$OUT/$1" && pwd)
  mkdir -p "$dir/tmp"
  (cd "$dir" && "$JAVA" -XX:+UseParallelGC -Xmx2g -Djava.io.tmpdir="$dir/tmp" \
    -cp "$JAR" tlc2.TLC -workers 1 -config SessionLifecycle.cfg \
    -metadir "$dir/states" SessionLifecycle.tla >tlc.out 2>&1) || rc=$?
  echo "$rc" >"$dir/rc"
}

count=0
for name in $RUNS; do
  run_tlc "$name" &
  count=$((count + 1))
  if [ $((count % JOBS)) -eq 0 ]; then wait; fi
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
echo "Distinct states of the current model: $(sed -n 's/.* \([0-9]*\) distinct states found.*/\1/p' "$OUT/current/tlc.out" | tail -1). A violated run stops at its first violation."
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
