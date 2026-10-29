#!/usr/bin/env bash
# Answers "is this run worth driving?" for one verification run. It changes
# nothing outside the run's home: `agent-tty doctor` creates and removes one
# probe session there.
#
#   .agents/skills/verify-agent-tty/scripts/doctor.sh <run>/env.sh
set -uo pipefail

ENV_FILE=${1:?usage: doctor.sh <run>/env.sh}
# shellcheck source=/dev/null
. "$ENV_FILE"
fail=0
pass() { echo "pass  $*"; }
bad() {
  echo "FAIL  $*"
  fail=1
}

case "$AGENT_TTY_HOME" in
  "$VERIFY_RUN"/home) pass "home is this run's: $AGENT_TTY_HOME" ;;
  *) bad "AGENT_TTY_HOME is not $VERIFY_RUN/home: $AGENT_TTY_HOME" ;;
esac
[ "$AGENT_TTY_HOME" != "$HOME/.agent-tty" ] || bad "home is the real ~/.agent-tty"
case "$XDG_STATE_HOME" in
  "$VERIFY_RUN"/state) pass "Home Registry is private: $XDG_STATE_HOME" ;;
  *) bad "XDG_STATE_HOME is not $VERIFY_RUN/state" ;;
esac

cd "$AGENT_TTY_REPO" || exit 2
if [ ! -f dist/cli/main.js ]; then
  bad "dist/cli/main.js is missing: run start-run.sh again"
elif [ -n "$(find src \( -name '*.ts' -o -name '*.tsx' \) -newer dist/cli/main.js | head -1)" ]; then
  bad "dist/ is older than src/: run start-run.sh again to rebuild"
else
  pass "dist/ is newer than every file in src/"
fi

want=$(node -p "require('./package.json').version")
got=$(att version --json 2>/dev/null | jq -r '.result.cliVersion')
[ "$got" = "$want" ] && pass "cliVersion $got matches package.json" ||
  bad "cliVersion '$got' does not match package.json '$want'"

report=$(att doctor --json 2>/dev/null)
if [ "$(echo "$report" | jq -r '.result.ok')" = true ]; then
  pass "agent-tty doctor: every check passes"
else
  bad "agent-tty doctor reports failures:"
  echo "$report" | jq -r '.result.checks | to_entries[] | .value[] | select(.status != "pass") | "      \(.name): \(.status) \(.message)"'
fi

echo "sessions in this home: $(att list --all --json | jq -c '[.result.sessions[].status] | group_by(.) | map({(.[0]): length}) | add // {}')"
pids=$("$(dirname "${BASH_SOURCE[0]}")/run-pids.sh" "$ENV_FILE" | tr '\n' ' ')
echo "processes this run started (hosts and session programs): ${pids:-none}"
exit "$fail"
