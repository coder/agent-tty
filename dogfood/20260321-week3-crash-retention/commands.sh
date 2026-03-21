#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
if command -v mise >/dev/null 2>&1; then
  mise_shell_env="$(mise activate bash 2>/dev/null || true)"
  if [[ -n "$mise_shell_env" ]]; then
    eval "$mise_shell_env"
  fi
  mise_node="$(mise which node 2>/dev/null || true)"
  if [[ -n "$mise_node" ]]; then
    export PATH="$(dirname "$mise_node"):$PATH"
  fi
fi
cd /home/coder/.mux/src/agent-terminal/agent_exec_7c2a453166
export PATH="/home/coder/.mux/src/agent-terminal/agent_exec_7c2a453166/node_modules/.bin:$PATH"
export AGENT_TERMINAL_HOME=/tmp/agent-terminal-week3-bundles.Bo0MbU/home.KGOAC6

tsx src/cli/main.ts doctor --json 
tsx src/cli/main.ts create --json -- /bin/bash -lc echo\ crash-test-output\ \&\&\ exit\ 42 
tsx src/cli/main.ts wait 01KM95Z3QSQKN28SVD03BP28Z2 --exit --timeout 20000 --json 
tsx src/cli/main.ts inspect 01KM95Z3QSQKN28SVD03BP28Z2 --json 
tsx src/cli/main.ts snapshot 01KM95Z3QSQKN28SVD03BP28Z2 --json 
tsx src/cli/main.ts screenshot 01KM95Z3QSQKN28SVD03BP28Z2 --json 
tsx src/cli/main.ts record export 01KM95Z3QSQKN28SVD03BP28Z2 --format asciicast --out dogfood/20260321-week3-crash-retention/artifacts/session-post-crash.cast --json 
tsx src/cli/main.ts record export 01KM95Z3QSQKN28SVD03BP28Z2 --format webm --out dogfood/20260321-week3-crash-retention/artifacts/session-post-crash.webm --json 
