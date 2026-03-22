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

Every JSON response should use a stable envelope.

```json
{
  "ok": true,
  "command": "inspect",
  "sessionId": "sess_01JQ...",
  "timestamp": "2026-03-19T10:00:00.000Z",
  "result": {}
}
```

Failure envelope:

```json
{
  "ok": false,
  "command": "snapshot",
  "sessionId": "sess_01JQ...",
  "timestamp": "2026-03-19T10:00:01.000Z",
  "error": {
    "code": "SESSION_NOT_RUNNING",
    "message": "Cannot capture a live snapshot because the session was already destroyed.",
    "retryable": false,
    "details": {}
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
agent-terminal create [options] -- <command> [args...]
agent-terminal create [options] --shell -- '<shell command>'
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
| `--profile <name>`      | No             | Initial render profile                      |
| `--shell`               | No             | Interpret trailing argument through a shell |
| `--idle-timeout-ms <n>` | No             | Optional inactivity timeout                 |

### 5.4 JSON result shape

```json
{
  "session": {
    "id": "sess_01JQ...",
    "name": "demo",
    "status": "running",
    "cwd": "/repo",
    "command": ["bun", "run", "dev:tui"],
    "shell": false,
    "rows": 40,
    "cols": 120,
    "term": "xterm-256color",
    "renderProfile": "reference-dark",
    "createdAt": "2026-03-19T10:00:00.000Z",
    "hostPid": 12345,
    "childPid": 12346
  }
}
```

### 5.5 Validation rules

- Direct exec mode requires at least one trailing argument after `--`.
- `--shell` requires exactly one shell string after `--`.
- rows/cols must be positive integers.
- `--env` must reject malformed entries without `=`.

## 6. Command: `list`

List sessions known in the home directory.

### 6.1 Syntax

```bash
agent-terminal list [--all] [--json]
```

### 6.2 Behavior

- Enumerate session directories.
- Reconcile stale metadata where possible.
- Return summaries sorted by creation time descending.

### 6.3 Fields

Each item should include:

- `id`
- `name`
- `status`
- `commandPreview`
- `cwd`
- `createdAt`
- `updatedAt`
- `childPid`
- `lastOutputAt`
- `artifacts`

## 7. Command: `inspect`

Return full session metadata.

### 7.1 Syntax

```bash
agent-terminal inspect <session-id>
```

### 7.2 Behavior

- Read persisted metadata.
- If the host is alive, ask it for the latest in-memory state.
- Return a merged view.

### 7.3 Result shape highlights

The result should include:

- session metadata,
- current size,
- last event sequence,
- exit info if present,
- renderer state summary,
- artifact counts,
- and last known timing data.

## 8. Command: `type`

Write raw UTF-8 text bytes into the PTY.

### 8.1 Syntax

```bash
agent-terminal type <session-id> --text 'hello world'
agent-terminal type <session-id> --file ./payload.txt
```

### 8.2 Flags

| Flag               | Required                 | Meaning                |
| ------------------ | ------------------------ | ---------------------- |
| `--text <value>`   | Exactly one of text/file | Literal text to write  |
| `--file <path>`    | Exactly one of text/file | Read payload from file |
| `--append-newline` | No                       | Append `\n`            |

### 8.3 Semantics

- `type` is not bracketed paste.
- The exact byte payload written should be represented in the event log.
- Large payloads should be supported.

## 9. Command: `paste`

Write text as a paste operation.

### 9.1 Syntax

```bash
agent-terminal paste <session-id> --text 'multiline\ninput'
agent-terminal paste <session-id> --file ./payload.txt
```

### 9.2 Semantics

- If bracketed paste mode is active, send bracketed paste sequences.
- If bracketed paste mode is not active, either:
  - fall back to raw text and mark `bracketed: false`, or
  - allow `--force-bracketed` to emit bracketed sequences anyway.

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
- output JSON should echo canonicalized keys,
- unsupported chords should return a structured validation error,
- the event log should record both symbolic keys and emitted byte sequences when known.

### 10.4 Suggested result shape

```json
{
  "accepted": ["Ctrl+L", "g", "g"],
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

### 11.3 Result fields

- `rows`
- `cols`
- `seq`
- `settled` optional when `--wait-for-settle-ms` is used

### 11.4 Optional quality-of-life flag

`--wait-for-settle-ms <n>` may be supported to block until no new PTY output is observed for the given duration after the resize.

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

```json
{
  "condition": {
    "type": "text",
    "value": "Ready"
  },
  "matchedAtSeq": 84,
  "elapsedMs": 913,
  "screenSummary": {
    "rows": 40,
    "cols": 120,
    "cursor": { "row": 12, "col": 3 },
    "textPreview": "..."
  }
}
```

## 14. Command: `snapshot`

Capture semantic terminal state.

### 14.1 Syntax

```bash
agent-terminal snapshot <session-id>
agent-terminal snapshot <session-id> --format text
agent-terminal snapshot <session-id> --scope viewport
agent-terminal snapshot <session-id> --scope scrollback --lines 500
agent-terminal snapshot <session-id> --out ./snapshot.json
```

### 14.2 Formats

Required output modes:

- `json` (default when `--json` is present)
- `text`
- `cells`

### 14.3 Scopes

- `viewport`
- `scrollback`
- `all`

### 14.4 Required metadata

Every structured snapshot must include:

- session ID,
- renderer backend,
- renderer profile,
- rows/cols,
- cursor state,
- alt-screen flag,
- visible lines,
- optional cells,
- last replayed sequence,
- and capture timestamp.

## 15. Command: `screenshot`

Capture a PNG screenshot from the selected renderer backend.

### 15.1 Syntax

```bash
agent-terminal screenshot <session-id>
agent-terminal screenshot <session-id> --out ./screen.png
agent-terminal screenshot <session-id> --profile reference-light
agent-terminal screenshot <session-id> --cursor off
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
  "artifact": {
    "id": "shot_01JQ...",
    "kind": "screenshot",
    "backend": "ghostty-web",
    "profile": "reference-dark",
    "path": "/home/user/.agent-terminal/sessions/.../screenshots/shot.png",
    "sha256": "...",
    "width": 1920,
    "height": 1280,
    "capturedAtSeq": 85
  }
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
agent-terminal destroy <session-id> --purge
```

### 17.2 Semantics

- default behavior terminates the session host and child process but keeps artifacts.
- `--purge` additionally removes the session directory.
- if the PTY child already exited, `destroy` still cleans host resources.

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

Should report:

- CLI version,
- protocol version,
- renderer backends compiled in,
- and runtime environment summary when `--json` is used.

## 21. Error catalog

Recommended structured error codes:

- `USAGE_ERROR`
- `SESSION_NOT_FOUND`
- `SESSION_NOT_RUNNING`
- `SESSION_ALREADY_DESTROYED`
- `HOST_START_FAILED`
- `PTY_SPAWN_FAILED`
- `RENDERER_START_FAILED`
- `RENDERER_REPLAY_FAILED`
- `WAIT_TIMEOUT`
- `ARTIFACT_WRITE_FAILED`
- `DEPENDENCY_MISSING`
- `UNSUPPORTED_PLATFORM`
- `UNSUPPORTED_KEY_CHORD`
- `INVALID_SIGNAL`
- `INVALID_RENDER_PROFILE`
- `INVALID_STATE_TRANSITION`

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

## 24. Week 4 implementation status

As of 2026-03-22, Week 4 closed several of the highest-value CLI contract gaps:

- shipped global root flags `--home`, `--timeout-ms`, and `--no-color` via a shared command context,
- shipped differentiated process exit codes `0` through `8` via structured error-to-exit-code mapping,
- shipped `create` options `--env`, `--term`, `--name`, and `--shell`,
- shipped file-backed input for `type` and `paste` via `--file`,
- and shipped renderer-backed cursor waits via `wait --cursor-row` / `--cursor-col`.

The following contract items remain future work:

- `--log-level`,
- a true global `--profile` override surface,
- `--idle-timeout-ms`,
- `--append-newline`,
- config-file loading and the broader config/env precedence story beyond `AGENT_TERMINAL_HOME`,
- and full JSON envelope/result-shape alignment with every example in this contract.
