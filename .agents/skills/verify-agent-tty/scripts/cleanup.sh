#!/usr/bin/env bash
# Tears down one verification run: destroys its sessions through the CLI,
# stops only the processes that run-pids.sh ties to this run, copies each
# session's files into evidence/sessions/, then removes home/ and state/.
# evidence/ stays. It keeps home/ and state/ and exits 1 when run-pids.sh
# fails, while a process outside the caller's terminal session still carries
# this run's AGENT_TTY_HOME or is yours, hides its environment and started
# after the run, or while any process but cleanup.sh, the processes that
# started it and its own children has its working directory or an open file in
# home/, state/ or removing/. It also exits 1 when the removal fails, or when a process
# that started during the removal still holds the run's folders.
#
#   .agents/skills/verify-agent-tty/scripts/cleanup.sh <run>/env.sh
set -uo pipefail

ENV_FILE=${1:?usage: cleanup.sh <run>/env.sh}
# shellcheck source=/dev/null
. "$ENV_FILE"
if [ "$AGENT_TTY_HOME" != "$VERIFY_RUN/home" ] || [ "$XDG_STATE_HOME" != "$VERIFY_RUN/state" ] ||
  [ "$EVIDENCE" != "$VERIFY_RUN/evidence" ]; then
  echo "cleanup.sh: refusing: AGENT_TTY_HOME, XDG_STATE_HOME and EVIDENCE must be home/, state/ and evidence/ of $VERIFY_RUN" >&2
  exit 2
fi

aside=$VERIFY_RUN/removing
present() { [ -e "$1" ] || [ -L "$1" ]; }
kept=""
for name in home state; do
  present "$VERIFY_RUN/$name" || ! present "$aside/$name" || mv "$aside/$name" "$VERIFY_RUN/" || {
    echo "cleanup.sh: could not move $aside/$name back to $VERIFY_RUN/. Fix the error above, then run cleanup.sh again." >&2
    exit 1
  }
  where="$name/"
  ! present "$aside/$name" || where="removing/$name/"
  kept="${kept:+$kept and }$where"
done

pids_failed=""
run_pids() {
  left=""
  [ -z "$pids_failed" ] || return 0
  left=$("$(dirname "${BASH_SOURCE[0]}")/run-pids.sh" "$ENV_FILE" | tr '\n' ' ') || {
    left=""
    pids_failed=1
  }
}
# `att list` reconciles, which clears childPid of a session whose host died.
# run-pids.sh records each childPid first, so it still finds their children.
run_pids
if [ -d "$AGENT_TTY_HOME/sessions" ]; then
  for id in $(att list --json 2>/dev/null | jq -r '.result.sessions[].sessionId'); do
    att destroy "$id" --json >/dev/null 2>&1 || att destroy "$id" --force --json >/dev/null 2>&1 ||
      echo "cleanup.sh: could not destroy $id" >&2
  done
fi

for _ in 1 2 3 4 5 6 7 8 9 10; do
  run_pids
  [ -z "$left" ] && break
  sleep 1
done
if [ -n "$left" ]; then
  echo "cleanup.sh: stopping processes of this run that outlived destroy: $left" >&2
  # shellcheck disable=SC2086
  kill -TERM $left 2>/dev/null
  sleep 2
  run_pids
  # shellcheck disable=SC2086
  [ -z "$left" ] || kill -KILL $left 2>/dev/null
fi
copy_sessions() {
  [ -d "$1" ] || return 0
  { mkdir -p "$2" && cp -R "$1/." "$2/"; } || {
    echo "cleanup.sh: could not copy $1 into $2; kept $kept" >&2
    exit 1
  }
}
copy_sessions "$AGENT_TTY_HOME/sessions" "$EVIDENCE/sessions"
copy_sessions "$aside/home/sessions" "$EVIDENCE/removing/sessions"

# Without /proc, run-pids.sh cannot see a live host behind a failed manifest,
# so removing home/ could delete the folder of a session that still runs.
if [ ! -d /proc/self ]; then
  echo "cleanup.sh: no /proc here, so it cannot confirm that every process of this run has ended; kept $kept." >&2
  echo "cleanup.sh: stop the processes with AGENT_TTY_HOME=$AGENT_TTY_HOME (see 'ps'), then remove $AGENT_TTY_HOME and $XDG_STATE_HOME." >&2
  exit 1
fi

session_of() {
  { sed 's/.*) //' "/proc/$1/stat"; } 2>/dev/null | cut -d' ' -f4
}
parent_of() {
  { sed 's/.*) //' "/proc/$1/stat"; } 2>/dev/null | cut -d' ' -f2
}
caller_session=$(session_of $$)
# A pid reused during a walk can make the parents loop, so a walk stops after
# max_hops parents, and the parents it did not reach count as not ours.
max_hops=1024
own_ancestors=" $$ "
pid=$(parent_of $$)
hops=0
while [ -n "$pid" ] && [ "$pid" -gt 1 ] && [ "$hops" -lt "$max_hops" ]; do
  own_ancestors="$own_ancestors$pid "
  pid=$(parent_of "$pid")
  hops=$((hops + 1))
done
is_own_ancestor() {
  case "$own_ancestors" in *" $1 "*) return 0 ;; esac
  return 1
}
# As pid 1, cleanup.sh counts no process as its own child: pid 1 also adopts
# orphans, so a parent walk cannot tell its children from an adopted process.
is_own_descendant() {
  local walk=$1 hops=0
  while [ -n "$walk" ] && [ "$walk" -gt 1 ] && [ "$hops" -lt "$max_hops" ]; do
    [ "$walk" = "$$" ] && return 0
    walk=$(parent_of "$walk")
    hops=$((hops + 1))
  done
  return 1
}
add_holder() {
  case "$holder_pids" in *" $1 "*) return ;; esac
  args=$({ tr '\0' ' ' <"/proc/$1/cmdline"; } 2>/dev/null)
  [ -z "$args" ] || {
    holders="$holders  $1 $args$2"$'\n'
    holder_pids="$holder_pids$1 "
  }
}
# The kernel hides /proc/<pid>/environ of your own setuid programs, of
# programs with more capabilities than you, and of non-dumpable ones
# (prctl PR_SET_DUMPABLE 0).
uid=$(id -u)
boot=$(sed -n 's/^btime //p' /proc/stat)
ticks=$(getconf CLK_TCK)
named=$(basename "$VERIFY_RUN" | sed -nE 's/^([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z-.*/\1-\2-\3 \4:\5:\6 UTC/p')
named=$([ -n "$named" ] && date -d "$named" +%s 2>/dev/null) || named=""
born=$(stat -c %W "$VERIFY_RUN" 2>/dev/null)
case "$born" in '' | 0 | *[!0-9]*) born="" ;; esac
run_started=${named:-${born:-0}}
[ -z "$born" ] || [ "$born" -ge "$run_started" ] || run_started=$born
rounding_slack_s=2
started_after_run() {
  start=$({ sed 's/.*) //' "/proc/$1/stat"; } 2>/dev/null | cut -d' ' -f20)
  [ -n "$start" ] && [ $((boot + start / ticks)) -ge $((run_started - rounding_slack_s)) ]
}
run_real=$(cd "$VERIFY_RUN" && pwd -P)
path_tests=()
for dir in "$run_real/home" "$run_real/state" "$run_real/removing"; do
  pattern=$(printf '%s' "$dir" | sed 's/[][*?\\]/\\&/g')
  path_tests+=(-o -lname "$pattern" -o -lname "$pattern/*" -o -lname "$pattern (deleted)")
done
find_holders() {
  holders=""
  holder_pids=" "
  for file in $(grep -lzxF "AGENT_TTY_HOME=$AGENT_TTY_HOME" /proc/[0-9]*/environ 2>/dev/null); do
    pid=${file#/proc/}
    pid=${pid%/environ}
    [ "$(session_of "$pid")" = "$caller_session" ] || add_holder "$pid" " (carries this run's AGENT_TTY_HOME, outside your terminal session)"
  done
  for file in /proc/[0-9]*/environ; do
    { : <"$file"; } 2>/dev/null && continue
    pid=${file#/proc/}
    pid=${pid%/environ}
    owner=$(awk '/^Uid:/ { print $2; exit }' "/proc/$pid/status" 2>/dev/null)
    [ "$owner" = "$uid" ] && started_after_run "$pid" &&
      [ "$(session_of "$pid")" != "$caller_session" ] && add_holder "$pid" " (hides its environment, started after the run, outside your terminal session)"
  done
  for pid in $(find /proc/[0-9]*/cwd /proc/[0-9]*/fd -maxdepth 1 \( -false "${path_tests[@]}" \) 2>/dev/null | cut -d/ -f3 | sort -un); do
    is_own_ancestor "$pid" || is_own_descendant "$pid" || add_holder "$pid" " (uses a path in the run)"
  done
}
keep_home() {
  [ -z "$pids_failed" ] || echo "cleanup.sh: run-pids.sh failed, so cleanup.sh cannot prove that every process of this run has ended. Fix what run-pids.sh reports." >&2
  [ -z "$holders" ] || printf 'cleanup.sh: these processes still hold the run (AGENT_TTY_HOME=%s). Stop them (kill <pid>) or let them end:\n%s' "$AGENT_TTY_HOME" "$holders" >&2
  echo "cleanup.sh: kept $kept. Then run cleanup.sh again." >&2
  exit 1
}
# The scans below run as children of cleanup.sh. Leave the run's folders, so
# they do not hold a path in it through the working directory they inherit.
cd / || exit 1
find_holders
[ -z "$pids_failed$holders" ] || keep_home

# The socket folder is /tmp/agent-tty/<first 8 hex of sha256(home)>.
sockets="/tmp/agent-tty/$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:path").resolve(process.argv[1])).digest("hex").slice(0, 8))' "$AGENT_TTY_HOME")"

removal_failed() {
  echo "cleanup.sh: could not $1. Fix the error above, then run cleanup.sh again." >&2
  exit 1
}
{ rm -rf "$aside" && mkdir "$aside"; } || removal_failed "make an empty $aside"
for name in home state; do
  ! present "$VERIFY_RUN/$name" || mv "$VERIFY_RUN/$name" "$aside/" || removal_failed "move $name/ into $aside"
done
find_holders
if [ -n "$holders" ]; then
  kept=""
  for name in home state; do
    where="$name/"
    if ! present "$aside/$name"; then
      :
    elif present "$VERIFY_RUN/$name"; then
      echo "cleanup.sh: a process made a new $name/, so the run's own $name/ is in $aside" >&2
      where="removing/$name/"
    elif ! mv "$aside/$name" "$VERIFY_RUN/"; then
      echo "cleanup.sh: could not move $aside/$name back to $VERIFY_RUN/, so the run's $name/ is in $aside" >&2
      where="removing/$name/"
    fi
    kept="${kept:+$kept and }$where"
  done
  rmdir "$aside" 2>/dev/null
  keep_home
fi
rm -rf "$aside" || removal_failed "remove $aside"
find_holders
if [ -n "$holders" ] || present "$AGENT_TTY_HOME" || present "$XDG_STATE_HOME"; then
  printf 'cleanup.sh: removed the old home/ and state/, but a process that started meanwhile carries AGENT_TTY_HOME=%s, used a path in the run, or made a new home/ or state/:\n%s' "$AGENT_TTY_HOME" "$holders" >&2
  echo "cleanup.sh: stop it, then run cleanup.sh again." >&2
  exit 1
fi
[ -d "$sockets" ] && rmdir "$sockets" 2>/dev/null
echo "Removed the run's home and state. Evidence kept in: $EVIDENCE"
