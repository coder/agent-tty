---
name: agent-tty
description: Terminal and TUI automation CLI for AI agents. Use when the user needs to create a terminal session, run a command in a terminal, automate an interactive CLI or TUI, wait for terminal output, capture a TUI screenshot, export a terminal recording, or test a CLI workflow with reviewable artifacts.
metadata:
  advertise: 'true'
---

`agent-tty` is a terminal and TUI automation CLI that creates inspectable sessions and reviewable artifacts for agents.

Load the full canonical core skill from the CLI before doing terminal automation:
`agent-tty skills get agent-tty`

Discover additional built-in skills with:
`agent-tty skills list`

For structured QA and TUI dogfooding work, load:
`agent-tty skills get dogfood-tui`

This bootstrap intentionally stays minimal so the CLI remains the source of truth.
