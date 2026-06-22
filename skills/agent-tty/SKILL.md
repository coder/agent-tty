---
name: agent-tty
description: "Terminal and TUI automation CLI for AI agents. Use when the user needs to create a terminal session, run a command in a terminal, automate an interactive CLI or TUI, wait for terminal output, capture a TUI screenshot, export a terminal recording, or test a CLI workflow with reviewable artifacts."
advertise: true
---

`agent-tty` is a terminal and TUI automation CLI that creates inspectable sessions and reviewable artifacts for agents. Every task follows a create, run, wait, capture, destroy loop.

The CLI provides commands for session lifecycle (create, inspect, destroy), input (run, type, paste, send-keys), observation (wait, snapshot), and capture (screenshot, record export). All commands accept `--json` for machine-readable output and `--home <path>` for isolated sessions.

Load the full canonical core skill from the CLI before doing terminal automation:

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

This bootstrap intentionally stays minimal so the CLI remains the source of truth.
