---
name: agent-tty
description: Terminal and TUI automation CLI for AI agents. Use when the user needs to create a terminal session, run a command in a terminal, automate an interactive CLI or TUI, wait for terminal output, capture a TUI screenshot, export a terminal recording, or test a CLI workflow with reviewable artifacts.
advertise: true
---

# Terminal Automation with agent-tty

If `agent-tty` is not already available in the environment, fetch the current `README.md` from `coder/agent-tty` on GitHub and follow its installation instructions before continuing. Otherwise use `agent-tty` directly.
Examples use `jq` for JSON parsing; any JSON-processing tool works.
Prefer isolated homes, JSON envelopes, and renderer-backed artifacts so terminal workflows stay reviewable and reproducible.

## Core Workflow

Every terminal or TUI automation task should follow this pattern:

1. **Create an isolated home** with `--home`.
2. **Check prerequisites** with `doctor --json` before screenshot or recording work.
3. **Create a session** with `create --json`.
4. **Run setup commands** with `run` instead of simulating long shell typing.
5. **Wait on observable terminal state** with `wait` instead of blind sleeps.
6. **Inspect the current screen** with `snapshot`.
7. **Capture proof artifacts** with `screenshot` or `record export`.
8. **Destroy the session** when finished.

```bash
AGENT_HOME="$(mktemp -d)"
agent-tty --home "$AGENT_HOME" doctor --json
SESSION_ID=$(agent-tty --home "$AGENT_HOME" create --json -- /bin/bash | jq -r '.result.sessionId')
agent-tty --home "$AGENT_HOME" run "$SESSION_ID" 'printf "ready\n"'
agent-tty --home "$AGENT_HOME" wait "$SESSION_ID" --text 'ready' --json
agent-tty --home "$AGENT_HOME" snapshot "$SESSION_ID" --format text --json
agent-tty --home "$AGENT_HOME" screenshot "$SESSION_ID" --json
agent-tty --home "$AGENT_HOME" record export "$SESSION_ID" --format webm --json
agent-tty --home "$AGENT_HOME" destroy "$SESSION_ID" --json
```

## Essential Commands

```bash
# Environment and lifecycle
agent-tty --home <path> doctor --json
agent-tty --home <path> create --json -- /bin/bash
agent-tty --home <path> inspect <session-id> --json
agent-tty --home <path> destroy <session-id> --json

# In-session control
agent-tty --home <path> run <session-id> 'command here' --json
agent-tty --home <path> type <session-id> 'literal text' --json
agent-tty --home <path> paste <session-id> 'multiline payload' --json
agent-tty --home <path> send-keys <session-id> Enter Ctrl+C --json

# Observation and proof
agent-tty --home <path> wait <session-id> --text 'ready' --json
agent-tty --home <path> wait <session-id> --screen-stable-ms 1000 --json
agent-tty --home <path> snapshot <session-id> --format text --json
agent-tty --home <path> screenshot <session-id> --json
agent-tty --home <path> record export <session-id> --format webm --json
```

## Common Patterns

### Bootstrap a shell session

```bash
AGENT_HOME="$(mktemp -d)"
SESSION_ID=$(agent-tty --home "$AGENT_HOME" create --json -- /bin/bash | jq -r '.result.sessionId')
agent-tty --home "$AGENT_HOME" run "$SESSION_ID" 'pwd && ls -la' --json
agent-tty --home "$AGENT_HOME" snapshot "$SESSION_ID" --format text --json
```

### Drive an interactive CLI or TUI

```bash
AGENT_HOME="$(mktemp -d)"
SESSION_ID=$(agent-tty --home "$AGENT_HOME" create --json -- /bin/bash | jq -r '.result.sessionId')
agent-tty --home "$AGENT_HOME" run "$SESSION_ID" '<interactive-command>' --no-wait --json
agent-tty --home "$AGENT_HOME" wait "$SESSION_ID" --screen-stable-ms 1000 --json
agent-tty --home "$AGENT_HOME" send-keys "$SESSION_ID" Down Down Enter --json
agent-tty --home "$AGENT_HOME" screenshot "$SESSION_ID" --json
```

### Export reviewer-facing artifacts

```bash
AGENT_HOME="$(mktemp -d)"
SESSION_ID=$(agent-tty --home "$AGENT_HOME" create --json -- /bin/bash | jq -r '.result.sessionId')
agent-tty --home "$AGENT_HOME" run "$SESSION_ID" 'printf "artifact proof\n"' --json
agent-tty --home "$AGENT_HOME" wait "$SESSION_ID" --text 'artifact proof' --json
agent-tty --home "$AGENT_HOME" screenshot "$SESSION_ID" --json
agent-tty --home "$AGENT_HOME" record export "$SESSION_ID" --format asciicast --json
agent-tty --home "$AGENT_HOME" record export "$SESSION_ID" --format webm --json
```

## Anti-Patterns

- **Do not reach for `tmux`, `screen`, or ad hoc PTY wrappers first** when `agent-tty` can provide an isolated, inspectable session.
- **Do not rely on blind `sleep` calls** when `wait --text`, `wait --idle-ms`, or `wait --screen-stable-ms` can observe terminal readiness directly.
- **Do not bypass `--json`** when another tool or agent needs machine-readable results.
- **Do not use external screenshot tools as the primary proof path** when `agent-tty screenshot` and `agent-tty record export` can produce renderer-backed artifacts tied to the session timeline.
- **Do not leave sessions running after the task ends**; destroy them explicitly.
- **Do not rewrite public examples into repo-local development invocations**; the public workflow should stay `agent-tty ...`.
