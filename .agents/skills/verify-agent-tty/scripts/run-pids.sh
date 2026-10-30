#!/usr/bin/env bash
# Prints the PIDs of the processes that one verification run started: the
# session hosts (argv `_host`, environment AGENT_TTY_HOME=<run home>) and the
# programs in its sessions and their children (environment
# AGENT_TTY_HOME=<run home> in the terminal session of a program that a
# session.json of the run records as childPid, or environment
# AGENT_TTY_SESSION_ID=<a session of the run home>). Processes in the caller's
# own terminal session, such as your shells that sourced env.sh and
# cleanup.sh, are not in the list. Linux only: it reads /proc.
#
# It appends each recorded childPid to <run>/child-pids, because reconcile
# clears childPid from session.json when it finds a dead host, and the
# program's children can outlive it. It misses a daemon that a program with
# its own AGENT_TTY_SESSION_ID starts in a new terminal session.
#
#   .agents/skills/verify-agent-tty/scripts/run-pids.sh <run>/env.sh
set -uo pipefail

ENV_FILE=${1:?usage: run-pids.sh <run>/env.sh}
# shellcheck source=/dev/null
. "$ENV_FILE"
[ -d /proc/self ] || {
  echo "run-pids.sh: no /proc here; check 'ps' for AGENT_TTY_HOME=$AGENT_TTY_HOME" >&2
  exit 2
}

# The session ID is field 6 of /proc/<pid>/stat. Count from the end of the
# command name in parentheses, because the name can contain spaces.
session_of() {
  { sed 's/.*) //' "/proc/$1/stat"; } 2>/dev/null | cut -d' ' -f4
}
caller_session=$(session_of $$)

# Each session program leads its own terminal session (forkpty), so its
# children share its PID as their session ID. Any process can copy the run's
# environment, but only the host's PTY gives it such a session.
ledger=$VERIFY_RUN/child-pids
for manifest in "$AGENT_TTY_HOME"/sessions/*/session.json; do
  [ -f "$manifest" ] && jq -r '.childPid // empty' "$manifest" 2>/dev/null
done >>"$ledger"
program_sessions="|$(grep -E '^[0-9]+$' "$ledger" | sort -un | tr '\n' '|')"

ids=""
for dir in "$AGENT_TTY_HOME"/sessions/*/; do
  id=$(basename "$dir")
  # Session IDs are ULIDs. Skip doctor probe folders and an unmatched glob.
  case "$id" in '' | *[!0-9A-Z]*) continue ;; esac
  ids="${ids:+$ids|}$id"
done
{
  for file in $(grep -lzxF "AGENT_TTY_HOME=$AGENT_TTY_HOME" /proc/[0-9]*/environ 2>/dev/null); do
    dir=${file%/environ}
    pid=${dir#/proc/}
    if { tr '\0' ' ' <"$dir/cmdline"; } 2>/dev/null | grep -q ' _host '; then
      echo "$pid"
    else
      case "$program_sessions" in *"|$(session_of "$pid")|"*) echo "$pid" ;; esac
    fi
  done
  if [ -n "$ids" ]; then
    grep -lzxE "AGENT_TTY_SESSION_ID=($ids)" /proc/[0-9]*/environ 2>/dev/null |
      sed 's#^/proc/##; s#/environ$##'
  fi
} | sort -un | while read -r pid; do
  # Hosts and PTY programs call setsid, so no run process is in the caller's
  # session. Skip it, so cleanup.sh never stops itself.
  [ "$(session_of "$pid")" != "$caller_session" ] || continue
  # /proc files report size 0, so read the command line to see if it is live.
  [ -n "$({ tr -d '\0' <"/proc/$pid/cmdline"; } 2>/dev/null)" ] && echo "$pid"
done
exit 0
