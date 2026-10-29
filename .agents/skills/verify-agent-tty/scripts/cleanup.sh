#!/usr/bin/env bash
# Tears down one verification run: destroys its sessions through the CLI,
# stops only the processes that carry this run's AGENT_TTY_HOME, copies each
# session's files into evidence/sessions/, then removes home/ and state/.
# evidence/ stays.
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

if [ -d "$AGENT_TTY_HOME/sessions" ]; then
  for id in $(att list --json 2>/dev/null | jq -r '.result.sessions[].sessionId'); do
    att destroy "$id" --json >/dev/null 2>&1 || att destroy "$id" --force --json >/dev/null 2>&1 ||
      echo "cleanup.sh: could not destroy $id" >&2
  done
fi

run_pids() {
  "$(dirname "${BASH_SOURCE[0]}")/run-pids.sh" "$ENV_FILE" 2>/dev/null
}
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -z "$(run_pids)" ] && break
  sleep 1
done
left=$(run_pids | tr '\n' ' ')
if [ -n "$left" ]; then
  echo "cleanup.sh: stopping processes of this run that outlived destroy: $left" >&2
  # shellcheck disable=SC2086
  kill -TERM $left 2>/dev/null
  sleep 2
  left=$(run_pids | tr '\n' ' ')
  # shellcheck disable=SC2086
  [ -z "$left" ] || kill -KILL $left 2>/dev/null
fi
[ -d /proc/self ] || echo "cleanup.sh: no /proc here; check 'ps' for processes with AGENT_TTY_HOME=$AGENT_TTY_HOME" >&2

if [ -d "$AGENT_TTY_HOME/sessions" ]; then
  mkdir -p "$EVIDENCE/sessions"
  cp -R "$AGENT_TTY_HOME/sessions/." "$EVIDENCE/sessions/"
fi

# The socket folder is /tmp/agent-tty/<first 8 hex of sha256(home)>.
sockets="/tmp/agent-tty/$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:path").resolve(process.argv[1])).digest("hex").slice(0, 8))' "$AGENT_TTY_HOME")"
[ -d "$sockets" ] && rmdir "$sockets" 2>/dev/null

rm -rf "$AGENT_TTY_HOME" "$XDG_STATE_HOME"
echo "Removed the run's home and state. Evidence kept in: $EVIDENCE"
