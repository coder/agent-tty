# Troubleshooting

Start with `doctor --json` against the same home you will use for the workflow:

```bash
AGENT_HOME="$(mktemp -d)"
agent-tty --home "$AGENT_HOME" doctor --json
```

The `doctor` command checks runtime, filesystem, PTY, socket, artifact, event-log, Playwright, browser-cache, `ghostty-web`, and screenshot viability.

## Chromium Or Browser Cache Missing

Screenshots and WebM exports require Playwright/Chromium.
Install Chromium once in the environment:

```bash
npx playwright install chromium
```

If your environment uses a custom browser cache, expose it with `PLAYWRIGHT_BROWSERS_PATH` and rerun:

```bash
PLAYWRIGHT_BROWSERS_PATH=<path> agent-tty --home "$AGENT_HOME" doctor --json
```

## Renderer-Backed Commands Fail

Affected commands usually include:

- `screenshot`
- `record export --format webm`
- renderer-dependent `wait` modes
- semantic `snapshot` paths that need rendered terminal state

Check `doctor --json` for:

- `playwright_available`
- `browser_cache_accessible`
- `browser_launch`
- `ghostty_web_available`
- `screenshot_viable`

If these fail in CI or a container, install Chromium during setup and make sure the cache is readable by the process running `agent-tty`.

## Isolated Homes

Use `--home <path>` for automation, tests, CI, and agent workflows:

```bash
AGENT_HOME="$(mktemp -d)"
agent-tty --home "$AGENT_HOME" doctor --json
```

Pass the same `--home` value to every command in the workflow.
Do not mix `--home` and `AGENT_TTY_HOME` values unless you intentionally want separate session stores.

## Native Dependency Build Failures

`agent-tty` depends on `node-pty`.
The npm package and release tarball are the preferred install routes because they use packaged artifacts.
Direct git installs build from source through npm's `prepare` hook and are best-effort.

If a git install fails because native dependencies cannot build, use:

```bash
npm install -g agent-tty
```

or install a GitHub Release tarball as described in [`INSTALL.md`](./INSTALL.md).

## Platform Notes

- Linux is tier-1 and CI-tested on `ubuntu-latest`.
- macOS is tier-1 and CI-tested on `macos-latest`.
- Windows is tier-2 and not CI-tested. PTY behavior uses ConPTY when available, and rendering or terminal behavior may differ.

## Reference Rendering Caveat

`ghostty-web` is the reference renderer for snapshots, screenshots, and replay video.
It gives repeatable artifacts for review and automation, but it does not guarantee exact native-terminal pixel parity.

If a bug depends on a specific native terminal emulator, keep the `agent-tty` artifact as reference evidence and capture native-terminal evidence separately when needed.
