---
name: agent-tty
description: "Terminal and TUI automation CLI for AI agents. Use when the user needs to create a terminal session, run a command in a terminal, automate an interactive CLI or TUI, wait for terminal output, capture a TUI screenshot, export a terminal recording, or test a CLI workflow with reviewable artifacts."
advertise: true
---

`agent-tty` is a terminal and TUI automation CLI that creates inspectable sessions and reviewable artifacts for agents.

## Quick Start

Every terminal automation task follows this loop: create, run, wait, capture, destroy.

```bash
AGENT_HOME="$(mktemp -d)"
SID=$(agent-tty --home "$AGENT_HOME" create --json -- /bin/bash | jq -r '.result.sessionId')
agent-tty --home "$AGENT_HOME" run "$SID" 'printf "ready\n"' --json
agent-tty --home "$AGENT_HOME" wait "$SID" --text 'ready' --json
agent-tty --home "$AGENT_HOME" snapshot "$SID" --format text --json
agent-tty --home "$AGENT_HOME" screenshot "$SID" --json
agent-tty --home "$AGENT_HOME" destroy "$SID" --json
```

For interactive TUIs, use `--no-wait` with `run`, then `wait --screen-stable-ms` and `send-keys`:

```bash
agent-tty --home "$AGENT_HOME" run "$SID" 'nvim --clean' --no-wait --json
agent-tty --home "$AGENT_HOME" wait "$SID" --screen-stable-ms 1000 --json
agent-tty --home "$AGENT_HOME" send-keys "$SID" Down Down Enter --json
agent-tty --home "$AGENT_HOME" screenshot "$SID" --json
```

## Command Surface

- **Lifecycle:** `create`, `list`, `inspect`, `destroy`, `gc`
- **Input:** `run`, `type`, `paste`, `send-keys`, `resize`, `signal`, `mark`
- **Observe:** `wait --text`, `wait --screen-stable-ms`, `wait --idle-ms`
- **Capture:** `snapshot`, `screenshot`, `record export --format webm|asciicast`
- **Environment:** `version`, `doctor`, `skills list|get|path`

Always pass `--json` for machine-readable output. Use `--home <path>` (or `AGENT_TTY_HOME`) for isolated sessions.

## Full Skill and Extensions

Load the full canonical skill with extended patterns and anti-patterns from the CLI:

```bash
agent-tty skills get agent-tty
```

Discover additional built-in skills with:

```bash
agent-tty skills list
```

For structured QA and TUI dogfooding work, load:

```bash
agent-tty skills get dogfood-tui
```
