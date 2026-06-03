You are running inside a disposable workspace for an agent-tty Hero Demo.

Explore the installed agent-tty skill and CLI yourself, then use agent-tty to drive a real Neovim session.
Do not run a prewritten helper script; this run is meant to show how a coding agent uses agent-tty in the wild.

Success criteria:
- Learn the available workflow from the packaged agent-tty skill and CLI help as needed.
- Use the agent-tty binary on PATH and the already configured AGENT_TTY_HOME.
- Create an agent-tty session that launches nvim --clean -n demo-note.txt.
- Interact with Neovim through agent-tty and write exactly the text in HERO_EXPECTED_TEXT.
- Ensure the final file path in HERO_FINAL_FILE contains that exact text.
- Export the inner agent-tty recording to HERO_INNER_CAST and HERO_INNER_WEBM.
- Destroy the agent-tty session after exporting the proof artifacts.
- The recorder stops after a fixed review window, so complete the proof artifacts promptly and then summarize what you did.

Use the HERO_* environment variables for all required paths and final text. Avoid changing files outside this disposable workspace.
