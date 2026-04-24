# Usage

`agent-tty` is designed around isolated homes, JSON envelopes, observable waits, semantic snapshots, and renderer-backed artifacts.
Use public `agent-tty ...` commands in user-facing docs and automation; when developing inside this source tree, translate examples locally to `npx tsx src/cli/main.ts ...`.

## Core Workflow

```bash
AGENT_HOME="$(mktemp -d)"
agent-tty --home "$AGENT_HOME" doctor --json

SESSION_ID=$(agent-tty --home "$AGENT_HOME" create --json -- /bin/bash | jq -r '.result.sessionId')
agent-tty --home "$AGENT_HOME" run "$SESSION_ID" 'printf "ready\n"' --json
agent-tty --home "$AGENT_HOME" wait "$SESSION_ID" --text 'ready' --json
agent-tty --home "$AGENT_HOME" snapshot "$SESSION_ID" --format text --json
agent-tty --home "$AGENT_HOME" screenshot "$SESSION_ID" --json
agent-tty --home "$AGENT_HOME" record export "$SESSION_ID" --format webm --json
agent-tty --home "$AGENT_HOME" destroy "$SESSION_ID" --json
```

Recommended sequence:

1. Create an isolated home with `--home`.
2. Run `doctor --json` before screenshot or recording workflows.
3. Create a session with `create --json`.
4. Use `run` for shell setup and multiline bootstrap commands.
5. Use `wait` for observable terminal state instead of blind sleeps.
6. Use `snapshot` for semantic inspection.
7. Use `screenshot` or `record export` for reviewer-facing artifacts.
8. Destroy the session when the workflow is done.

## Essential Commands

```bash
# Environment and skills
agent-tty version --json
agent-tty --home <path> doctor --json
agent-tty skills list
agent-tty skills get agent-tty

# Lifecycle
agent-tty --home <path> create --json -- /bin/bash
agent-tty --home <path> list --json
agent-tty --home <path> inspect <session-id> --json
agent-tty --home <path> destroy <session-id> --json
agent-tty --home <path> gc --json

# In-session control
agent-tty --home <path> run <session-id> 'command here' --json
agent-tty --home <path> type <session-id> 'literal text' --json
agent-tty --home <path> paste <session-id> 'multiline payload' --json
agent-tty --home <path> send-keys <session-id> Enter Ctrl+C --json
agent-tty --home <path> resize <session-id> --cols 100 --rows 30 --json
agent-tty --home <path> signal <session-id> SIGTERM --json

# Observation and proof
agent-tty --home <path> wait <session-id> --text 'ready' --json
agent-tty --home <path> wait <session-id> --screen-stable-ms 1000 --json
agent-tty --home <path> snapshot <session-id> --format text --json
agent-tty --home <path> screenshot <session-id> --json
agent-tty --home <path> record export <session-id> --format asciicast --json
agent-tty --home <path> record export <session-id> --format webm --json
```

## `run`

Use `run` when you want shell-oriented setup inside an existing session, especially multiline bootstrap scripts or commands that should preserve shell state.

```bash
agent-tty run <session-id> [command]
agent-tty run <session-id> --file ./setup.sh
agent-tty run <session-id> 'npm install && npm test' --timeout 60000 --json
agent-tty run <session-id> 'npm run dev' --no-wait
```

Important flags:

- `--timeout <ms>`: wait timeout in milliseconds. Default: `30000`.
- `--no-wait`: fire-and-forget mode. The command is injected and the CLI returns without waiting for completion.
- `--file <path>`: read command text from a file instead of the positional argument.
- `--json`: emit a machine-readable command envelope.

Use `type` when the target application needs literal interactive typing, `paste` when the target should receive a literal pasted payload, and `send-keys` for discrete control keys such as `Enter`, `Escape`, or `Ctrl+C`.
`run` is not structured output capture and does not report the child command's exit status.

## `wait`

Use `wait` to synchronize on terminal state:

```bash
agent-tty wait <session-id> --text 'ready' --json
agent-tty wait <session-id> --regex 'READY|DONE' --json
agent-tty wait <session-id> --screen-stable-ms 1000 --json
agent-tty wait <session-id> --idle-ms 500 --json
agent-tty wait <session-id> --exit --json
```

Useful flags:

- `--text <string>`: wait for text to appear in rendered output.
- `--regex <pattern>`: wait for a regex match in rendered output.
- `--screen-stable-ms <ms>`: wait for the rendered screen to be stable.
- `--idle-ms <ms>`: wait for output idleness.
- `--exit`: wait for the process to exit.
- `--timeout <ms>`: maximum wait time in milliseconds, with `0` meaning infinite.

## Screenshots And Recording Exports

Screenshots and WebM export use the `ghostty-web` reference renderer through Playwright/Chromium.
Run `doctor --json` first in new environments.

```bash
agent-tty screenshot <session-id> --profile reference-dark --json
agent-tty screenshot <session-id> --show-cursor --json
agent-tty record export <session-id> --format asciicast --out ./session.cast --json
agent-tty record export <session-id> --format webm --timing accelerated --out ./session.webm --json
```

`ghostty-web` provides reference visual truth for reviewable artifacts; it does not promise exact pixel parity with native terminals.

## Isolation

`--home <path>` stores manifests, sockets, event logs, and artifacts under an isolated agent-tty home.
Pass the same `--home` value to every command in a workflow.

For tests and automation, prefer an absolute temp directory:

```bash
AGENT_HOME="$(mktemp -d)"
agent-tty --home "$AGENT_HOME" doctor --json
```

Avoid writing automated sessions into the default `~/.agent-tty` unless you intentionally want shared local state.

## Anti-Patterns

- Do not reach for `tmux`, `screen`, or ad hoc PTY wrappers first when `agent-tty` can provide an isolated, inspectable session.
- Do not rely on blind `sleep` calls when `wait --text`, `wait --idle-ms`, or `wait --screen-stable-ms` can observe readiness.
- Do not scrape human-readable output when `--json` is available.
- Do not use external screenshot tools as the primary proof path when `agent-tty screenshot` and `agent-tty record export` can produce artifacts tied to the session timeline.
- Do not leave sessions running after the task ends; destroy them explicitly.
