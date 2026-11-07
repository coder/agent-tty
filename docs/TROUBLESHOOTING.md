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

## A Command Says `ghostty-web crashed`

The error message says `ghostty-web crashed while it replayed this session's output.` The Chromium page of the `ghostty-web` renderer died while it replayed the event log. A live `screenshot` or `snapshot --renderer ghostty-web` fails with `RPC_ERROR` (exit `9`). On an exited session the same commands fail with `REPLAY_ERROR` (exit `10`), and `record export --format webm` fails with `EXPORT_ERROR` (exit `7`). The message ends with the Playwright text, `(page.evaluate: Target crashed)`.

One known cause is a bug in ghostty-web 0.4.0. After a full reset (`ESC c`), `CSI ? 47 h` and `CSI ? 1047 h` show the old cells on the alternate screen. Output over a cell that holds a combining mark or another grapheme cluster then crashes the page. The shortest input has 12 bytes: `a`, U+0301, `ESC c`, `ESC [ ? 4 7 h` and `o`. `CSI ? 1049 h` is not affected.

Running the command again does not help, because each run replays the same log and the page crashes again. The session itself keeps running, and the host stays up. These commands do not use the page, so they still work on such a session:

- `snapshot` and `wait` with the `libghostty-vt` renderer, which is the default when its native package is available
- `record export --format svg` and `record export --format asciicast`

`screenshot` and `record export --format webm` have no replacement until ghostty-web has a fix.

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

## A Program Ignores an Exported `COLORTERM`

agent-tty spawns every session program with `COLORTERM=truecolor`, so an exported `COLORTERM` in the shell that runs `agent-tty create` does not reach the session. To change what a program reads, pass `--env COLORTERM=<value>` to `create`. An unset or empty `COLORTERM` still lets a program that queries the terminal, such as Neovim, detect 24-bit color, because agent-tty answers the XTGETTCAP `Tc`/`RGB` query. To hide 24-bit color from Neovim, use another value, for example `--env COLORTERM=256color`.

## Stray `%` at the End of Captured Output

If a snapshot, screenshot, or recording shows an unexpected inverse-video `%` at the end of output that has no trailing newline, that is `zsh`'s `PROMPT_EOL_MARK` end-of-partial-line indicator. agent-tty spawns shells with `PROMPT_EOL_MARK=` (empty) by default to suppress it, so you should normally not see it.

If it still appears:

- A `PROMPT_EOL_MARK` assignment in your `~/.zshrc` overrides the default (rc files load after the environment is imported). Remove that line, or set the value you want explicitly with `agent-tty create --env PROMPT_EOL_MARK=... -- <shell>`.
- The program running inside the session set the marker itself.

To deliberately keep the marker, pass `--env PROMPT_EOL_MARK='%B%S%#%s%b'` (zsh's styled default) when creating the session.

## A Recording Ends Early, or an Export Names the Event Log Limit

Each session records its terminal output in `events.jsonl`. The log stops at the first of two limits: 52,428,800 bytes (50 MB), or 250,000 events. A program that prints a lot reaches the byte limit. A program that prints in many tiny chunks reaches the event limit long before 50 MB. When the log stops, the host writes one marker and after it records only the program's exit. The marker reads `agent-tty: event log limit reached (52428800 bytes); later events are not recorded` when the byte limit stopped the log, and `agent-tty: event log limit reached (250000 events); later events are not recorded` when the event limit did. The program keeps running. Its later output, input, resizes and signals are not recorded, so snapshots, screenshots and recordings show the session as it was at the marker. An asciicast export ends with the marker. `mark` refuses a label that starts with `agent-tty: event log limit reached` with `INVALID_INPUT`, because only the host writes that marker.

To check whether a session's log stopped, run `agent-tty inspect <session-id> --json`. The result has `eventLogStop`, `{ "reason": "bytes" | "events" | "unknown", "seq": <n> }`, only when the log stopped. `reason` is the limit that stopped it, and `seq` is the `seq` of the marker. `unknown` means that the marker is in the log but its label names no limit, as in a log that agent-tty did not write. Without `--json`, `inspect` prints a line such as `Event Log Stopped: at seq 41 (byte limit); later events are not recorded`, and `(reason unknown)` for `unknown`. `inspect` reads the field from `events.jsonl` in the same read that counts `eventCount`, so it works for a live session and for an exited one, and `eventLogStop.seq` is never above `lastEventSeq`.

Commands on a live session read the stored log too, so after the marker they see the session as it was at the marker:

- `wait --text` and `wait --regex` for text that appears later time out. A render wait that times out on a stopped log says so, in its message and in `error.details.eventLogStop`: `The event log stopped at seq 41 (byte limit), so output after it is not seen.` A `batch` `wait` step adds the same sentence. On an exited session, `wait` replays the stored log, and a wait that the replayed screen does not satisfy fails with `REPLAY_ERROR`. Its message ends with the same sentence, and `error.details.eventLogStop` carries the same facts. A CLI older than the host that runs the session (for example after a downgrade) cannot read that timeout result, and reports `RPC_ERROR` instead of `WAIT_TIMEOUT`.
- `wait --screen-stable-ms` can report a stable screen while the program keeps printing, because the stored screen no longer changes.
- `mouse` encodes against the mouse modes in the stored log. A mode that the program turned on after the marker is not known, so the event succeeds with `reported: false` and writes nothing. A mode that the program turned off after the marker is still on in the stored log, so the program receives mouse bytes that it no longer expects.
- `wait --idle-ms` and `wait --exit` watch the live program and are not affected.

To keep a long session recordable, send its verbose output to a file instead of the terminal, or print in larger chunks.

A command that fails with a message such as `its event log is 81336613 bytes, over the 52428800-byte limit that commands can read` names a log that an older version of agent-tty wrote past the limit. No command can read that log. `inspect` and `destroy` still work on the session.
