#!/usr/bin/env bash
# Prepares one verification run of the agent-tty CLI from this checkout:
# installs deps if they are missing, builds dist/, and makes an isolated run
# folder. Prints the path of the run's env.sh; source it in every shell.
#
#   .agents/skills/verify-agent-tty/scripts/start-run.sh [name]
#
# Run folder: ${VERIFY_ROOT:-${TMPDIR:-/tmp}/verify-agent-tty}/<UTC time>-<name>-<pid>/
#   home/      AGENT_TTY_HOME for this run (cleanup removes it)
#   state/     XDG_STATE_HOME, so the Home Registry is private (cleanup removes it)
#   evidence/  proof artifacts (cleanup keeps it)
set -euo pipefail

SKILL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
REPO=$(git -C "$SKILL_DIR" rev-parse --show-toplevel)
NAME=${1:-run}
case "$NAME" in
  *[!A-Za-z0-9._-]*)
    echo "start-run.sh: name may only use letters, digits, '.', '_' and '-'" >&2
    exit 2
    ;;
esac
ROOT=${VERIFY_ROOT:-${TMPDIR:-/tmp}/verify-agent-tty}
RUN="$ROOT/$(date -u +%Y%m%dT%H%M%SZ)-$NAME-$$"
mkdir -p "$RUN/home" "$RUN/state" "$RUN/evidence"
# agent-tty resolves its Home to a real path, and the host processes carry
# that path. Use it here too, so run-pids.sh can match them.
RUN=$(cd "$RUN" && pwd -P)
cd "$REPO"

# A partial install leaves node_modules without .bin, and then `npm run build`
# fails with "tsc: not found".
if [ ! -x node_modules/.bin/tsc ]; then
  command -v aube >/dev/null 2>&1 || {
    echo "start-run.sh: node_modules is incomplete and aube is not on PATH; run 'mise install' first" >&2
    exit 2
  }
  echo "Installing dependencies (aube ci)" >&2
  aube ci >"$RUN/install.log" 2>&1 || {
    echo "start-run.sh: aube ci failed, see $RUN/install.log" >&2
    exit 2
  }
fi

build() {
  npm run build >"$RUN/build.log" 2>&1 || {
    echo "start-run.sh: npm run build failed, see $RUN/build.log" >&2
    exit 2
  }
}
stale_source() {
  find src -name '*.ts' -newer dist/cli/main.js | head -1
}
build
# A stale .tsconfig.build.tsbuildinfo makes tsc exit 0 and emit nothing.
if [ ! -f dist/cli/main.js ] || [ -n "$(stale_source)" ]; then
  echo "dist/ is older than src/; removing the incremental build info and rebuilding" >&2
  rm -f .tsconfig.build.tsbuildinfo
  rm -rf dist
  build
fi
[ -f dist/cli/main.js ] && [ -z "$(stale_source)" ] || {
  echo "start-run.sh: dist/cli/main.js is still older than src/" >&2
  exit 2
}

cat >"$RUN/env.sh" <<EOF
# Source this file in every shell of the run.
export VERIFY_RUN='$RUN'
export AGENT_TTY_HOME='$RUN/home'
export XDG_STATE_HOME='$RUN/state'
export EVIDENCE='$RUN/evidence'
export AGENT_TTY_REPO='$REPO'
# As test/setup-node-options.ts does: without it, Node 26 prints a DEP0205
# warning from tsx into every fixture app's screen, under its prompt.
export NODE_OPTIONS="\${NODE_OPTIONS:+\$NODE_OPTIONS }--disable-warning=DEP0205"
# The built CLI, exactly as the agent-tty bin in package.json runs it.
att() { node '$REPO/dist/cli/main.js' "\$@"; }
EOF
echo "$RUN/env.sh"
