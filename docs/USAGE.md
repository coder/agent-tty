# Usage

`agent-tty` is designed around isolated homes, JSON envelopes, observable waits, semantic snapshots, and renderer-backed artifacts.
Use public `agent-tty ...` commands in user-facing docs and automation; when developing inside this source tree, translate examples locally to `npx tsx src/cli/main.ts ...`.

## Core Workflow

```bash
AGENT_HOME="$(mktemp -d)"
agent-tty --home "$AGENT_HOME" doctor --json

SESSION_ID=$(agent-tty --home "$AGENT_HOME" create --json -- /bin/bash | jq -r '.result.sessionId')
agent-tty --home "$AGENT_HOME" run "$SESSION_ID" 'printf "ready\n"' --json
agent-tty --home "$AGENT_HOME" wait "$SESSION_ID" --text 'ready' --json
agent-tty --home "$AGENT_HOME" snapshot "$SESSION_ID" --format text --json
agent-tty --home "$AGENT_HOME" screenshot "$SESSION_ID" --json
agent-tty --home "$AGENT_HOME" record export "$SESSION_ID" --format webm --json
agent-tty --home "$AGENT_HOME" destroy "$SESSION_ID" --json
```

Recommended sequence:

1. Create an isolated home with `--home`.
2. Run `doctor --json` before screenshot or recording workflows.
3. Create a session with `create --json`.
4. Use `run` for shell setup and multiline bootstrap commands.
5. Use `wait` for observable terminal state instead of blind sleeps.
6. Use `snapshot` for semantic inspection.
7. Use `screenshot` or `record export` for reviewer-facing artifacts.
8. Destroy the session when the workflow is done.

## Essential Commands

```bash
# Environment and skills
agent-tty version --json
agent-tty --home <path> doctor --json
agent-tty skills list
agent-tty skills get agent-tty

# Lifecycle
agent-tty --home <path> create --json -- /bin/bash
agent-tty --home <path> list --json
agent-tty --home <path> inspect <session-id> --json
agent-tty --home <path> destroy <session-id> --json
agent-tty --home <path> gc --json

# In-session control
agent-tty --home <path> run <session-id> 'command here' --json
agent-tty --home <path> type <session-id> 'literal text' --json
agent-tty --home <path> paste <session-id> 'multiline payload' --json
agent-tty --home <path> send-keys <session-id> Enter Ctrl+C --json
agent-tty --home <path> resize <session-id> --cols 100 --rows 30 --json
agent-tty --home <path> signal <session-id> SIGTERM --json

# Observation and proof
agent-tty --home <path> wait <session-id> --text 'ready' --json
agent-tty --home <path> wait <session-id> --screen-stable-ms 1000 --json
agent-tty --home <path> snapshot <session-id> --format text --json
agent-tty --home <path> screenshot <session-id> --json
agent-tty --home <path> record export <session-id> --format asciicast --json
agent-tty --home <path> record export <session-id> --format webm --json
```

## `run`

Use `run` when you want shell-oriented setup inside an existing session, especially multiline bootstrap scripts or commands that should preserve shell state.

```bash
agent-tty run <session-id> [command]
agent-tty run <session-id> --file ./setup.sh
agent-tty run <session-id> 'npm install && npm test' --timeout 60000 --json
agent-tty run <session-id> 'npm run dev' --no-wait
```

Important flags:

- `--timeout <ms>`: wait timeout in milliseconds. Default: `30000`.
- `--no-wait`: fire-and-forget mode. The command is injected and the CLI returns without waiting for completion.
- `--file <path>`: read command text from a file instead of the positional argument.
- `--json`: emit a machine-readable command envelope.

Use `type` when the target application needs literal interactive typing, `paste` when the target should receive a literal pasted payload, and `send-keys` for discrete control keys such as `Enter`, `Escape`, or `Ctrl+C`.
`run` is not structured output capture and does not report the child command's exit status.

## `wait`

Use `wait` to synchronize on terminal state:

```bash
agent-tty wait <session-id> --text 'ready' --json
agent-tty wait <session-id> --regex 'READY|DONE' --json
agent-tty wait <session-id> --screen-stable-ms 1000 --json
agent-tty wait <session-id> --idle-ms 500 --json
agent-tty wait <session-id> --exit --json
```

Useful flags:

- `--text <string>`: wait for text to appear in rendered output.
- `--regex <pattern>`: wait for a regex match in rendered output.
- `--screen-stable-ms <ms>`: wait for the rendered screen to be stable.
- `--idle-ms <ms>`: wait for output idleness.
- `--exit`: wait for the process to exit.
- `--timeout <ms>`: maximum wait time in milliseconds, with `0` meaning infinite.

On timeout, a standalone `wait` still exits `0` and reports `matched: false` / `timedOut: true` in the JSON result — check the envelope, not the exit code. Inside `batch`, a timed-out `wait` step is a step failure (`WAIT_TIMEOUT`, exit code `11` under fail-fast).

### Screen Hash

`snapshot` results (both `--format structured` and `--format text`) and a **matched** `wait` result carry an optional `screenHash`: a lowercase 64-character hex SHA-256 of the visible screen text. Compare it across two calls to tell whether the visible screen actually changed — equal hashes mean identical visible content, even if the event-log sequence advanced on a no-op repaint.

- It hashes the visible screen only. It is **not** a hash of the `--format text` output, which also includes scrollback, so the hash ignores scrollback growth.
- It is distinct from the `screenshot` result's pixel `sha256`: `screenHash` is content identity, the screenshot `sha256` is pixel identity, and the two are not interchangeable.
- A `wait` that times out (or finds the host unreachable with no observed screen) omits `screenHash`, so a missing hash unambiguously means "no screen was observed" rather than an error.

## `batch`

Use `batch` to run an ordered sequence of input-and-`wait` steps against one session in a single invocation, instead of coordinating separate `run`/`type`/`paste`/`send-keys`/`wait` calls. Each `wait` step is anchored to a Wait Baseline — it only considers screen state produced _after_ the preceding input step — so a batch cannot race ahead and match a stale screen the way a hand-written shell loop can.

```bash
agent-tty batch <session-id> '[steps]' --json
agent-tty batch <session-id> --file ./steps.json --json
agent-tty batch <session-id> '[steps]' --keep-going --json
```

Steps are a JSON array; each step is exactly one verb. The shape mirrors the rest of the CLI:

```json
[
  { "run": "nvim --clean", "noWait": true },
  { "wait": { "screenStableMs": 1000 } },
  { "sendKeys": ["i"] },
  { "type": "hello" },
  { "sendKeys": ["Escape"] },
  { "type": ":wq" },
  { "sendKeys": ["Enter"] },
  { "wait": { "text": "written" } }
]
```

- `type` / `paste`: a string of literal text.
- `sendKeys`: a non-empty array of key names — individual named keys or single characters (e.g. `["Enter"]`, `["Ctrl+C"]`, `["Escape", "Enter"]`). Multi-character literal text such as `:wq` is not a key name; send it with a `type` step.
- `run`: a command string, with optional `noWait` (fire-and-forget) and `timeout` (ms). A `run` step is a waited run by default.
- `wait`: the same conditions as the `wait` command — `text`, `regex`, `screenStableMs`, `cursorRow`, `cursorCol`, and `timeout` (ms).

Input source and flags:

- A positional `[steps]` JSON array **xor** `--file <path>` — supply exactly one. Passing both, or neither, is an `INVALID_INPUT` error.
- `--keep-going`: attempt every step regardless of failures. By default a batch is **fail-fast** — the first failed step (a timed-out `wait`, or input to a session that is no longer commandable) stops the run, and the remaining steps are recorded `not-run`. A batch is not atomic: already-applied input cannot be undone.
- `--json`: emit a machine-readable command envelope.

The `--json` result is a per-step envelope:

```json
{
  "ok": true,
  "command": "batch",
  "result": {
    "steps": [
      {
        "index": 0,
        "kind": "run",
        "status": "completed",
        "seq": 4,
        "noWait": true,
        "runOutcome": "started",
        "durationMs": 12
      },
      {
        "index": 1,
        "kind": "wait",
        "status": "completed",
        "waitBaseline": 4,
        "matched": true,
        "timedOut": false,
        "capturedAtSeq": 9,
        "durationMs": 1003
      }
    ],
    "completedCount": 2,
    "failedIndices": []
  }
}
```

Each step record carries its `index`, `kind`, `status` (`completed` | `failed` | `not-run` | `interrupted`), and `durationMs`. Input steps report the Event Log `seq` they produced; `wait` steps report the `waitBaseline` they were anchored to plus `matched` / `timedOut` / `matchedText` / `capturedAtSeq`, and a matched `wait` step also carries the `screenHash` of the screen it observed (see [Screen Hash](#screen-hash)). `completedCount` and `failedIndices` summarize the run. A fail-fast batch exits non-zero with the failed step's exit code (e.g. `11` for a `WAIT_TIMEOUT`); `--keep-going` exits `1` if any step failed. If the process is interrupted by SIGINT/SIGTERM, batch flushes the same envelope with the in-flight step marked `interrupted` and later steps `not-run`, then exits non-zero.

The Wait Baseline fixes stale-match only. It does **not** fix echo-match: a `wait` can still match the terminal's echo of a just-typed command (the echo renders _after_ the baseline). Use a distinctive output token or a `screenStableMs` wait rather than waiting for text you just typed. Interrupting a batch mid-`wait` leaves that wait's command still running on the session (the wait is abandoned, not cancelled), exactly like a caller timeout on `run`.

## Screenshots And Recording Exports

Screenshots and WebM export use the `ghostty-web` reference visual renderer through Playwright/Chromium.
Semantic `snapshot`, screen-hash, and render-backed `wait` paths prefer `libghostty-vt` when the optional native package is available and fall back to `ghostty-web` otherwise. Run `doctor --json` first in new environments.

```bash
agent-tty screenshot <session-id> --profile reference-dark --json
agent-tty screenshot <session-id> --show-cursor --json
agent-tty record export <session-id> --format asciicast --out ./session.cast --json
agent-tty record export <session-id> --format webm --timing accelerated --out ./session.webm --json
```

WebM export replays with recorded wall-clock timing by default. Pass `--timing accelerated` (idle gaps clamped to 400ms) or `--timing max-speed` for a time-compressed video.

Use `--renderer ghostty-web`, `AGENT_TTY_RENDERER=ghostty-web`, or Home `config.json` `{ "defaultRenderer": "ghostty-web" }` to force legacy all-browser rendering. Use `--renderer libghostty-vt` only when you intentionally want semantic and screenshot requests routed through the native backend; WebM requests still record `ghostty-web` as the actual video producer.

`ghostty-web` provides reference visual truth for reviewable artifacts; it does not promise exact pixel parity with native terminals.

## Isolation

`--home <path>` stores manifests, sockets, event logs, and artifacts under an isolated agent-tty home.
Pass the same `--home` value to every command in a workflow.

For tests and automation, prefer an absolute temp directory:

```bash
AGENT_HOME="$(mktemp -d)"
agent-tty --home "$AGENT_HOME" doctor --json
```

Avoid writing automated sessions into the default `~/.agent-tty` unless you intentionally want shared local state.

## Shell Environment

`create` spawns the shell with your inherited environment plus `TERM` (from `--term`) and a default `PROMPT_EOL_MARK=` (empty). The empty `PROMPT_EOL_MARK` suppresses the inverse-video `%` that `zsh` prints at the end of any output without a trailing newline; without it, agent-tty's hidden per-`run` completion marker leaves a stray `%` in snapshots, screenshots, and recordings. The variable is zsh-only and inert in other shells.

Any `--env` value always wins, so you can opt back into the shell's native behavior per session:

```bash
# Restore zsh's styled default marker:
agent-tty create --env PROMPT_EOL_MARK='%B%S%#%s%b' -- /bin/zsh
```

A lone `'%'` does **not** restore the marker (zsh treats it as a prompt escape that expands to nothing); use `'%B%S%#%s%b'` for the styled default or `'%%'` for a plain percent. The default is applied at spawn time and is not stored in the manifest, so it does not appear in `inspect`, `list`, or `create --json` output. If your `~/.zshrc` assigns `PROMPT_EOL_MARK` it runs after the environment is imported and wins, so the marker can reappear — remove that line or set the value you want via `--env`.

## Exit Codes

Every command exits with a stable code, so scripts can branch without parsing output. The `--json` error envelope carries the precise `error.code` (for example `WAIT_TIMEOUT`); the exit code is a coarser, stable summary of it.

| Exit code | Meaning                                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`       | Success.                                                                                                                                    |
| `1`       | Internal or unclassified error.                                                                                                             |
| `2`       | Usage error: unknown command or flag, or an invalid argument (session ID, dimensions, keys, duration, signal, input).                       |
| `3`       | Session not found.                                                                                                                          |
| `4`       | Session is not running or already destroyed.                                                                                                |
| `5`       | Session host timed out.                                                                                                                     |
| `6`       | Session host unreachable.                                                                                                                   |
| `7`       | Export failed.                                                                                                                              |
| `8`       | Storage read/write or manifest validation error.                                                                                            |
| `9`       | Protocol or RPC error.                                                                                                                      |
| `10`      | Replay failed.                                                                                                                              |
| `11`      | A `wait` step inside a fail-fast `batch` timed out (standalone `wait` exits `0` with `timedOut: true` in the result — see [`wait`](#wait)). |

A fail-fast `batch` exits with the failed step's code (for example `11` for a wait timeout); `--keep-going` exits `1` if any step failed.

## Anti-Patterns

- Do not reach for `tmux`, `screen`, or ad hoc PTY wrappers first when `agent-tty` can provide an isolated, inspectable session.
- Do not rely on blind `sleep` calls when `wait --text`, `wait --idle-ms`, or `wait --screen-stable-ms` can observe readiness.
- Do not scrape human-readable output when `--json` is available.
- Do not use external screenshot tools as the primary proof path when `agent-tty screenshot` and `agent-tty record export` can produce artifacts tied to the session timeline.
- Do not leave sessions running after the task ends; destroy them explicitly.
