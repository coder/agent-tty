# agent-terminal

`agent-terminal` is a Node/TypeScript CLI for launching, controlling, inspecting, and exporting reviewable terminal sessions.
It is built for agent workflows that need both semantic state and visual artifacts from live or exited TUIs.

## Installation

`agent-terminal` currently supports Node `24.x`.
Released builds install from npm. For prerelease/private use, the guaranteed install path is a built tarball; direct GitHub installs are best-effort and may still fail in some environments.

### npm registry installation

#### Global installation

```bash
npm install -g agent-terminal
agent-terminal version --json
```

#### Project installation

```bash
npm install agent-terminal
./node_modules/.bin/agent-terminal version --json
```

### Direct GitHub installation

```bash
npm install -g github:coder/agent-terminal
agent-terminal version --json
```

GitHub installs attempt to build from source via npm's `prepare` hook.
Use this when you want the latest default-branch snapshot and your npm/git-dependency environment can build native dependencies cleanly.

Today, the guaranteed prerelease path is still the built tarball route below.
The repository's install smoke now treats tarball install as the required path and records the current git-install caveat separately, because native dependencies such as `node-pty` can still fail during npm's git-dependency flow in some environments.

If your shell setup injects `mise activate` (or similar trust-checked tooling) into npm lifecycle subprocesses, trust the checkout path first or use the tarball route below.

### Private tarball installation

When you need a deterministic prerelease artifact before the package is published, prefer a built tarball:

```bash
TARBALL_DIR=$(mktemp -d)
npm ci
npm run pack:private -- --pack-destination "$TARBALL_DIR"

INSTALL_PREFIX=$(mktemp -d)
npm install -g --prefix "$INSTALL_PREFIX" "$TARBALL_DIR"/agent-terminal-*.tgz
"$INSTALL_PREFIX"/bin/agent-terminal version --json
"$INSTALL_PREFIX"/bin/agent-terminal --home "$(mktemp -d)" doctor --json
```

`npm run pack:private` always rebuilds `dist/` before packing, so the tarball matches the private artifact reviewers should install.
Keep the tarball route as the guaranteed private-distribution fallback even when GitHub installs are convenient.

If `doctor --json` reports a missing Playwright browser cache on a fresh machine, run `npx playwright install chromium` once before renderer-backed workflows.

## Quick start

```bash
AGENT_HOME="$(mktemp -d)"
agent-terminal --home "$AGENT_HOME" doctor --json
SESSION_ID=$(agent-terminal --home "$AGENT_HOME" create --json --name demo -- /bin/bash | jq -r '.result.sessionId')
agent-terminal --home "$AGENT_HOME" run "$SESSION_ID" 'echo hello from agent-terminal' --json
agent-terminal --home "$AGENT_HOME" snapshot "$SESSION_ID" --format text --json
agent-terminal --home "$AGENT_HOME" destroy "$SESSION_ID" --json
```

## Documentation map

- [`RELEASE.md`](./RELEASE.md) — the current `0.1.0` release contract.
- [`ROADMAP.md`](./ROADMAP.md) — intentionally deferred work and post-release direction.
- [`design/README.md`](./design/README.md) — architecture references plus archived week-by-week planning.
- [`dogfood/CATALOG.md`](./dogfood/CATALOG.md) — curated proof bundles and recommended review paths.
- [`docs/README.md`](./docs/README.md) — contributor and maintainer navigation.

## Feature highlights

- Full session lifecycle management: create, inspect, list, wait, destroy, and garbage-collect.
- Semantic snapshots for structured or text inspection, including optional scrollback capture.
- Renderer-backed screenshots and replay exports for reviewable visual evidence.
- Recording export to asciicast (`.cast`) or WebM for artifact bundles.
- Failure recovery via reconciliation, stale-session cleanup, and retained manifests/artifacts.

## 0.1.0 release focus

`agent-terminal` `0.1.0` is the first release aimed at reliable, isolated, reviewable TUI automation.
For the explicit shipping contract, see [`RELEASE.md`](./RELEASE.md). For intentionally deferred work, see [`ROADMAP.md`](./ROADMAP.md).
Reviewer-facing proof bundles are curated in [`dogfood/CATALOG.md`](./dogfood/CATALOG.md), with current release-signoff evidence in `dogfood/20260326-week9-release-readiness/` and evergreen workflow coverage such as `dogfood/run-command/`.

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
6. Destroy the session when done.

## AI agent skill

The public skill lives under `skills/agent-terminal/` and ships in the npm package.
You can install it directly for Mux-style skill loaders, or let TanStack Intent discover and map it for compatible coding agents.

### TanStack Intent integration

If your agent supports Intent-compatible skill mappings, install `agent-terminal` in the project and let Intent wire the mapping into `AGENTS.md`, `CLAUDE.md`, or another supported agent config file.

```bash
npm install agent-terminal
npx @tanstack/intent@latest list
npx @tanstack/intent@latest install
```

That workflow keeps the skill version aligned with the installed `agent-terminal` package and avoids writing one-off instructions for each individual coding agent.

### Mux skill installation

```bash
npm install -g agent-terminal

mkdir -p ~/.mux/skills/agent-terminal
cp -R "$(npm root -g)/agent-terminal/skills/agent-terminal/." ~/.mux/skills/agent-terminal/
```

### Direct skill copy for other skill loaders

```bash
npm install -g agent-terminal

mkdir -p ~/.claude/skills/agent-terminal
cp -R "$(npm root -g)/agent-terminal/skills/agent-terminal/." ~/.claude/skills/agent-terminal/
```

If your assistant supports repository-backed skills, point it at `coder/agent-terminal` and select the `agent-terminal` skill directory.

### Suggested `AGENTS.md` / `CLAUDE.md` snippet

```markdown
## Terminal Automation

Use `agent-terminal` for terminal and TUI automation instead of `tmux`, ad hoc PTY wrappers, or external screenshot tools.

Preferred workflow:

1. Create an isolated home and session with `agent-terminal --home "$AGENT_HOME" create --json -- /bin/bash`.
2. Use `agent-terminal run` for setup and bootstrap commands.
3. Use `agent-terminal wait` for observable readiness instead of blind sleeps.
4. Use `agent-terminal snapshot` to inspect the current terminal state.
5. Use `agent-terminal screenshot` or `agent-terminal record export` for reviewer-facing artifacts.
6. Destroy the session when the task is done.
```

Maintainers can validate the shipped skill locally with:

```bash
npm run intent:validate
```

## Isolation

- `--home <path>` stores manifests, sockets, event logs, and artifacts under an isolated agent-terminal home. Pass the same `--home` value to each command in a workflow.
- `doctor --json` reports whether `agent-terminal` is using the default location or an isolated home, including a `home_isolation` check for whether `--home` produced an isolated environment.
- It also exposes `browser_cache_accessible`, which verifies the Playwright browser cache is discoverable for renderer operations before screenshot/export flows.
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

That runs formatting, linting, typechecking, unit/e2e tests, the production build, and packaging/install smoke coverage for the required tarball route plus the current git-dependency behavior/caveat check.
For contributor workflow and release hygiene, see [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md) and [`docs/RELEASE-PROCESS.md`](./docs/RELEASE-PROCESS.md).

## Design docs

Design and implementation notes live under [`design/`](./design/README.md).
Start with [`design/ARCHITECTURE.md`](./design/ARCHITECTURE.md) for the stable overview, use [`design/20260319_agent-terminal-v1/`](./design/20260319_agent-terminal-v1/) for the active reference set, and use [`design/archive/`](./design/archive/) for week-by-week project history.

## Repository notes

- CI uses `mise` for tool provisioning and quality-gate entrypoints.
- Chromium is required locally for screenshot and replay export coverage.
- Platform support tiers are documented in this README; see also the design docs for detailed status.
- Dogfood proof bundles and review guidance live under [`dogfood/README.md`](./dogfood/README.md) and [`dogfood/CATALOG.md`](./dogfood/CATALOG.md).
