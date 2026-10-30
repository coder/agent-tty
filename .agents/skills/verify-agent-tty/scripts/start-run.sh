#!/usr/bin/env bash
# Prepares one verification run of the agent-tty CLI from this checkout:
# brings deps up to date with aube-lock.yaml, builds dist/, and makes an
# isolated run folder. Prints the path of the run's env.sh; source it in
# every shell.
#
#   .agents/skills/verify-agent-tty/scripts/start-run.sh [name]
#
# Run folder: ${VERIFY_ROOT:-${TMPDIR:-/tmp}/verify-agent-tty-<uid>}/<UTC time>-<name>-<random>/
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
ROOT=${VERIFY_ROOT:-${TMPDIR:-/tmp}/verify-agent-tty-$(id -u)}
# In a shared /tmp another user could plant this path first, so the root
# must be a real directory that only you own and can write.
mkdir -p "$ROOT"
if [ -L "$ROOT" ] || [ ! -d "$ROOT" ] || [ ! -O "$ROOT" ]; then
  echo "start-run.sh: $ROOT must be a directory that you own, not a symlink" >&2
  exit 2
fi
chmod 700 "$ROOT"
RUN=$(mktemp -d "$ROOT/$(date -u +%Y%m%dT%H%M%SZ)-$NAME-XXXXXX")
mkdir "$RUN/home" "$RUN/state" "$RUN/evidence"
# agent-tty resolves its Home to a real path, and the host processes carry
# that path. Use it here too, so run-pids.sh can match them.
RUN=$(cd "$RUN" && pwd -P)
cd "$REPO"

command -v aube >/dev/null 2>&1 || {
  echo "start-run.sh: aube is not on PATH; run 'mise install' first" >&2
  exit 2
}
# A partial install leaves node_modules without .bin, and then `npm run build`
# fails with "tsc: not found": only a clean install repairs that. Otherwise
# bring node_modules up to date with aube-lock.yaml, so a run after a
# dependency change does not build and run the old packages. aube returns
# quickly when nothing changed.
if [ ! -x node_modules/.bin/tsc ]; then
  echo "Installing dependencies (aube ci)" >&2
  aube ci >"$RUN/install.log" 2>&1 || {
    echo "start-run.sh: aube ci failed, see $RUN/install.log" >&2
    exit 2
  }
else
  aube install --frozen-lockfile >"$RUN/install.log" 2>&1 || {
    echo "start-run.sh: aube install --frozen-lockfile failed, see $RUN/install.log" >&2
    exit 2
  }
fi

build() {
  npm run build >"$RUN/build.log" 2>&1 || {
    echo "start-run.sh: npm run build failed, see $RUN/build.log" >&2
    exit 2
  }
}
build
# A stale .tsconfig.build.tsbuildinfo makes tsc exit 0 and emit nothing.
stale=$("$SKILL_DIR/scripts/stale-dist.sh")
if [ -n "$stale" ]; then
  echo "dist/ is stale ($stale); removing the incremental build info and rebuilding" >&2
  rm -f .tsconfig.build.tsbuildinfo
  rm -rf dist
  build
fi
stale=$("$SKILL_DIR/scripts/stale-dist.sh")
[ -z "$stale" ] || {
  echo "start-run.sh: dist/ is still stale after a clean build: $stale" >&2
  exit 2
}

q() { printf '%q' "$1"; }
{
  echo "# Source this file in every shell of the run."
  echo "export VERIFY_RUN=$(q "$RUN")"
  echo "export AGENT_TTY_HOME=$(q "$RUN/home")"
  echo "export XDG_STATE_HOME=$(q "$RUN/state")"
  echo "export EVIDENCE=$(q "$RUN/evidence")"
  echo "export AGENT_TTY_REPO=$(q "$REPO")"
  echo "# As test/setup-node-options.ts does: without it, Node 26 prints a DEP0205"
  echo "# warning from tsx into every fixture app's screen, under its prompt."
  echo 'export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--disable-warning=DEP0205"'
  echo "# A recipe pipes envelopes through tee; keep the CLI's exit status."
  echo "set -o pipefail"
  echo "# The built CLI, exactly as the agent-tty bin in package.json runs it."
  echo "att() { node $(q "$REPO/dist/cli/main.js") \"\$@\"; }"
} >"$RUN/env.sh"
echo "$RUN/env.sh"
