You are running inside a temporary, disposable git workspace for an agent-tty dogfood proof.

Run the checked helper script below immediately. Do not inspect files first and do not explain the plan before running it.

The helper loads `agent-tty skills get agent-tty`, asserts the temp `agent-tty` binary, creates an isolated shell session, drives `nvim --clean -n demo-note.txt`, writes exactly `agent-tty nested Neovim proof from an AI coding agent.`, verifies the file, exports the inner asciicast/WebM artifacts, and destroys the inner session.

```bash
bash "/var/folders/pq/ft6166r921ddfcph0dyg4skc0000gn/T/agent-uses-agent-tty.XXXXXX.schsAgakaz/workspaces/codex/run-inner-nvim-proof.sh"
```

Use the installed `agent-tty` binary on PATH after prepending `/var/folders/pq/ft6166r921ddfcph0dyg4skc0000gn/T/agent-uses-agent-tty.XXXXXX.schsAgakaz/install/bin`. Do not use repo-local `npx`, `tsx`, or `src/cli/main.ts` commands.

After the helper exits, report only whether it passed and list the three generated files: `/var/folders/pq/ft6166r921ddfcph0dyg4skc0000gn/T/agent-uses-agent-tty.XXXXXX.schsAgakaz/workspaces/codex/demo-note.txt`, `/var/folders/pq/ft6166r921ddfcph0dyg4skc0000gn/T/agent-uses-agent-tty.XXXXXX.schsAgakaz/workspaces/codex/artifacts/inner-nvim.cast`, and `/var/folders/pq/ft6166r921ddfcph0dyg4skc0000gn/T/agent-uses-agent-tty.XXXXXX.schsAgakaz/workspaces/codex/artifacts/inner-nvim.webm`.
