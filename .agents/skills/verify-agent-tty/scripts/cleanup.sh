#!/usr/bin/env bash
# Tears down one verification run: destroys its sessions through the CLI,
# stops only the processes that run-pids.sh ties to this run, copies each
# session's files into evidence/sessions/, then removes home/ and state/.
# evidence/ stays. It keeps home/ and state/ and exits 1 when run-pids.sh
# fails, or while a process outside the caller's terminal session still
# carries this run's AGENT_TTY_HOME. It also exits 1 when the removal fails, or
# when a process that started during the removal still carries it.
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
if [ -d "$AGENT_TTY_HOME/sessions" ]; then
  { mkdir -p "$EVIDENCE/sessions" && cp -R "$AGENT_TTY_HOME/sessions/." "$EVIDENCE/sessions/"; } || {
    echo "cleanup.sh: could not copy the sessions into $EVIDENCE/sessions; kept home/ and state/" >&2
    exit 1
  }
fi

# Without /proc, run-pids.sh cannot see a live host behind a failed manifest,
# so removing home/ could delete the folder of a session that still runs.
if [ ! -d /proc/self ]; then
  echo "cleanup.sh: no /proc here, so it cannot confirm that every process of this run has ended; kept home/ and state/." >&2
  echo "cleanup.sh: stop the processes with AGENT_TTY_HOME=$AGENT_TTY_HOME (see 'ps'), then remove $AGENT_TTY_HOME and $XDG_STATE_HOME." >&2
  exit 1
fi

session_of() {
  { sed 's/.*) //' "/proc/$1/stat"; } 2>/dev/null | cut -d' ' -f4
}
caller_session=$(session_of $$)
find_holders() {
  holders=""
  for file in $(grep -lzxF "AGENT_TTY_HOME=$AGENT_TTY_HOME" /proc/[0-9]*/environ 2>/dev/null); do
    pid=${file#/proc/}
    pid=${pid%/environ}
    args=$({ tr '\0' ' ' <"/proc/$pid/cmdline"; } 2>/dev/null)
    [ -z "$args" ] || [ "$(session_of "$pid")" = "$caller_session" ] || holders="$holders  $pid $args"$'\n'
  done
}
keep_home() {
  [ -z "$pids_failed" ] || echo "cleanup.sh: run-pids.sh failed, so cleanup.sh cannot prove that every process of this run has ended. Fix what run-pids.sh reports." >&2
  [ -z "$holders" ] || printf 'cleanup.sh: these processes outside your terminal session still carry AGENT_TTY_HOME=%s. Stop them (kill <pid>) or let them end:\n%s' "$AGENT_TTY_HOME" "$holders" >&2
  echo "cleanup.sh: kept home/ and state/. Then run cleanup.sh again." >&2
  exit 1
}
find_holders
[ -z "$pids_failed$holders" ] || keep_home

# The socket folder is /tmp/agent-tty/<first 8 hex of sha256(home)>.
sockets="/tmp/agent-tty/$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:path").resolve(process.argv[1])).digest("hex").slice(0, 8))' "$AGENT_TTY_HOME")"

aside=$VERIFY_RUN/removing
removal_failed() {
  echo "cleanup.sh: could not $1. Fix the error above, then run cleanup.sh again." >&2
  exit 1
}
{ rm -rf "$aside" && mkdir "$aside"; } || removal_failed "make an empty $aside"
for name in home state; do
  [ ! -e "$VERIFY_RUN/$name" ] || mv "$VERIFY_RUN/$name" "$aside/" || removal_failed "move $name/ into $aside"
done
find_holders
if [ -n "$holders" ]; then
  for name in home state; do
    [ -e "$VERIFY_RUN/$name" ] || [ ! -e "$aside/$name" ] || mv "$aside/$name" "$VERIFY_RUN/"
  done
  rmdir "$aside" 2>/dev/null ||
    echo "cleanup.sh: a process made a new home/ or state/, so the run's own copies are in $aside" >&2
  keep_home
fi
rm -rf "$aside" || removal_failed "remove $aside"
find_holders
if [ -n "$holders" ] || [ -e "$AGENT_TTY_HOME" ] || [ -e "$XDG_STATE_HOME" ]; then
  printf 'cleanup.sh: removed the old home/ and state/, but a process that started meanwhile carries AGENT_TTY_HOME=%s or made a new home/ or state/:\n%s' "$AGENT_TTY_HOME" "$holders" >&2
  echo "cleanup.sh: stop it, then run cleanup.sh again." >&2
  exit 1
fi
[ -d "$sockets" ] && rmdir "$sockets" 2>/dev/null
echo "Removed the run's home and state. Evidence kept in: $EVIDENCE"
