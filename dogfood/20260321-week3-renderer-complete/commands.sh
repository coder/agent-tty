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
export AGENT_TERMINAL_HOME=/tmp/agent-terminal-week3-bundles.Bo0MbU/home.8BRlbs

tsx src/cli/main.ts doctor --json 
tsx src/cli/main.ts create --json -- /bin/sh -lc printf\ \"Loading\\n\"\;\ sleep\ 1\;\ printf\ \"3\ items\\n\"\;\ sleep\ 1\;\ printf\ \"Ready\\n\"\;\ exec\ cat 
tsx src/cli/main.ts wait 01KM95Y7RFQZ11N60DR204NK1T --text Ready --timeout 20000 --json 
tsx src/cli/main.ts type 01KM95Y7RFQZ11N60DR204NK1T week3\ renderer\ bundle --json 
tsx src/cli/main.ts wait 01KM95Y7RFQZ11N60DR204NK1T --regex week3\ renderer\ bundle --timeout 20000 --json 
tsx src/cli/main.ts snapshot 01KM95Y7RFQZ11N60DR204NK1T --json 
tsx src/cli/main.ts snapshot 01KM95Y7RFQZ11N60DR204NK1T --format text --json 
tsx src/cli/main.ts screenshot 01KM95Y7RFQZ11N60DR204NK1T --json 
tsx src/cli/main.ts screenshot 01KM95Y7RFQZ11N60DR204NK1T --profile reference-light --json 
tsx src/cli/main.ts record export 01KM95Y7RFQZ11N60DR204NK1T --format asciicast --out dogfood/20260321-week3-renderer-complete/artifacts/session-live.cast --json 
tsx src/cli/main.ts destroy 01KM95Y7RFQZ11N60DR204NK1T --json 
tsx src/cli/main.ts snapshot 01KM95Y7RFQZ11N60DR204NK1T --json 
tsx src/cli/main.ts screenshot 01KM95Y7RFQZ11N60DR204NK1T --json 
tsx src/cli/main.ts record export 01KM95Y7RFQZ11N60DR204NK1T --format webm --out dogfood/20260321-week3-renderer-complete/artifacts/session-post-exit.webm --json 
