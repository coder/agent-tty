# Week 4 CLI parity dogfood notes

- **Date:** 2026-03-22
- **Bundle:** `dogfood/20260322-week4-cli-parity/`
- **CLI entrypoint:** `node --import tsx ./src/cli/main.ts`
- **Fixture:** `test/fixtures/apps/hello-prompt/main.ts`
- **Session ID:** `01KMBMAD8A2SVYXCAZR7MW8RT7`
- **Isolated home:** `/tmp/agent-terminal-week4-cli-parity-CsrjVz`
- **Runtime:** Node `v22.19.0`, npm `10.9.3`, shell flag exercised as `--shell /bin/bash`
- **Install prerequisite used:** `npm ci --ignore-scripts`

## Scenario summary

This bundle captures an end-to-end CLI parity run for the Week 4 feature slice:

- explicit `--home` isolation for every CLI command
- `create` with `--name`, `--term`, `--env`, and `--shell`
- file-based input via `type --file`
- readiness via `wait --idle-ms`
- text wait via `wait --text`
- cursor wait via `wait --cursor-row` and `--cursor-col`
- cleanup via `destroy --force`

I checked CLI help before the run to confirm the relevant flags exist:

- top-level help exposes `--home`
- `create --help` exposes `--shell`, `--env`, `--term`, and `--name`
- `type --help` exposes `--file`
- `wait --help` exposes `--cursor-row` and `--cursor-col`

Because the feature under test is the explicit `--home` flag, I used `--home <tmpdir>` on every command rather than relying only on `AGENT_TERMINAL_HOME`.

## Reviewer guide

| File | Proof provided |
| --- | --- |
| `00-list-empty.json` | The fresh `--home` directory starts empty (`sessions: []`), proving isolation from any pre-existing default home state. |
| `01-create.json` | Session creation succeeded while explicitly passing `--name cli-parity-test`, `--term xterm-256color`, `--env FOO=bar`, `--env BAZ=qux`, `--shell /bin/bash`, and `--home <tmpdir>`. |
| `02-inspect.json` | The live session manifest records the expected fixture command plus `name`, `env`, and `term` values. |
| `03-list.json` | Listing against the same isolated home returns exactly one live session, matching the created session ID. |
| `04-wait-idle.json` | `wait --idle-ms 500 --timeout 10000` completed without timing out, showing the `hello-prompt` fixture reached an idle ready state. |
| `05-type-file.json` | `type --file` accepted file-based input from a temp file containing `hello from file\n`. |
| `06-send-enter.json` | `send-keys Enter` succeeded against the live session. |
| `07-wait-echo.json` | `wait --text "hello from file"` matched in rendered output at sequence 5. |
| `08-snapshot.json` | The text snapshot captures the visible transcript and reports cursor position `row 4`, `col 7`. |
| `09-wait-cursor.json` | `wait --cursor-row 4 --cursor-col 7` matched successfully, proving cursor-based waits work against rendered output. |
| `10-destroy.json` | The session was destroyed cleanly after evidence capture. |

## Verification claims

1. **`--home` isolation worked end-to-end.** `00-list-empty.json` begins with zero sessions, while `03-list.json` shows the created session under the same isolated home, demonstrating the run was scoped to a dedicated temp home.
2. **Create options were exercised successfully.** `01-create.json` shows create succeeded, and `02-inspect.json` confirms the resulting session manifest preserved the requested `name`, `env`, and `term` values while launching the `hello-prompt` fixture.
3. **File-based input worked through the CLI.** `05-type-file.json` succeeded and `07-wait-echo.json` later matched `hello from file`, proving the file-backed typed input reached the child process.
4. **Cursor waits worked with actual rendered state.** `08-snapshot.json` reported cursor position `(4, 7)`, and `09-wait-cursor.json` matched that exact row/column tuple.
5. **Lifecycle cleanup completed.** `10-destroy.json` reports the session was destroyed after the proof sequence finished.

## Issues / limitations encountered

- Running the task-mandated `npm ci --ignore-scripts` left `node-pty` without a built native addon in this workspace, so the CLI could not start until I manually rebuilt `node_modules/node-pty` with `node-gyp`.
- The workspace runtime was Node `v22.19.0`, while `package.json` declares `>=24.0.0 <25`. After rebuilding `node-pty` for the active runtime, the CLI commands in this bundle executed successfully.
- The requested temp input file intentionally contained a trailing newline (`hello from file\n`). As a result, `type --file` submitted one completed line before `06-send-enter.json` added an extra Enter; the snapshot therefore shows both `ECHO: hello from file` and a later blank `ECHO:` line. This does not affect the proof that file-based typing and `send-keys` both worked.
- `create --help` confirms that `--shell` is a real flag and `01-create.json` proves the command accepted it, but `inspect` does not persist the shell path when a direct command array is provided. In this scenario the stronger persisted evidence is `name`/`env`/`term`, while shell-path proof is acceptance-by-success plus the preflight help check.

## Live capture ideas

This bundle is JSON-only because the task asked specifically for CLI envelopes. In a GUI-capable environment, the same scenario could also capture:

- a short terminal video from create through destroy
- a screenshot immediately after `07-wait-echo.json` showing the echoed text
- a screenshot immediately after `09-wait-cursor.json` highlighting the cursor resting at row 4, column 7
- an exported structured snapshot artifact alongside the text snapshot for easier visual diffing

Those extra artifacts would make review more visual, but the JSON files here are already sufficient to verify the requested CLI parity behavior.
