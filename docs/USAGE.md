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
agent-tty --home <path> mouse <session-id> press --button left --row 8 --col 20 --json
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

Every command that runs checks the Node version against the `engines.node` range in `package.json`. Help output, usage errors and invalid global options skip the check. On a Node outside that range, a prerelease build included, the command still runs and writes a warning to stderr, so stdout keeps one JSON envelope. `--log-level error` hides the warning. `doctor` fails its `node-runtime` check against the same range.

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

## `mouse`

`mouse` sends a cell-addressed event through the terminal modes selected by
the child. The `libghostty-vt` renderer is required because static escape
sequences cannot account for tracking mode, wire format, pixel mode, viewport
clamping, or motion deduplication.

```bash
agent-tty mouse <session-id> press --button left --row 8 --col 20 --json
agent-tty mouse <session-id> move --row 9 --col 24 --json
agent-tty mouse <session-id> release --button left --row 9 --col 24 --json
agent-tty mouse <session-id> press --button wheel-down --row 9 --col 24 --json
```

Rows and columns are zero-based. `press` and `release` require `--button`;
`move` uses the host's held-button state so press, move, and release form a real
drag. Buttons are `left`, `middle`, `right`, `wheel-up`, `wheel-down`,
`wheel-left`, and `wheel-right`. `--shift`, `--alt`, and `--ctrl` add modifiers.
An event suppressed by the child's tracking mode succeeds with
`reported: false` and `bytesWritten: 0`. A cell outside the session's current
grid exits `2` with `INVALID_INPUT`. Missing renderer support exits `12`
with `CAPABILITY_UNAVAILABLE`.

The default surface uses virtual one-pixel cells. For SGR-pixels with a known
surface, pass `--cell-width` and `--cell-height` in pixels; the requested cell
maps to its top-left pixel. For example, row 2, column 3 with a 10x20 cell maps
to pixel 30,40. Screen dimensions follow the session's current rows and columns.
The same optional `cellWidth` and `cellHeight` fields are accepted in batch steps.

The host writes the native buffer directly to the PTY, including non-UTF-8 X10
bytes. Each `input_mouse` event stores those exact bytes as `dataBase64` alongside
the action, cell position, modifiers, renderer, and any explicit cell metrics.
Suppressed events still receive a sequence number and record an empty payload.
The mouse encoder comes with the optional `@coder/libghostty-vt-node` package,
and `doctor --json` reports it as the `mouse-input` capability. Without that
package, the other commands still work and `mouse` exits `12`.

## `wait`

Use `wait` to synchronize on terminal state:

```bash
agent-tty wait <session-id> --text 'ready' --json
agent-tty wait <session-id> --regex 'READY|DONE' --json
agent-tty wait <session-id> --regex 'READY>$' --scope cursor-line --json
agent-tty wait <session-id> --screen-stable-ms 1000 --json
agent-tty wait <session-id> --idle-ms 500 --json
agent-tty wait <session-id> --exit --json
```

Useful flags:

- `--text <string>`: wait for text to appear in rendered output.
- `--regex <pattern>`: wait for a regex match in rendered output.
- `--scope <scope>`: where `--text`/`--regex` match — `screen` (default, whole visible screen) or `cursor-line` (only the row the cursor is on). See [Echo-Match](#echo-match).
- `--screen-stable-ms <ms>`: wait for the rendered screen to be stable.
- `--after-seq <n>`: only match renderer snapshots produced after this Event Log sequence — thread an input command's returned `seq` here so the wait cannot match pre-input screen state. `-1` is the sequence before the first event, which a `snapshot` of a session that has printed nothing reports.
- `--idle-ms <ms>`: wait for output idleness.
- `--exit`: wait for the process to exit.
- `--timeout <ms>`: maximum wait time in milliseconds. The default is `30000` (30 s). `0` waits without a limit. An `--idle-ms` or `--screen-stable-ms` of `30000` or more cannot finish within the default, so `wait` rejects it with `INVALID_DURATION` unless you pass `--timeout`.

On timeout, a standalone `wait` exits `11` and prints an error envelope: `ok: false`, `error.code: "WAIT_TIMEOUT"`, and the wait result under `result` (`timedOut: true`, and `matched: false` for render waits). Without `--json`, it prints `WAIT_TIMEOUT: <message>` to stderr. Inside `batch`, a timed-out `wait` step is a step failure with the same `WAIT_TIMEOUT` exit code under fail-fast.

### Echo-Match

A whole-screen `wait` can be satisfied by the terminal's **echo of a just-typed command**: `run <sid> 'echo Done'` followed by `wait --text Done` matches the echoed command line itself, not the command's output. Use `--scope cursor-line` to restrict `--text`/`--regex` matching to the row the cursor is currently on. Once Enter is pressed the cursor moves past the echoed line, so a cursor-line wait cannot match the echo. It is ideal for waiting on prompts, which render exactly at the cursor:

```bash
agent-tty wait <session-id> --regex 'READY>$' --scope cursor-line --json
```

Rendered lines are right-trimmed of trailing ASCII spaces, so anchor prompt regexes without the trailing space: a prompt displayed as `READY> ` matches `READY>$`, not `READY> $`.

A standalone cursor-line wait issued right after an input command (`type`, `send-keys`, `run --no-wait`) can still match the **pre-input screen**: input commands return once the input is logged, before the application's response is necessarily rendered. If the cursor row already matched before the input — for example a repeated prompt in an echo-disabled application — the wait returns without the application having responded. Thread the input command's returned `seq` into `--after-seq` so the wait only observes screen state produced after the input; inside `batch`, wait steps get this anchoring automatically from the Wait Baseline:

```bash
SEQ=$(agent-tty send-keys <session-id> Enter --json | jq -r '.result.seq')
agent-tty wait <session-id> --regex 'READY>$' --scope cursor-line --after-seq "$SEQ" --json
```

For waiting on output text that scrolls past the cursor, prefer a distinctive output token or combine `--text` with `--screen-stable-ms`.

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
  { "mouse": { "action": "press", "button": "left", "row": 8, "col": 20 } },
  { "type": "hello" },
  { "sendKeys": ["Escape"] },
  { "type": ":wq" },
  { "sendKeys": ["Enter"] },
  { "wait": { "text": "written" } }
]
```

- `type` / `paste`: a string of literal text.
- `sendKeys`: a non-empty array of key names — individual named keys or single characters (e.g. `["Enter"]`, `["Ctrl+C"]`, `["Escape", "Enter"]`). Multi-character literal text such as `:wq` is not a key name; send it with a `type` step.
- `mouse`: the same `action`, `button`, `row`, `col`, and optional `modifiers`, `cellWidth`, and `cellHeight` fields as the `mouse` command. It uses the batch command's renderer.
- `run`: a command string, with optional `noWait` (fire-and-forget) and `timeout` (ms). A `run` step is a waited run by default.
- `wait`: the same conditions as the `wait` command — `text`, `regex`, `scope`, `screenStableMs`, `cursorRow`, `cursorCol`, and `timeout` (ms). An omitted `timeout` is `30000`, the same default as the `wait` command, and `0` waits without a limit. Without `timeout`, a `screenStableMs` of `30000` or more is rejected with `INVALID_INPUT`.

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

Each step record carries its `index`, `kind`, `status` (`completed` | `failed` | `not-run` | `interrupted`), and `durationMs`. Input steps report the Event Log `seq` they produced, and `mouse` steps also report `reported` and `bytesWritten`; `wait` steps report the `waitBaseline` they were anchored to plus `matched` / `timedOut` / `matchedText` / `capturedAtSeq`, and a matched `wait` step also carries the `screenHash` of the screen it observed (see [Screen Hash](#screen-hash)). `completedCount` and `failedIndices` summarize the run. A fail-fast batch with a failed step exits with that step's exit code (e.g. `11` for a `WAIT_TIMEOUT`) and, with `--json`, prints an error envelope: `ok: false`, the step's `error.code` and `message`, `error.details.stepIndex`, and the same per-step `result`. Its `retryable` is always `false`, because a batch is not atomic and a rerun repeats the input of the steps that already ran. `--keep-going` exits `1` if any step failed and keeps `ok: true`. If the process is interrupted by SIGINT/SIGTERM, batch flushes a success envelope (`ok: true`) with the per-step results so far, the in-flight step marked `interrupted` and later steps `not-run`, then exits `130` (SIGINT) or `143` (SIGTERM).

The Wait Baseline fixes stale-match only. It does **not** fix echo-match: a whole-screen `wait` can still match the terminal's echo of a just-typed command (the echo renders _after_ the baseline). Use `"scope": "cursor-line"` on the wait step to restrict matching to the cursor row (see [Echo-Match](#echo-match)), or wait for a distinctive output token. Interrupting a batch mid-`wait` leaves that wait's command still running on the session (the wait is abandoned, not cancelled), exactly like a caller timeout on `run`.

## Screenshots And Recording Exports

Screenshots and WebM export use the `ghostty-web` reference visual renderer through Playwright/Chromium.
Semantic `snapshot`, screen-hash, and render-backed `wait` paths prefer `libghostty-vt` when the optional native package is available and fall back to `ghostty-web` otherwise. Run `doctor --json` first in new environments.

On a session that has printed nothing yet, `snapshot` returns an empty screen of the session's size and `screenshot` returns a blank image. `record export` gives a header-only asciicast or a blank WebM of the session's size, with `durationMs: 0`. All of them report `capturedAtSeq: -1`, and the default files are named `screenshot--1-<profile>.png` and `recording--1-<format>.<ext>`.

```bash
agent-tty screenshot <session-id> --profile reference-dark --json
agent-tty screenshot <session-id> --show-cursor --json
agent-tty screenshot <session-id> --out ./proof.png --json
agent-tty record export <session-id> --format asciicast --out ./session.cast --json
agent-tty record export <session-id> --format webm --timing accelerated --out ./session.webm --json
```

`--out <path>` on `screenshot` and `record export` writes the file to that path, so it outlives the Home. A relative path resolves against the working directory, and a file already at the path is replaced. The parent folder must exist: a missing or unwritable parent, or a path inside the Home's `sessions/` folder, fails with `EXPORT_ERROR` (exit 7). `screenshot --out` still records the capture in the session's artifact manifest and returns the `--out` path as `artifactPath`.

The screenshot result lists `missingGlyphs`: each code point that the PNG draws as an empty `.notdef` box, with the zero-based `row` and `col` of each cell. A box appears when no font has the glyph, and also when Chromium draws a whole cluster (a letter plus a mark) with the first bundled font because no font has every part of it. The bundled fonts are a Latin JetBrains Mono subset and Symbols Nerd Font Mono. The check is best effort: an empty array means it found no box (see Known limits below), and a result without `missingGlyphs` means the check did not run or failed. The list holds at most 4096 cells, and one screenshot checks at most 4096 distinct glyphs within a 1-second time budget. When a limit or the budget stops the check early, the result also has `"missingGlyphsTruncated": true`, and the list can miss boxes. Glyphs that a host font draws are not listed, so the same session can list different code points on hosts with different fonts. The text snapshot still has the right characters.

Known limits: a letter that the font builds from a smaller precomposed letter plus a mark it lacks, such as Vietnamese `ế` (drawn as `ê` without the acute), is listed although the PNG shows a letter, not a box. A glyph under the block cursor is listed although the cursor hides it, and so is a glyph in a concealed (SGR 8) cell. The check uses the regular font style, so a bold or italic cell whose host font face differs in coverage can be judged wrong, and a grapheme that Chromium splits over several fonts is judged per code point, which can miss a box. A cluster whose parts the bundled fonts cover only between them, such as a Nerd Font glyph with a mark that only JetBrains Mono has, is not checked, so a box in it is not listed.

```bash
agent-tty screenshot <session-id> --json | jq -c '.result.missingGlyphs'
# [{"codePoint":"U+29C9","cells":[{"row":0,"col":6}]}]
```

WebM export replays with recorded wall-clock timing by default. Pass `--timing accelerated` (idle gaps clamped to 400ms) or `--timing max-speed` for a time-compressed video.

Use `--renderer ghostty-web`, `AGENT_TTY_RENDERER=ghostty-web`, or Home `config.json` `{ "defaultRenderer": "ghostty-web" }` to force legacy all-browser rendering. Use `--renderer libghostty-vt` only when you intentionally want semantic and screenshot requests routed through the native backend; WebM requests still record `ghostty-web` as the actual video producer.

`ghostty-web` provides reference visual truth for reviewable artifacts; it does not promise exact pixel parity with native terminals.

## `record diff`

`computeScreenHash` (see [Screen Hash](#screen-hash)) can only say _whether_ two screens differ. Use `record diff` to see _what_ changed: it replays two recorded sessions offline from their event logs and prints an LCS line diff of the canonical visible screens.

```bash
agent-tty record diff <session-id-a> <session-id-b> --json
agent-tty record diff <session-id> <session-id> --at-seq-a 0 --json
```

- `--at-seq-a <seq>` / `--at-seq-b <seq>`: replay each side up to an Event Log sequence (default: latest). Diffing a session against itself at an earlier sequence shows how its screen evolved.
- The JSON result carries `identical`, per-side `sessionId`/`capturedAtSeq`/`cols`/`rows`/`screenHash`, and a `diff` array of `{ op: equal | delete | add, text, aRow?, bRow? }` entries over the visible screen lines (0-based rows, no trimming or normalization — the same canonical lines that `screenHash` hashes). A side with an empty event log reports the pre-event blank screen with `capturedAtSeq: -1` (no event was replayed).
- Human output is a unified-style diff with `---`/`+++` headers naming each side's session, sequence, and hash prefix.
- The line diff is LCS-minimal for any realistic screen. As a bounded-memory safeguard, when the differing region (after matching the common prefix and suffix) is so large that the product of its two side lengths exceeds a 4,000,000-cell budget (for example 1,000 × 4,001 lines), that region degrades to a plain delete-then-add block instead of a minimal diff — `identical`, both `screenHash` values, and full-screen reconstruction remain exact; only diff minimality is reduced.
- The command works entirely offline from `events.jsonl`; sessions may be running or exited. The exit code is `0` whether or not the screens differ — automation should read `identical` from the JSON result.

## `destroy`

`destroy` ends the session's program and every process that the program left in its process group, then records the session as `destroyed`.
On Linux it also ends those processes when the program has already exited or the session has failed.
`destroy --force` kills the host and the program's group without asking the host first.
`list`, `inspect`, `destroy` and `gc` reconcile a session whose host died: they kill the program's group and record the session as `failed` (or `exited` or `destroyed`).
A `destroy` that runs inside the session, such as one typed into the session's shell, runs again outside the session and prints its result once the session has ended.
The session's terminal is closed by then, so redirect stdout to keep the result, for example `agent-tty destroy "$AGENT_TTY_SESSION_ID" --json > destroy.json`.
When `destroy` records `destroyed` itself, as with `--force`, for a session whose host died or for a session that has already ended, it first writes an empty internal file, `destroyed`, in the session folder. When the host records `destroyed`, as after a plain `destroy` of a live session, nobody writes that file.
A reconcile that writes over the record at the same moment finds the file right after its own write and records `destroyed` again.
A `list`, `inspect` or `gc` that reads the session between those two writes sees `failed`. If the reconciling process is killed between them, the session stays `failed`.
If `destroy` fails after it wrote the file, for example because its manifest write fails, the file stays. For a session that had not ended yet, the next reconcile then records it as `destroyed`. A reconcile skips a session that has already ended, so for such a session run `destroy` again.
A host that died after it recorded the session as ended leaves its socket. `gc`, and a `destroy` of a `destroyed` session, remove that socket when the manifest names no host pid or the host check below reads the host as ended.
When `create` cannot reach its new host within about 6 s, it fails with `HOST_UNREACHABLE` or `HOST_TIMEOUT` and tells the host to stop.
On Linux and macOS it sends the host SIGTERM, and the host stops the program the way `destroy` does and records the session as `destroyed` once the program's group has ended, also while its start-up is still slow.
A host that has already died, or that gets the SIGTERM before it spawns the program, leaves the session to the reconcile above: the session reads `running` until the next reconcile records it `failed`, and no program runs.
When the host cannot end the program's group, for example a process of another user, the session stays `destroying` with the host alive. That host never listened, so a plain `destroy` then fails with `HOST_UNREACHABLE` (exit 6), and only `destroy --force` can end the session.
On Windows, SIGTERM ends the host at once, so the host cannot stop the program itself. There `create` sends it only once the manifest names the program: the session then reads `running` with a dead host until the next reconcile records it `failed` and ends the program. Before the host's first manifest write, `create` leaves the host alone, as before this change, so a host that starts late can still serve the session.

On Linux, `destroy` and reconcile never kill a process group that they cannot prove is the session's.
When the host starts the program, it records the program's pid, the boot id and the program's autogroup id in an internal file, `program.json`.
Linux gives each new session a new autogroup id, and child processes keep it.
Before each kill, agent-tty checks that a live process in the group has that autogroup id and the program's pid as its session id.
If no process passes the check, agent-tty kills nothing, for example when an unrelated program now uses the group id.
If `/proc` refuses to show the boot id, or shows no autogroup id for a live process whose group and session id are the program's pid (it refuses the read, or the file is empty or malformed), agent-tty cannot run the check.
It then kills nothing and counts the group as running.
If the proven group, or a group that agent-tty cannot check, does not end within the destroy wait (about 5 s), `destroy` fails with `HOST_TIMEOUT` and does not record the session as `destroyed`.

`destroy --force` and reconcile also check the host's pid from `session.json` before they trust it.
On Linux the host records its pid, the boot id, its start time from `/proc/self/stat`, its pid and time namespaces and the machine id (`/etc/machine-id`) in an internal file, `host.json`, when it starts.
Reconcile counts the host as ended only when no process has its pid, when that process is a zombie, or when `host.json` names another boot or another start time than that process has. That covers a crashed host that stays a zombie under a container init that never reaps, and a later process that got the same pid.
Reconcile then records the session as `failed`. `destroy --force` sends the host SIGKILL only when the boot id and the start time of the process match `host.json`, so it does not signal a process that got the pid before that check.
The check and the kill are two system calls. A process that gets the pid between them still gets the signal, which needs the host to end, be reaped and its pid to go to a new process in that gap.
When agent-tty cannot read `/proc` or `host.json`, it counts a host whose pid exists as running and does not kill it. With `host.json` but an unreadable `/proc/self/ns/pid`, it counts the host as running even when no process has its pid.
When it runs in another pid namespace than the one that `host.json` names, or on another machine (another machine id), where the recorded pid can name an unrelated process, it counts the host as running and kills nothing, whatever that pid shows. Without a session token, it also kills no process group through the program's recorded pid there.
In another time namespace than the host's, `/proc` shows start times with another boottime offset. There agent-tty counts the host as ended only when no process has its pid or that process is a zombie, and it does not kill the host.
Without `host.json`, as for a session that an agent-tty version without it started, agent-tty cannot tell that it runs in another pid namespace. There a pid that no process has, or a zombie, reads as an ended host, and a kill without a session token goes to the group that the program's recorded pid names there.
A `hostPid` in `session.json` that differs from the pid in `host.json` never matches, so the session stays `running` and `destroy --force` kills nothing until `session.json` names the host again. That does not happen in normal use, because the host checks that `session.json` names its own pid.
On macOS and the BSDs, `destroy --force` kills the host only when `/bin/ps` shows the pid running `_host <session id>`, the arguments that agent-tty starts the host with.

Limits:

1. `destroy` does not kill a process that has left the program's process group. A process leaves the group when it calls `setsid` (for example `setsid cmd` or a daemon), or when an interactive shell with job control runs it as a job (for example `cmd &` typed into `bash -i`). Stop such a process yourself, or keep it in the program's group.
2. Some sessions have no autogroup record: sessions on macOS and Windows, on Linux kernels without autogroups (`/proc/self/autogroup` is missing), on Linux when `/proc` refuses to show the autogroup or the boot id at start-up, and sessions that an agent-tty version without `program.json` created. For these sessions, `destroy --force`, reconcile and the host's own kill at shutdown or at the idle time-out kill the process group (on Windows, the process) that `session.json` names, without the check, so such a kill can reach an unrelated process that took the group id after the program's group ended. `destroy` of a session whose program has already exited kills nothing. A `program.json` that agent-tty cannot read as a record, for example one that a newer version wrote, proves nothing: `destroy` and reconcile kill nothing for that session.
3. The check and the kill are separate system calls, a few microseconds apart. If every process of the group exits and an unrelated process takes the group id in that time, the kill reaches the unrelated process. No system call kills a process group through a handle, so this window remains.
4. The host writes `program.json` a few milliseconds after it starts the program. We timed 150 `create` calls on Linux, from the return of node-pty's spawn to the renamed `program.json`, at 1-minute load averages of 38 to 83: the median was 2.8 ms, the 90th percentile 4.3 ms, and the longest 66 ms. If the host dies in that window and the program ignores the hang-up signal, no file names the program, and `destroy` cannot end it.
5. `gc` removes `program.json` with the session folder, and `gc` kills nothing. Run `destroy` before `gc` when a program can leave processes behind.
6. Two cases where agent-tty cannot run the check end differently from a session that stays running:
   - At the idle time-out, a host that cannot run the check kills nothing, but it still records the session as `exited` once the program has exited, while a process that the program left can still run. A later `destroy` then fails with `HOST_TIMEOUT`, and `gc` can remove the session folder.
   - When `/proc` hides the processes of other users (mounted with `hidepid=2`, `hidepid=4`, `hidepid=invisible` or `hidepid=ptraceable`), a group whose processes agent-tty cannot see counts as running. A `destroy` that cannot prove such a group gone fails with `HOST_TIMEOUT` and does not record the session as `destroyed`.
7. Off Linux, reconcile counts the host as alive while any process has its pid. A crashed host that stays a zombie, or a process that got its pid, keeps the session `running`, and `destroy --force` kills nothing and fails with `HOST_TIMEOUT`. On Linux, the same happens when `/proc` is not mounted or refuses to show the host, and for a session that an agent-tty version without `host.json` started. On Windows, `destroy --force` never kills the host: it kills the program, and a host that hangs makes it fail with `HOST_TIMEOUT`. End such a host yourself with the Host PID that `inspect` shows (`taskkill /pid <pid> /f`), then run `destroy --force` again. When agent-tty cannot judge the host (another pid namespace or machine, or a refused read of `/proc/self/ns/pid`), `destroy --force` cannot see the host end either. It can fail with `HOST_TIMEOUT` although the host has recorded the session as `exited`, and a second `destroy --force` then records it as `destroyed`. When `/proc` is mounted but refuses to show the host and the program's processes (a security module that hides processes of the same user), `destroy --force` kills nothing and fails with `HOST_TIMEOUT` also for a healthy host.
8. A Home that several machines share, for example over NFS, works only from the machine that started each session. From another machine, agent-tty counts the host as running and kills nothing, because the machine id differs. Machines without a machine id (an empty, missing or `uninitialized` `/etc/machine-id`, as in many container images), or with the same one (a cloned image), cannot tell each other apart. agent-tty takes a machine id only when it is 32 lowercase hex characters, so it also reads any other value, such as a UUID with dashes or uppercase hex, as no id. There the boot id differs, so the other machine counts a live host as ended, records the session as `failed`, and `gc` can then remove its folder. Remote sessions are out of scope (see `RELEASE.md`).
9. A host that has ended reads as running forever when the machine id in its `host.json` differs from this machine's, for example after `/etc/machine-id` changed or in a cloned image that got a new one. `list` keeps the session `running`, `destroy --force` fails with `HOST_TIMEOUT`, and `gc` keeps the folder. First check, on the machine that started the session, that the host is gone: `ps -p <pid>` with the Host PID that `inspect` shows prints no `_host` process for that session. `ps` sees only the processes of its own machine, and when you delete `host.json` while the session still runs on another machine, `gc` can remove its folder. Then delete `host.json` from the session folder (`<home>/sessions/<session id>/host.json`). The next `list` records the session as `failed`, and `gc` can remove it. If another process now has that pid, the session stays `running`, and you can remove the session folder yourself.

## Isolation

`--home <path>` stores manifests, event logs, and artifacts under an isolated agent-tty home.
Pass the same `--home` value to every command in a workflow.

Each session's RPC socket lies outside the Home, at `/tmp/agent-tty-<uid>/<8 hex>/<12 hex>` (on Windows under `/tmp/agent-tty/`). `inspect --json` shows it as `host.rpcSocketPath`.
`create`, the host and `doctor` create `/tmp/agent-tty-<uid>` with mode `0700`. When that path is not a directory of your uid with mode `0700`, for example a symlink or a folder of another user, `create` fails with `STORAGE_WRITE_ERROR` (exit 8) and names the path and its owner.

Known limits:

1. Any user can create `/tmp/agent-tty-<uid>` before you do, because `/tmp` is shared. `create` then fails as above until that user or an admin removes it.
2. A host that an older version started listens at `/tmp/agent-tty/<8 hex>/<12 hex>`. This version still reaches it there when that socket and its folder belong to your uid and no other user can write the folder, and `destroy` and `gc` remove that old socket. An older version cannot reach a host that this version started: destroy your sessions before you downgrade.

For tests and automation, prefer an absolute temp directory:

```bash
AGENT_HOME="$(mktemp -d)"
agent-tty --home "$AGENT_HOME" doctor --json
```

Avoid writing automated sessions into the default `~/.agent-tty` unless you intentionally want shared local state.

## Shell Environment

`create` spawns the shell with your inherited environment plus `TERM` (from `--term`), a default `PROMPT_EOL_MARK=` (empty) and a default `COLORTERM=truecolor`. The empty `PROMPT_EOL_MARK` suppresses the inverse-video `%` that `zsh` prints at the end of any output without a trailing newline; without it, agent-tty's hidden per-`run` completion marker leaves a stray `%` in snapshots, screenshots, and recordings. The variable is zsh-only and inert in other shells.

The `COLORTERM=truecolor` default says that the renderer draws 24-bit color. Neovim turns on 24-bit color when it sees that value. When `COLORTERM` is unset or empty, Neovim asks the terminal instead. agent-tty answers that XTGETTCAP query (`Tc`, `RGB`), so Neovim still detects 24-bit color. An inherited `COLORTERM` describes the terminal that launched agent-tty, not the session's renderer, so the default replaces it.

The shell also receives two session variables, so scripts inside a session can detect agent-tty and find their own session:

| Variable               | Value                                                     |
| ---------------------- | --------------------------------------------------------- |
| `AGENT_TTY_ACTIVE`     | `true`.                                                   |
| `AGENT_TTY_SESSION_ID` | The session's ID (a ULID, as printed by `create --json`). |

Both replace inherited values, so a session created from inside another session reports its own ID, not the outer one. A PTY that agent-tty spawns without a session (the `doctor` spawn probe) gets neither variable: inherited values are removed, so it never reports an outer session's ID. Like the `PROMPT_EOL_MARK` and `COLORTERM` defaults, they are set at spawn time and are not stored in the session's recorded `env`.

Any `--env` value always wins, so you can opt back into the shell's native behavior or override a session variable per session:

```bash
# Restore zsh's styled default marker:
agent-tty create --env PROMPT_EOL_MARK='%B%S%#%s%b' -- /bin/zsh

# Hide 24-bit color support from Neovim (an empty COLORTERM would not,
# because Neovim then asks the terminal, and agent-tty answers yes):
agent-tty create --env COLORTERM=256color -- nvim
```

A lone `'%'` does **not** restore the marker (zsh treats it as a prompt escape that expands to nothing); use `'%B%S%#%s%b'` for the styled default or `'%%'` for a plain percent. The default is applied at spawn time and is not stored in the manifest, so it does not appear in `inspect`, `list`, or `create --json` output. If your `~/.zshrc` assigns `PROMPT_EOL_MARK` it runs after the environment is imported and wins, so the marker can reappear — remove that line or set the value you want via `--env`.

## Exit Codes

Every command exits with a stable code, so scripts can branch without parsing output. The `--json` error envelope carries the precise `error.code` when a command fails before producing a result. A timed-out standalone `wait` emits an error envelope (`ok: false`, `error.code: "WAIT_TIMEOUT"`) that still carries the wait `result`. A fail-fast `batch` with a failed step does the same with the step's `error.code` and its per-step `result`. A `--keep-going` batch with failures keeps a success envelope and exits `1`.

| Exit code | Meaning                                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------------------------- |
| `0`       | Success.                                                                                                                    |
| `1`       | Internal or unclassified error.                                                                                             |
| `2`       | Usage error: unknown command or flag, or an invalid argument (session ID, dimensions, keys, duration, signal, input).       |
| `3`       | Session not found.                                                                                                          |
| `4`       | Session is not running or already destroyed.                                                                                |
| `5`       | Session host timed out.                                                                                                     |
| `6`       | Session host unreachable.                                                                                                   |
| `7`       | Export failed.                                                                                                              |
| `8`       | Storage read/write or manifest validation error.                                                                            |
| `9`       | Protocol or RPC error.                                                                                                      |
| `10`      | Replay failed.                                                                                                              |
| `11`      | A standalone `wait` timed out, or a `wait` step inside a fail-fast `batch` timed out (`WAIT_TIMEOUT`; see [`wait`](#wait)). |
| `12`      | A requested runtime capability is unavailable (`CAPABILITY_UNAVAILABLE`).                                                   |

A fail-fast `batch` exits with the failed step's code (for example `11` for a wait timeout); `--keep-going` exits `1` if any step failed.

An unexpected failure prints an `INTERNAL_ERROR` envelope and exits `1`. Add `--log-level debug` to also print its stack on stderr. A failure while the CLI reads the global options and the config file prints no stack, because the log level is not known yet. With `--json`, a usage error (unknown command or flag, missing argument or required option) prints an `INVALID_INPUT` envelope under the command name `agent-tty` and exits `2`. The usage text still goes to stderr.

## Anti-Patterns

- Do not reach for `tmux`, `screen`, or ad hoc PTY wrappers first when `agent-tty` can provide an isolated, inspectable session.
- Do not rely on blind `sleep` calls when `wait --text`, `wait --idle-ms`, or `wait --screen-stable-ms` can observe readiness.
- Do not scrape human-readable output when `--json` is available.
- Do not use external screenshot tools as the primary proof path when `agent-tty screenshot` and `agent-tty record export` can produce artifacts tied to the session timeline.
- Do not leave sessions running after the task ends; destroy them explicitly.
