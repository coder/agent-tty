# agent-terminal

`agent-terminal` is a Node/TypeScript CLI for launching, controlling, inspecting, and exporting reviewable terminal sessions.
It is built for agent workflows that need both semantic state and visual artifacts from live or exited TUIs.

## Quick start

```bash
mise install
npm ci
npx playwright install chromium
npm run build

SESSION_ID=$(node dist/cli/main.js create --json --name demo | jq -r '.data.sessionId')
node dist/cli/main.js type "$SESSION_ID" 'echo hello from agent-terminal'
node dist/cli/main.js send-keys "$SESSION_ID" Enter
node dist/cli/main.js inspect "$SESSION_ID" --json
node dist/cli/main.js destroy "$SESSION_ID"
```

## Feature highlights

- Full session lifecycle management: create, inspect, list, wait, destroy, and garbage-collect.
- Semantic snapshots for structured or text inspection, including optional scrollback capture.
- Renderer-backed screenshots and replay exports for reviewable visual evidence.
- Recording export to asciicast (`.cast`) or WebM for artifact bundles.
- Failure recovery via reconciliation, stale-session cleanup, and retained manifests/artifacts.

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
- `mark <session-id> <label>`: add a marker event to a session timeline.
- `send-keys <session-id> <keys...>`: send key sequences such as `Enter` or `Ctrl+C`.
- `resize <session-id>`: resize the PTY dimensions.
- `signal <session-id> <signal>`: send a POSIX signal to the session child process.
- `snapshot <session-id>`: capture a semantic snapshot of terminal contents.
- `screenshot <session-id>`: capture a rendered PNG screenshot.
- `record export <session-id>`: export replay artifacts as asciicast or WebM.
- `wait <session-id>`: wait for exit, idleness, text, regex, cursor, or stable-screen conditions.

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

## Repository notes

- CI uses `mise` for tool provisioning and quality-gate entrypoints.
- Chromium is required locally for screenshot and replay export coverage.
- Dogfood proof bundles and validation notes live under `dogfood/` and `design/`.
