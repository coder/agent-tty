# agent-terminal v1 CLI contract

This document defines the concrete v1 CLI contract.

The contract is intentionally optimized for:

- machine execution,
- AI-agent use,
- shell scripting,
- and human debugging.

## 1. CLI design rules

### 1.1 Public command families

V1 public commands:

- `create`
- `list`
- `inspect`
- `type`
- `paste`
- `send-keys`
- `resize`
- `signal`
- `wait`
- `snapshot`
- `screenshot`
- `record export`
- `destroy`
- `gc`
- `doctor`
- `version`

### 1.2 Machine-first output

Every command must support `--json`.

Automation consumers should always pass `--json`.

Human-readable output is allowed, but it is not the primary contract.

### 1.3 Stable envelope

Every JSON response uses the same top-level envelope fields in the shipped implementation: `ok`, `command`, `timestamp`, and either `result` or `error`. Session-specific identifiers currently live inside command-specific `result` payloads or `error.details` rather than as a top-level envelope `sessionId` field.

```json
{
  "ok": true,
  "command": "inspect",
  "timestamp": "2026-03-25T15:00:00.000Z",
  "result": {}
}
```

Failure envelope:

```json
{
  "ok": false,
  "command": "inspect",
  "timestamp": "2026-03-25T15:00:00.000Z",
  "error": {
    "code": "SESSION_NOT_FOUND",
    "message": "Session \"missing-session\" was not found.",
    "retryable": false,
    "details": {
      "sessionId": "missing-session",
      "manifestPath": "/tmp/agent-terminal/sessions/missing-session/session.json"
    }
  }
}
```

### 1.4 Exit codes

Recommended exit codes:

| Code | Meaning                             |
| ---- | ----------------------------------- |
| `0`  | Success                             |
| `1`  | Generic command failure             |
| `2`  | Usage / validation error            |
| `3`  | Session not found                   |
| `4`  | Session not running / invalid state |
| `5`  | Wait timed out                      |
| `6`  | Renderer unavailable                |
| `7`  | Artifact export failure             |
| `8`  | Environment / dependency failure    |

## 2. Global flags

All public commands should support these where sensible:

| Flag                  | Meaning                                             |
| --------------------- | --------------------------------------------------- |
| `--json`              | Emit JSON envelope                                  |
| `--home <path>`       | Override `~/.agent-terminal`                        |
| `--log-level <level>` | `error`, `warn`, `info`, `debug`, `trace`           |
| `--timeout-ms <n>`    | Command timeout                                     |
| `--profile <name>`    | Render profile override for render-related commands |
| `--no-color`          | Disable colored human output                        |

## 3. Config precedence

Resolved config order:

1. command-line flags,
2. environment variables,
3. config file,
4. built-in defaults.

### 3.1 Suggested environment variables

| Variable                      | Meaning                                |
| ----------------------------- | -------------------------------------- |
| `AGENT_TERMINAL_HOME`         | Override home directory                |
| `AGENT_TERMINAL_LOG_LEVEL`    | Logging default                        |
| `AGENT_TERMINAL_PROFILE`      | Default render profile                 |
| `AGENT_TERMINAL_BROWSER_PATH` | Override Playwright browser executable |
| `AGENT_TERMINAL_KEEP_TEMP`    | Preserve temp replay outputs           |

## 4. Resource identifiers

### 4.1 Session IDs

Use ULID-like or lexicographically sortable IDs.

Recommended prefix:

- `sess_<ulid>`

### 4.2 Artifact IDs

Recommended prefixes:

- `snap_<ulid>`
- `shot_<ulid>`
- `rec_<ulid>`
- `vid_<ulid>`

These IDs should appear in manifest entries and JSON outputs.

## 5. Command: `create`

Create a new session host and spawn a PTY child.

### 5.1 Syntax

```bash
agent-terminal create [options] [command...]
agent-terminal create [options]
agent-terminal create [options] --shell /bin/zsh
```

### 5.2 Required behavior

- Allocate a new session ID.
- Create the session directory.
- Spawn the detached session host.
- Wait until the host reports ready or startup fails.
- Return session metadata.

### 5.3 Flags

| Flag                    | Required       | Meaning                                     |
| ----------------------- | -------------- | ------------------------------------------- |
| `--cwd <path>`          | No             | Working directory                           |
| `--rows <n>`            | No             | Initial rows; default `40`                  |
| `--cols <n>`            | No             | Initial cols; default `120`                 |
| `--env KEY=VALUE`       | No, repeatable | Additional environment variables            |
| `--term <value>`        | No             | Terminal type; default `xterm-256color`     |
| `--name <name>`         | No             | Human-friendly label                        |
| `--shell <path>`        | No             | Shell executable path; default system shell |
| `--idle-timeout-ms <n>` | No             | Optional inactivity timeout                 |

The shipped CLI also keeps `--command <path>` as a legacy alias for `--shell`.

### 5.4 JSON result shape

```json
{
  "sessionId": "session-01",
  "createdAt": "2026-03-23T12:00:00.000Z",
  "cols": 120,
  "rows": 40,
  "shell": "/bin/bash",
  "env": {
    "FOO": "bar",
    "BAZ": "qux"
  },
  "idleTimeoutMs": 5000
}
```

For the full merged session record, use `inspect <session-id> --json`. `create` currently returns only the minimal creation summary above.

### 5.5 Validation rules

- rows/cols must be positive integers.
- `--env` must reject malformed entries without `=`.
- `--shell` and legacy `--command` must resolve to a non-empty shell executable path.
- when no positional `command...` is provided, `create` launches the resolved shell path directly.

## 6. Command: `list`

List sessions known in the home directory.

### 6.1 Syntax

```bash
agent-terminal list [--all] [--json]
```

### 6.2 Behavior

- Enumerate session directories.
- Reconcile stale active-session metadata where possible.
- Return running sessions by default; include terminal sessions only when `--all` is set.
- Preserve the current directory-enumeration order; the shipped CLI does not promise an explicit sort.

### 6.3 Fields

Each item currently includes:

- `sessionId`
- `status`
- `command`
- `createdAt`
- optional `name`
- `pid`

## 7. Command: `inspect`

Return the shipped merged session summary for one session.

### 7.1 Syntax

```bash
agent-terminal inspect <session-id>
agent-terminal inspect <session-id> --json
```

### 7.2 Behavior

- Read persisted metadata from the session manifest.
- If the host is alive, ask it for the latest in-memory session record.
- If the host is unreachable for a non-terminal session, reconcile the session directory, re-read the manifest, and mark `usedOfflineReplay: true` in the result.
- Count event-log entries and compute artifact health from the artifact manifest plus on-disk files.
- Derive a read-time `terminationCategory` from the session status, exit fields, and any persisted `failureOrigin`.

### 7.3 Shipped `inspect --json` result shape (2026-03-25)

The current `result` object includes:

- `session`: the persisted `SessionRecord`, including `status`, size, command, `hostPid`, `childPid`, `exitCode`, `exitSignal`, and optional `failureReason` / `failureOrigin`,
- `eventCount`: total number of persisted event-log entries,
- `uptime`: milliseconds from `createdAt` to now for running sessions, or to `updatedAt` for terminal sessions,
- `lastEventSeq`: the last contiguous event sequence number when the event log is non-empty,
- `terminationCategory`: a derived category such as `running`, `clean-exit`, `nonzero-exit`, `signal-exit`, `host-death`, `renderer-failure`, `destroyed`, or `unknown`,
- `artifacts`: artifact-health summary with `total`, `byKind`, `missingCount`, `health`, and optional `missing` details,
- and `usedOfflineReplay`: `true` only when `inspect` had to fall back to reconciled on-disk state after a host-unreachable path.

Example `inspect --json` success envelope:

```json
{
  "ok": true,
  "command": "inspect",
  "timestamp": "2026-03-25T15:00:00.000Z",
  "result": {
    "session": {
      "version": 1,
      "sessionId": "session-01",
      "createdAt": "2026-03-19T12:00:00.000Z",
      "updatedAt": "2026-03-19T12:00:01.000Z",
      "status": "exited",
      "command": ["/bin/sh", "-lc", "echo hello"],
      "cwd": "/tmp/workspace",
      "cols": 80,
      "rows": 24,
      "hostPid": null,
      "childPid": null,
      "exitCode": 0,
      "exitSignal": null
    },
    "eventCount": 2,
    "uptime": 1000,
    "lastEventSeq": 1,
    "terminationCategory": "clean-exit",
    "artifacts": {
      "total": 2,
      "byKind": {
        "screenshot": 1,
        "snapshot": 1
      },
      "missingCount": 0,
      "health": "healthy"
    },
    "usedOfflineReplay": true
  }
}
```

### 7.4 Persisted failure origin vs derived termination category

`session.failureOrigin` is persisted manifest state and only appears when a `failed` session has a known structured origin such as `host-death` or `renderer-failure`.

`result.terminationCategory` is derived every time `inspect` runs. It is broader than `failureOrigin`: it also covers non-failure terminal states such as `clean-exit`, `nonzero-exit`, `signal-exit`, and `destroyed`. Automation should therefore treat `failureOrigin` as low-level persisted evidence and `terminationCategory` as the stable high-level summary.

The current `inspect` surface does **not** yet expose runtime renderer capability discovery or a richer live renderer-state block. Those remain future scope.

## 8. Command: `type`

Write raw UTF-8 text bytes into the PTY.

### 8.1 Syntax

```bash
agent-terminal type <session-id> 'hello world'
agent-terminal type <session-id> --file ./payload.txt
agent-terminal type <session-id> 'hello world' --append-newline
```

### 8.2 Flags

| Flag / arg          | Required                         | Meaning                |
| ------------------- | -------------------------------- | ---------------------- |
| Positional `[text]` | Exactly one of `[text]` / `--file` | Literal text to write  |
| `--file <path>`     | Exactly one of `[text]` / `--file` | Read payload from file |
| `--append-newline`  | No                               | Append `\n`            |

### 8.3 Semantics

- The shipped CLI takes literal text as the optional positional `[text]` argument; the earlier `--text` example in this doc was historical and is not a supported flag.
- `type` is not bracketed paste.
- The exact byte payload written should be represented in the event log.
- Large payloads should be supported.

## 9. Command: `paste`

Write text as a paste operation.

### 9.1 Syntax

```bash
agent-terminal paste <session-id> 'multiline\ninput'
agent-terminal paste <session-id> --file ./payload.txt
```

### 9.2 Semantics

- The shipped CLI takes literal text as the optional positional `[text]` argument or `--file <path>`; there is no separate `--text` flag.
- The shipped implementation always encodes `paste` as bracketed paste sequences.
- There is no `--force-bracketed` flag in the shipped CLI.

### 9.3 Why separate `paste` from `type`

Many TUIs treat paste and typing differently.

V1 should preserve that distinction in both the CLI and the event log.

## 10. Command: `send-keys`

Send named keys and chords.

### 10.1 Syntax

```bash
agent-terminal send-keys <session-id> Enter
agent-terminal send-keys <session-id> ctrl+l g g
agent-terminal send-keys <session-id> alt+shift+f10
```

### 10.2 Key grammar

Supported forms:

- `Enter`
- `Tab`
- `Escape`
- `Backspace`
- `Delete`
- `Insert`
- `Up`, `Down`, `Left`, `Right`
- `Home`, `End`, `PageUp`, `PageDown`
- `F1` ... `F12`
- `ctrl+<key>`
- `alt+<key>`
- `shift+<key>`
- combinations such as `ctrl+shift+p`

### 10.3 Required behavior

- key names are case-insensitive,
- output JSON currently echoes the accepted keys as supplied,
- unsupported chords should return a structured validation error,
- the event log should record both symbolic keys and emitted byte sequences when known.

### 10.4 Shipped result shape

```json
{
  "accepted": ["ctrl+l", "g", "g"],
  "bytesWritten": 5,
  "seq": 42
}
```

## 11. Command: `resize`

Resize the terminal.

### 11.1 Syntax

```bash
agent-terminal resize <session-id> --rows 50 --cols 140
```

### 11.2 Required behavior

- update PTY size,
- append a `resize` event,
- notify live render workers,
- and update persisted session metadata.

### 11.3 Shipped result fields

- `rows`
- `cols`

The shipped CLI does not currently expose `seq`, `settled`, or `--wait-for-settle-ms`; those remain future scope.

## 12. Command: `signal`

Send a process signal to the PTY child.

### 12.1 Syntax

```bash
agent-terminal signal <session-id> INT
agent-terminal signal <session-id> TERM
```

### 12.2 Required behavior

- validate signal against platform support,
- log the signal event,
- and surface a clear error on unsupported platforms.

## 13. Command: `wait`

Wait until the session reaches a condition.

### 13.1 Supported wait modes

V1 should support:

- `--text <literal>`
- `--regex <pattern>`
- `--exit`
- `--idle-ms <n>`
- `--screen-stable-ms <n>`
- `--cursor-row <n> --cursor-col <n>`

### 13.2 Syntax examples

```bash
agent-terminal wait <session-id> --text 'Ready'
agent-terminal wait <session-id> --regex 'Connected: .*'
agent-terminal wait <session-id> --idle-ms 250
agent-terminal wait <session-id> --screen-stable-ms 300
agent-terminal wait <session-id> --exit
```

### 13.3 Semantics

- `--text` and `--regex` operate on the **current visible screen text** when a renderer is available.
- before renderer initialization, the host may either:
  - initialize a renderer lazily, or
  - explicitly report that the selected wait mode requires a renderer.
- `--idle-ms` operates on PTY output timing.
- `--screen-stable-ms` requires renderer state and measures no visible-screen changes.

### 13.4 Timeout behavior

- default timeout should be finite, e.g. `30000 ms`,
- timeout should surface exit code `5`,
- JSON output should include the last observed state summary.

### 13.5 Result shape

The shipped CLI currently has two wait result shapes:

- legacy `--exit` / `--idle-ms` waits return `{ timedOut, exitCode? }`,
- render waits such as `--text`, `--regex`, `--screen-stable-ms`, and cursor waits return `{ matched, timedOut, matchedText?, cursorRow?, cursorCol?, capturedAtSeq }`.

Example render-wait result:

```json
{
  "matched": true,
  "timedOut": false,
  "matchedText": "Ready",
  "cursorRow": 12,
  "cursorCol": 3,
  "capturedAtSeq": 84
}
```

## 14. Command: `snapshot`

Capture semantic terminal state.

### 14.1 Syntax

```bash
agent-terminal snapshot <session-id>
agent-terminal snapshot <session-id> --format text
agent-terminal snapshot <session-id> --include-scrollback
agent-terminal snapshot <session-id> --include-scrollback --include-cells --json
```

### 14.2 Formats

Shipped output modes:

- `structured` (default)
- `text`

`--json` controls whether the command emits the standard JSON envelope. Per-cell data is controlled by `--include-cells` on structured snapshots rather than by a separate `cells` format.

### 14.3 Included data

- default: visible viewport only
- `--include-scrollback`: add `scrollbackLines`
- `--include-cells`: add per-cell style data in `cells`

### 14.4 Required metadata

Every structured snapshot currently includes:

- `sessionId`,
- `capturedAtSeq`,
- `rows` / `cols`,
- cursor position,
- `isAltScreen`,
- `visibleLines`,
- optional `scrollbackLines`,
- and optional `cells`.

The shipped snapshot result does not currently include renderer-backend/profile fields or a separate capture timestamp.

## 15. Command: `screenshot`

Capture a PNG screenshot from the selected renderer backend.

### 15.1 Syntax

```bash
agent-terminal screenshot <session-id>
agent-terminal screenshot <session-id> --profile reference-light
agent-terminal screenshot <session-id> --show-cursor
agent-terminal screenshot <session-id> --hide-cursor
```

### 15.2 Required behavior

- lazily initialize the renderer if needed,
- ensure the renderer has replayed through the current event sequence,
- capture a deterministic PNG,
- write artifact metadata,
- return the artifact path and dimensions.

### 15.3 Result shape

```json
{
  "sessionId": "session-01",
  "capturedAtSeq": 85,
  "profileName": "reference-dark",
  "cols": 120,
  "rows": 40,
  "artifactPath": "/home/user/.agent-terminal/sessions/.../artifacts/screenshot-85-reference-dark.png",
  "pngSizeBytes": 123456,
  "cursorVisible": false,
  "rendererBackend": "ghostty-web",
  "pixelWidth": 1920,
  "pixelHeight": 1280,
  "sha256": "...",
  "renderProfileHash": "..."
}
```

## 16. Command: `record export`

Export a replay artifact.

### 16.1 Required export formats

- `asciicast`
- `webm`

### 16.2 Syntax

```bash
agent-terminal record export <session-id> --format asciicast --out ./run.cast
agent-terminal record export <session-id> --format webm --out ./run.webm
```

### 16.3 Semantics

- `asciicast` export is derived from the event log.
- `webm` export is derived from deterministic replay through the reference renderer unless a native backend explicitly supports video export later.
- exports should be reproducible from the same event log + render profile.

## 17. Command: `destroy`

Terminate session control.

### 17.1 Syntax

```bash
agent-terminal destroy <session-id>
agent-terminal destroy <session-id> --force
```

### 17.2 Semantics

- default behavior asks the session host to shut down gracefully and keeps the session directory/artifacts.
- `--force` skips graceful shutdown and force-kills the host/child processes before reconciliation.
- if the PTY child already exited, `destroy` still reconciles the session to `destroyed`.
- artifact/session-directory purge is future scope; the shipped CLI does not support `--purge`.

### 17.3 Shipped result shape

```json
{
  "sessionId": "session-01",
  "destroyed": true
}
```

## 18. Command: `gc`

Garbage-collect old sessions and temp artifacts.

### 18.1 Syntax

```bash
agent-terminal gc --older-than 7d
agent-terminal gc --stale-only
```

### 18.2 Behavior

- never delete running sessions,
- default to temp files and explicitly stale sessions,
- `--older-than` may remove destroyed/exited sessions with artifacts only when explicitly requested.

## 19. Command: `doctor`

Validate local prerequisites.

### 19.1 Why `doctor` is mandatory in v1

The product depends on native pieces and browser automation.

`doctor` should verify:

- session home directory permissions,
- socket / named-pipe viability,
- PTY spawn viability,
- Playwright browser availability,
- renderer harness startup,
- screenshot capture viability,
- bundled font load success,
- and optional `TERM` / terminfo warnings.

### 19.2 Result shape

```json
{
  "checks": [
    { "name": "pty-spawn", "ok": true },
    { "name": "playwright-browser", "ok": true },
    { "name": "ghostty-web-render", "ok": true },
    { "name": "screenshot-export", "ok": true }
  ]
}
```

## 20. Command: `version`

The shipped `version --json` surface reports:

- `cliVersion`,
- `protocolVersion`,
- `rendererBackends`,
- and `runtime` with `node`, `platform`, and `arch`.

Example `version --json` success envelope:

```json
{
  "ok": true,
  "command": "version",
  "timestamp": "2026-03-25T15:00:00.000Z",
  "result": {
    "cliVersion": "0.1.0",
    "protocolVersion": "0.1.0",
    "rendererBackends": ["ghostty-web"],
    "runtime": {
      "node": "v24.0.0",
      "platform": "linux",
      "arch": "x64"
    }
  }
}
```

As of 2026-03-25, `rendererBackends` is a static compiled-in list containing only `ghostty-web`. Runtime capability discovery beyond that static list remains future scope and should not be inferred from the current output.

## 21. Error catalog

Current shipped structured error codes (`src/protocol/errors.ts`) are:

- `SESSION_NOT_FOUND`
- `SESSION_NOT_RUNNING`
- `SESSION_ALREADY_DESTROYED`
- `HOST_UNREACHABLE`
- `HOST_TIMEOUT`
- `INVALID_SESSION_ID`
- `INVALID_DIMENSIONS`
- `INVALID_SIGNAL`
- `INVALID_KEYS`
- `INVALID_DURATION`
- `INVALID_INPUT`
- `STORAGE_READ_ERROR`
- `STORAGE_WRITE_ERROR`
- `MANIFEST_VALIDATION_ERROR`
- `RPC_ERROR`
- `PROTOCOL_ERROR`
- `EXPORT_ERROR`
- `REPLAY_ERROR`
- `INTERNAL_ERROR`

That shipped catalog is intentionally narrower and more implementation-shaped than some earlier design-language examples. Additional taxonomy such as explicit unsupported-platform or invalid-render-profile codes should be treated as future scope until they exist in `src/protocol/errors.ts`.

## 22. Human-readable output guidance

Human output should be concise.

Examples:

- `Created session sess_01JQ... (bun run dev:tui)`
- `Resize applied: 50x140`
- `Matched text \"Ready\" after 913 ms`
- `Screenshot saved: ./artifacts/screen.png`

But JSON remains the stable automation surface.

## 23. CLI acceptance checklist

The CLI contract is complete when:

- every public command above is implemented,
- every command supports `--json`,
- failure envelopes are structured and stable,
- key grammar is canonicalized and tested,
- `doctor` catches missing browser/render dependencies,
- and the CLI can be driven end-to-end by a non-interactive agent process.

## 24. Week 6 implementation status

As of 2026-03-25, the repository has closed the highest-value Week 4–6 CLI-contract gaps that were still affecting automation and review flows:

- global root flags `--home`, `--timeout-ms`, `--no-color`, `--log-level`, and `--profile` are wired through shared CLI context handling,
- `create` supports `--env`, `--term`, `--name`, `--shell`, and `--idle-timeout-ms`,
- `type` supports file-backed input plus `--append-newline`, and `paste` supports file-backed input,
- renderer-backed cursor waits ship via `wait --cursor-row` / `--cursor-col`,
- `inspect --json` now exposes `lastEventSeq`, `terminationCategory`, artifact health, and `usedOfflineReplay`,
- `version --json` now reports the compiled-in renderer backend list as `['ghostty-web']`,
- and golden-envelope tests now lock the shipped `inspect`, `version`, and representative error envelopes.

The remaining contract work is now narrower:

- full result-shape parity with every design example in this document is still not complete,
- runtime renderer capability discovery beyond the static `rendererBackends` list remains future scope,
- and richer live renderer-state reporting in `inspect` remains future scope.
