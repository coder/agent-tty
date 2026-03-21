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
export AGENT_TERMINAL_HOME=/tmp/agent-terminal-week3-bundles.Bo0MbU/home.Ubuxel

tsx src/cli/main.ts create --json -- /bin/sh -lc printf\ \"gc-temp\\n\"\;\ exec\ cat 
tsx src/cli/main.ts destroy 01KM95YX5WZBJ570QW3AMD1RJT --json 
tsx src/cli/main.ts gc --dry-run --json 
tsx src/cli/main.ts gc --json 
tsx src/cli/main.ts list --all --json 
