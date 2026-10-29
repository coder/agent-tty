#!/usr/bin/env bash
# Prints the PIDs of the processes that one verification run started: the
# session hosts (argv `_host`, environment AGENT_TTY_HOME=<run home>) and the
# programs in its sessions and their children (environment
# AGENT_TTY_SESSION_ID=<a session of the run home>). Your own shells that
# sourced env.sh are not in the list. Linux only: it reads /proc.
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
    { tr '\0' ' ' <"$dir/cmdline"; } 2>/dev/null | grep -q ' _host ' && echo "${dir#/proc/}"
  done
  if [ -n "$ids" ]; then
    grep -lzxE "AGENT_TTY_SESSION_ID=($ids)" /proc/[0-9]*/environ 2>/dev/null |
      sed 's#^/proc/##; s#/environ$##'
  fi
} | sort -un | while read -r pid; do
  # Skip this script and processes that ended during the scan.
  [ "$pid" != "$$" ] || continue
  # /proc files report size 0, so read the command line to see if it is live.
  [ -n "$({ tr -d '\0' <"/proc/$pid/cmdline"; } 2>/dev/null)" ] && echo "$pid"
done
exit 0
