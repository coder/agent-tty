You are running inside a temporary, disposable git workspace for an agent-tty dogfood proof.

Run the checked helper script below immediately. Do not inspect files first and do not explain the plan before running it.

The helper loads `agent-tty skills get agent-tty`, asserts the temp `agent-tty` binary, creates an isolated shell session, drives `nvim --clean -n demo-note.txt`, writes exactly `{{DEMO_SENTENCE}}`, verifies the file, exports the inner asciicast/WebM artifacts, and destroys the inner session.

```bash
bash "{{INNER_HELPER}}"
```

Use the installed `agent-tty` binary on PATH after prepending `{{AGENT_TTY_BIN_DIR}}`. Do not use repo-local `npx`, `tsx`, or `src/cli/main.ts` commands.

After the helper exits, report only whether it passed and list the three generated files: `{{FINAL_FILE}}`, `{{INNER_CAST}}`, and `{{INNER_WEBM}}`.
