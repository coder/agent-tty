# GitHub triage emulated publish dogfood

This bundle proves the deterministic GitHub issue triage publisher can run against the `vercel-labs/emulate` GitHub REST API emulator without mutating a real GitHub repository.

## Scenario

`commands.sh` starts a local GitHub emulator, seeds `octocat/triage-sandbox`, creates two issues, computes the publisher conversation hashes through a small `gh`-compatible wrapper, and runs `scripts/github-issue-triage-publish.mjs` with base64 publish plans.

Assertions captured in the outputs:

- `triage-comment-result.json`: issue #1 published a marker comment and applied `ready-for-agent` plus `triage:done`.
- `triage-comment-idempotent-result.json`: re-running the same plan returned `already_published` without duplicating the marker comment.
- `risk-stop-result.json`: issue #2 applied `triage:stopped` plus `risk:high` without posting a comment.
- `issue-1-after.json` and `issue-2-after.json`: final emulated issue states matched the expected labels and comments.

## Reviewer proof artifacts

- `terminal.png` — terminal screenshot from the `agent-tty` dogfood session.
- `session.webm` — accelerated WebM recording of the terminal session.
- `session.cast` — asciicast export of the same session.
- `snapshot.txt` / `snapshot.json` — scrollback snapshot containing the successful run.
- `commands.sh` — reproducible command script.

The emulator tokens in `emulate.config.yaml` are local test tokens only.
