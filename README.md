# agent-terminal

`agent-terminal` is a Node/TypeScript CLI for launching, controlling, inspecting, and exporting reviewable terminal sessions.
It is built for agent workflows that need both semantic state and visual artifacts from live or exited TUIs.

## Quick start

```bash
mise install
npm ci
npx playwright install chromium
npm run build

SESSION_ID=$(node dist/cli/main.js create --json --name demo | jq -r '.result.sessionId')
node dist/cli/main.js run "$SESSION_ID" 'echo hello from agent-terminal'
node dist/cli/main.js inspect "$SESSION_ID" --json
node dist/cli/main.js destroy "$SESSION_ID"
```

## Feature highlights

- Full session lifecycle management: create, inspect, list, wait, destroy, and garbage-collect.
- Semantic snapshots for structured or text inspection, including optional scrollback capture.
- Renderer-backed screenshots and replay exports for reviewable visual evidence.
- Recording export to asciicast (`.cast`) or WebM for artifact bundles.
- Failure recovery via reconciliation, stale-session cleanup, and retained manifests/artifacts.

## 0.1.0 release focus

`agent-terminal` `0.1.0` is the first release aimed at reliable, isolated, reviewable TUI automation.
Week 9 closes the release-readiness bar around the new `run` command, isolated-environment renderer reliability, and isolation-aware `doctor` diagnostics.
For the explicit release contract, see [`RELEASE.md`](./RELEASE.md).
Reviewer-facing proof bundles live under `dogfood/`, including `dogfood/run-command/` and `dogfood/20260325-week8-contract-locks/`.

## TUI Workflow

For setup-heavy TUI automation, prefer an isolated home plus the higher-level `run` primitive:

```bash
AGENT_HOME="$(mktemp -d)"
agent-terminal --home "$AGENT_HOME" doctor --json
SESSION_ID=$(agent-terminal --home "$AGENT_HOME" create --json -- /bin/bash | jq -r '.result.sessionId')
agent-terminal --home "$AGENT_HOME" run "$SESSION_ID" 'npm install'
agent-terminal --home "$AGENT_HOME" wait "$SESSION_ID" --text 'ready'
agent-terminal --home "$AGENT_HOME" screenshot "$SESSION_ID"
agent-terminal --home "$AGENT_HOME" record export "$SESSION_ID" --format webm
```

Recommended sequence:

1. Create an isolated session home with `create`.
2. Use `run` for shell setup and multiline bootstrap work.
3. Use `wait` for render-visible readiness conditions.
4. Capture screenshots for point-in-time review.
5. Export WebM recordings when reviewers need motion proof.

## Isolation

- `--home <path>` stores manifests, sockets, event logs, and artifacts under an isolated agent-terminal home. Pass the same `--home` value to each command in a workflow.
- `doctor --json` reports whether `agent-terminal` is using the default location or an isolated home, and it also checks renderer prerequisites such as Playwright/browser availability and screenshot viability.
- Renderer boot now carries Playwright browser-cache resolution into isolated-home workflows automatically when Chromium is installed in the normal cache or exposed through `PLAYWRIGHT_BROWSERS_PATH`.
- In a new machine, CI job, or container, run `agent-terminal --home <path> doctor --json` before starting screenshot or recording workflows.

## Platform Support

- **Linux** — Tier-1. CI-tested on `ubuntu-latest`. Primary development and testing platform.
- **macOS** — Tier-1. CI-tested on `macos-latest`. Supported for local development and agent workflows.
- **Windows** — Tier-2. Not CI-tested. PTY uses ConPTY when available; rendering and PTY behavior differences are possible. Community contributions welcome.

## CLI-wide flags

- `--home <path>`: override the agent-terminal home directory.
- `--timeout-ms <n>`: apply a shared CLI timeout budget in milliseconds.
- `--no-color`: disable ANSI color in human-readable output.
- `--json`: available on user-facing commands to emit structured command envelopes.

## Commands

- `version`: print the CLI version.
- `doctor`: validate local environment requirements.
- `create [command...]`: create a session and launch the requested command or shell.
- `list`: list sessions, optionally including exited ones.
- `inspect <session-id>`: inspect manifest state and artifact metadata for a session.
- `destroy <session-id>`: tear down a session, with optional forced shutdown.
- `gc`: remove stale or old sessions.
- `type <session-id> [text]`: type text into a session.
- `paste <session-id> [text]`: paste text into a session.
- `run <session-id> [command]`: run a command inside a session with optional completion detection.
- `mark <session-id> <label>`: add a marker event to a session timeline.
- `send-keys <session-id> <keys...>`: send key sequences such as `Enter` or `Ctrl+C`.
- `resize <session-id>`: resize the PTY dimensions.
- `signal <session-id> <signal>`: send a POSIX signal to the session child process.
- `snapshot <session-id>`: capture a semantic snapshot of terminal contents.
- `screenshot <session-id>`: capture a rendered PNG screenshot.
- `record export <session-id>`: export replay artifacts as asciicast or WebM.
- `wait <session-id>`: wait for exit, idleness, text, regex, cursor, or stable-screen conditions.

## Run Command

Basic usage:

```bash
agent-terminal run <session-id> [command]
agent-terminal run <session-id> --file ./setup.sh
agent-terminal run <session-id> 'npm install && npm test' --timeout 60000 --json
agent-terminal run <session-id> 'npm run dev' --no-wait
```

Important flags:

- `--timeout <ms>` — completion timeout in milliseconds. Default: `30000`.
- `--no-wait` — fire-and-forget mode. The command is injected and the CLI returns without waiting for completion.
- `--file <path>` — read command text from a file instead of the positional argument.
- `--json` — emit a machine-readable command envelope.

Use `run` when you want shell-oriented setup inside the existing session, especially for multiline bootstrap scripts or other commands that should preserve shell state.
Use `type` when the target application needs literal interactive typing, `paste` when the target should receive a literal pasted payload, and `send-keys` for discrete control keys such as `Enter`, `Escape`, or `Ctrl+C`.

Under the hood, `run` injects the command through paste-mode and, unless `--no-wait` is set, appends a generated boundary marker that the renderer waits to see in visible output.
That makes shell setup more reliable than simulating long keystroke sequences, but `run` does not capture command output or report an exit status.

## Development setup

```bash
mise install
npm ci
npx playwright install chromium
```

Useful shortcuts:

- `mise run bootstrap`: install npm dependencies and Chromium in one step.
- `npm run cli -- --help`: inspect the CLI locally without building.

## Verification

```bash
npm run verify
```

That runs formatting, linting, typechecking, unit/e2e tests, and the production build.

## Design docs

Design and implementation notes live under `design/`, especially `design/20260319_agent-terminal-v1/`.
See `design/20260319_agent-terminal-v1/` for architecture, weekly plans, and status docs through Week 9, and see [`RELEASE.md`](./RELEASE.md) for the `0.1.0` contract.

## Repository notes

- CI uses `mise` for tool provisioning and quality-gate entrypoints.
- Chromium is required locally for screenshot and replay export coverage.
- Platform support tiers are documented in this README; see also the design docs for detailed status.
- Dogfood proof bundles and validation notes live under `dogfood/` and `design/`.
