# agent-tty

`agent-tty` is a Node/TypeScript CLI for launching, controlling, inspecting, and exporting reviewable terminal sessions.
It is built for agent workflows that need both semantic state and visual artifacts from live or exited TUIs.

## Installation

`agent-tty` currently supports Node `24.x`.
The recommended hosted install path is the npm package `agent-tty`. GitHub Release tarballs remain the registry-independent fallback, and direct git dependency installs remain best-effort because they build from source.

### npm installation (recommended)

#### Global install from npm

```bash
PACKAGE_VERSION=<version>
npm install -g "agent-tty@${PACKAGE_VERSION}"
agent-tty version --json
agent-tty --home "$(mktemp -d)" doctor --json
```

To follow the prerelease channel instead of pinning an exact version, substitute `@beta` (or another dist-tag such as `@rc`) for `@${PACKAGE_VERSION}`.

#### Project-local install from npm

```bash
PACKAGE_VERSION=<version>
npm install "agent-tty@${PACKAGE_VERSION}"
./node_modules/.bin/agent-tty version --json
```

### GitHub Release tarball installation

#### Direct release asset install

```bash
VERSION=<version>
RELEASE_TAG="v${VERSION}"
RELEASE_TGZ="agent-tty-${VERSION}.tgz"
TARBALL_URL="https://github.com/coder/agent-tty/releases/download/${RELEASE_TAG}/${RELEASE_TGZ}"

npm install -g "$TARBALL_URL"
agent-tty version --json
```

#### Authenticated or private release install

```bash
VERSION=<version>
RELEASE_TAG="v${VERSION}"
RELEASE_TGZ="agent-tty-${VERSION}.tgz"

gh release download "$RELEASE_TAG" --repo coder/agent-tty --pattern "$RELEASE_TGZ"
npm install -g "./$RELEASE_TGZ"
agent-tty version --json
agent-tty --home "$(mktemp -d)" doctor --json
```

#### Project-local install from a downloaded tarball

```bash
VERSION=<version>
RELEASE_TGZ="./agent-tty-${VERSION}.tgz"

npm install "$RELEASE_TGZ"
./node_modules/.bin/agent-tty version --json
```

### Local tarball build from a source checkout

When you need a deterministic local artifact before publishing a GitHub Release, build the tarball from a checkout:

```bash
TARBALL_DIR=$(mktemp -d)
npm ci
npm run pack:private -- --pack-destination "$TARBALL_DIR"

INSTALL_PREFIX=$(mktemp -d)
npm install -g --prefix "$INSTALL_PREFIX" "$TARBALL_DIR"/*.tgz
"$INSTALL_PREFIX"/bin/agent-tty version --json
"$INSTALL_PREFIX"/bin/agent-tty --home "$(mktemp -d)" doctor --json
```

`npm run pack:private` always rebuilds `dist/` before packing. Release automation instead uses `npm run pack:release` after the CI-quality build step so GitHub Releases and the npm publish job both reuse the same verified tarball plus a checksum file.

### Git source installation (best-effort)

```bash
npm install -g github:coder/agent-tty
agent-tty version --json
```

GitHub installs attempt to build from source via npm's `prepare` hook.
Use this only when you explicitly want the latest default-branch snapshot and your npm/git-dependency environment can build native dependencies such as `node-pty` cleanly.
The repository's install smoke treats tarball install as the required path and records the current git-install caveat separately.

If your shell setup injects `mise activate` (or similar trust-checked tooling) into npm lifecycle subprocesses, trust the checkout path first or prefer the release tarball route.
If `doctor --json` reports a missing Playwright browser cache on a fresh machine, run `npx playwright install chromium` once before renderer-backed workflows.

## Quick start

```bash
AGENT_HOME="$(mktemp -d)"
agent-tty --home "$AGENT_HOME" doctor --json
SESSION_ID=$(agent-tty --home "$AGENT_HOME" create --json --name demo -- /bin/bash | jq -r '.result.sessionId')
agent-tty --home "$AGENT_HOME" run "$SESSION_ID" 'echo hello from agent-tty' --json
agent-tty --home "$AGENT_HOME" snapshot "$SESSION_ID" --format text --json
agent-tty --home "$AGENT_HOME" destroy "$SESSION_ID" --json
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

`agent-tty` `0.1.0` is the first release aimed at reliable, isolated, reviewable TUI automation.
For the explicit shipping contract, see [`RELEASE.md`](./RELEASE.md). For intentionally deferred work, see [`ROADMAP.md`](./ROADMAP.md).
Reviewer-facing proof bundles are curated in [`dogfood/CATALOG.md`](./dogfood/CATALOG.md), with current release-signoff evidence in `dogfood/20260326-week9-release-readiness/` and evergreen workflow coverage such as `dogfood/run-command/`.

## TUI Workflow

For setup-heavy TUI automation, prefer an isolated home plus the higher-level `run` primitive:

```bash
AGENT_HOME="$(mktemp -d)"
agent-tty --home "$AGENT_HOME" doctor --json
SESSION_ID=$(agent-tty --home "$AGENT_HOME" create --json -- /bin/bash | jq -r '.result.sessionId')
agent-tty --home "$AGENT_HOME" run "$SESSION_ID" 'npm install'
agent-tty --home "$AGENT_HOME" wait "$SESSION_ID" --text 'ready'
agent-tty --home "$AGENT_HOME" screenshot "$SESSION_ID"
agent-tty --home "$AGENT_HOME" record export "$SESSION_ID" --format webm
```

Recommended sequence:

1. Create an isolated session home with `create`.
2. Use `run` for shell setup and multiline bootstrap work.
3. Use `wait` for render-visible readiness conditions.
4. Capture screenshots for point-in-time review.
5. Export WebM recordings when reviewers need motion proof.
6. Destroy the session when done.

## AI agent skills

`agent-tty` ships two related skill trees in the npm package as well as the GitHub Release tarball:

- `skills/agent-tty/` is the thin public bootstrap used by TanStack Intent and other skill loaders that discover files directly.
- `skill-data/` contains the canonical runtime skills served by the CLI.
- `agent-tty skills list` discovers the bundled runtime skills, including `agent-tty` and `dogfood-tui`.

Install `agent-tty` from npm first (or from a GitHub Release tarball when you need a registry-independent fallback), then either copy the bootstrap skill into your agent config or let the CLI print the canonical runtime skill on demand.

For coding agents that can ingest instructions on demand, `agent-tty skills get <name>` prints the packaged runtime `SKILL.md` directly to stdout after installation.

```bash
agent-tty skills get agent-tty
```

Use `agent-tty skills list` to discover every bundled runtime skill, and `agent-tty skills get dogfood-tui` when you want the built-in TUI dogfooding skill.

### TanStack Intent integration

After installing `agent-tty` in the project, let Intent wire the bootstrap from `skills/agent-tty/` into `AGENTS.md`, `CLAUDE.md`, or another supported agent config file.

```bash
PACKAGE_VERSION=<version>
npm install "agent-tty@${PACKAGE_VERSION}"
npx @tanstack/intent@latest list
npx @tanstack/intent@latest install
```

That workflow keeps the skill version aligned with the installed `agent-tty` package, while the bootstrap stays small and points agents back to the CLI-served runtime skill.

### Mux skill installation

After installing the npm package globally, copy the bootstrap skill from `skills/agent-tty/`:

```bash
mkdir -p ~/.mux/skills/agent-tty
cp -R "$(npm root -g)/agent-tty/skills/agent-tty/." ~/.mux/skills/agent-tty/
```

Mux can then discover the bootstrap normally, and the bootstrap instructs the agent to load the canonical runtime skill with `agent-tty skills get agent-tty`.

### Direct skill copy for other skill loaders

After installing the npm package globally, copy the same bootstrap for loaders that read skill files directly:

```bash
mkdir -p ~/.claude/skills/agent-tty
cp -R "$(npm root -g)/agent-tty/skills/agent-tty/." ~/.claude/skills/agent-tty/
```

If your assistant supports repository-backed skills, point it at `coder/agent-tty` and select the `skills/agent-tty/` bootstrap directory.

### Suggested `AGENTS.md` / `CLAUDE.md` snippet

```markdown
## Terminal Automation

Use `agent-tty` for terminal and TUI automation instead of `tmux`, ad hoc PTY wrappers, or external screenshot tools.

Preferred workflow:

1. Create an isolated home and session with `agent-tty --home "$AGENT_HOME" create --json -- /bin/bash`.
2. Use `agent-tty run` for setup and bootstrap commands.
3. Use `agent-tty wait` for observable readiness instead of blind sleeps.
4. Use `agent-tty snapshot` to inspect the current terminal state.
5. Use `agent-tty screenshot` or `agent-tty record export` for reviewer-facing artifacts.
6. Destroy the session when the task is done.
```

Maintainers can validate the shipped bootstrap skill locally with:

```bash
npm run intent:validate
```

## Isolation

- `--home <path>` stores manifests, sockets, event logs, and artifacts under an isolated agent-tty home. Pass the same `--home` value to each command in a workflow.
- `doctor --json` reports whether `agent-tty` is using the default location or an isolated home, including a `home_isolation` check for whether `--home` produced an isolated environment.
- It also exposes `browser_cache_accessible`, which verifies the Playwright browser cache is discoverable for renderer operations before screenshot/export flows.
- Renderer boot now carries Playwright browser-cache resolution into isolated-home workflows automatically when Chromium is installed in the normal cache or exposed through `PLAYWRIGHT_BROWSERS_PATH`.
- In a new machine, CI job, or container, run `agent-tty --home <path> doctor --json` before starting screenshot or recording workflows.

## Platform Support

- **Linux** — Tier-1. CI-tested on `ubuntu-latest`. Primary development and testing platform.
- **macOS** — Tier-1. CI-tested on `macos-latest`. Supported for local development and agent workflows.
- **Windows** — Tier-2. Not CI-tested. PTY uses ConPTY when available; rendering and PTY behavior differences are possible. Community contributions welcome.

## CLI-wide flags

- `--home <path>`: override the agent-tty home directory.
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
agent-tty run <session-id> [command]
agent-tty run <session-id> --file ./setup.sh
agent-tty run <session-id> 'npm install && npm test' --timeout 60000 --json
agent-tty run <session-id> 'npm run dev' --no-wait
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
Start with [`design/ARCHITECTURE.md`](./design/ARCHITECTURE.md) for the stable overview, use [`design/20260319_agent-tty-v1/`](./design/20260319_agent-tty-v1/) for the active reference set, and use [`design/archive/`](./design/archive/) for week-by-week project history.

## Repository notes

- CI uses `mise` for tool provisioning and quality-gate entrypoints.
- Chromium is required locally for screenshot and replay export coverage.
- Platform support tiers are documented in this README; see also the design docs for detailed status.
- Dogfood proof bundles and review guidance live under [`dogfood/README.md`](./dogfood/README.md) and [`dogfood/CATALOG.md`](./dogfood/CATALOG.md).
