# agent-terminal

Node/TypeScript CLI scaffold.

## Setup

1. `mise install`
2. `mise run bootstrap`
3. `mise run ci`

## CI

- GitHub Actions uses `mise` as the canonical entrypoint for tool setup and quality gates.
- The committed workflow in `.github/workflows/ci.yml` is hand-curated. `mise generate github-action` is useful as a scaffold, but the checked-in file is the maintained source of truth because it includes repo-specific triggers, bootstrap behavior, and step-level logs.
- CI uses `mise run bootstrap-ci` for deterministic `npm ci` installs, then explicitly runs `npx playwright install chromium` so renderer smoke coverage is exercised on GitHub Actions.
- For v1, CI intentionally follows the major-version tool pins declared in `mise.toml` (`node = "24"`, `python = "3"`). This repo does not commit a `mise.lock` yet.
