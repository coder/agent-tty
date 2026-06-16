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

- `libghostty_vt_available` (preferred semantic renderer and dashboard)
- `playwright_available`
- `browser_cache_accessible`
- `browser_launch`
- `ghostty_web_available` (visual renderer and semantic fallback)
- `screenshot_viable`

If the browser-backed checks fail in CI or a container, install Chromium during setup and make sure the cache is readable by the process running `agent-tty`. If `libghostty_vt_available` is skipped or unavailable and no renderer is explicitly configured, semantic commands should fall back to `ghostty-web`; use `--renderer ghostty-web` to make that choice explicit. If you have `AGENT_TTY_RENDERER=libghostty-vt` or Home `config.json` sets `defaultRenderer` to `libghostty-vt`, clear that explicit configuration or override it with `ghostty-web` on machines without the optional native package.

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

`libghostty-vt` is the preferred default for semantic snapshots and render-backed waits when the optional native package is available. `ghostty-web` remains the reference visual renderer for screenshots and replay video, and it is the automatic semantic fallback when native rendering is unavailable and no renderer override is set.

These renderers give repeatable artifacts for review and automation, but they do not guarantee exact native-terminal pixel parity. If a bug depends on a specific native terminal emulator, keep the `agent-tty` artifact as reference evidence and capture native-terminal evidence separately when needed.

## Stray `%` at the End of Captured Output

If a snapshot, screenshot, or recording shows an unexpected inverse-video `%` at the end of output that has no trailing newline, that is `zsh`'s `PROMPT_EOL_MARK` end-of-partial-line indicator. agent-tty spawns shells with `PROMPT_EOL_MARK=` (empty) by default to suppress it, so you should normally not see it.

If it still appears:

- A `PROMPT_EOL_MARK` assignment in your `~/.zshrc` overrides the default (rc files load after the environment is imported). Remove that line, or set the value you want explicitly with `agent-tty create --env PROMPT_EOL_MARK=... -- <shell>`.
- The program running inside the session set the marker itself.

To deliberately keep the marker, pass `--env PROMPT_EOL_MARK='%B%S%#%s%b'` (zsh's styled default) when creating the session.
