# Lifecycle proof bundle

- **Date:** 2026-03-19
- **Scenario:** Full session lifecycle against the `hello-prompt` fixture
- **Fixture command:** `node --import tsx ../../test/fixtures/apps/hello-prompt/main.ts`
- **Session ID:** `01KM3M69V23RWMMDMS1EK3ZXB4`
- **Isolation:** run under a fresh `AGENT_TERMINAL_HOME=$(mktemp -d)` so only this scenario's state was present
- **Overall result:** pass; every JSON envelope in this directory has `ok: true`

## What was run

This scenario exercises the Week 1 control-plane lifecycle end to end: create, list, inspect, type, send Enter, wait for idle, paste, resize, signal, wait for exit, inspect the exited session, and destroy it.

For the `create` step, the working invocation was `create --json -- node --import tsx ...` so the CLI parsed `--json` as a control-plane flag and `--import tsx ...` as the child command.

## Step-by-step review guide

| Step | File                      | What the command did                                                 | What the reviewer should observe                                                                                                                 |
| ---- | ------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | `01-create.json`          | Created a session running the `hello-prompt` fixture.                | `ok: true`, `command: "create"`, and `result.sessionId == "01KM3M69V23RWMMDMS1EK3ZXB4"`.                                                         |
| 2    | `02-list.json`            | Listed all sessions in the isolated home directory.                  | Exactly one session is present; its `sessionId` matches step 1, its `status` is `running`, and the command array points at the fixture.          |
| 3    | `03-inspect-live.json`    | Inspected the live session before any interaction.                   | `status: "running"`, `cols: 80`, `rows: 24`, and populated `hostPid` / `childPid`. `exitCode` and `exitSignal` are still `null`.                 |
| 4    | `04-type.json`            | Sent literal text `hello world` to the PTY without pressing Enter.   | Ack-only envelope: `ok: true` with an empty `result` object. The effect is visible in `event-log.jsonl` at seq 1-2.                              |
| 5    | `05-send-keys.json`       | Sent the `Enter` key to submit the typed line.                       | Ack-only envelope. In the event log, seq 3-5 shows the Enter key, a newline, and the fixture response `ECHO: hello world` followed by `READY> `. |
| 6    | `06-wait-idle.json`       | Waited for the session to go idle after the first prompt round-trip. | `timedOut: false`, proving the prompt settled within the 10s timeout.                                                                            |
| 7    | `07-paste.json`           | Sent a paste payload containing `pasted-content`.                    | Ack-only envelope. In the event log, seq 6 records `input_paste` with bracketed-paste wrappers and seq 7 shows the raw terminal echo.            |
| 8    | `08-send-keys-enter.json` | Sent `Enter` so the pasted line would execute.                       | Ack-only envelope. Event-log seq 8-9 shows the Enter key and the fixture response `ECHO: pasted-content` followed by another prompt.             |
| 9    | `09-wait-idle-2.json`     | Waited for idle after the paste flow.                                | `timedOut: false`, confirming the second prompt cycle completed.                                                                                 |
| 10   | `10-resize.json`          | Resized the PTY to 120x40.                                           | `result.cols == 120` and `result.rows == 40`.                                                                                                    |
| 11   | `11-inspect-resized.json` | Re-inspected the live session after resize.                          | Session is still `running`, and `cols` / `rows` now read `120` / `40`.                                                                           |
| 12   | `12-signal.json`          | Delivered `SIGINT` to the session.                                   | `signal: "SIGINT"` and `delivered: true`.                                                                                                        |
| 13   | `13-wait-exit.json`       | Waited specifically for process exit.                                | `timedOut: false` and `exitCode: 130`, matching a Ctrl-C style termination.                                                                      |
| 14   | `14-inspect-exited.json`  | Inspected the terminated session before deletion.                    | `status: "exited"`, `exitCode: 130`, and the resized dimensions `120x40` are still preserved in metadata.                                        |
| 15   | `15-destroy.json`         | Deleted the session record from the isolated home directory.         | `destroyed: true` and the same `sessionId` appears in the result.                                                                                |

## Event log observations

- `event-log.jsonl` has 14 entries with monotonic sequence numbers `0` through `13`.
- The first entry is prompt output: `READY> `.
- The typed-text path is visible as `input_text` followed by echoed output.
- The paste path is distinct: seq 6 is `input_paste` and contains bracketed-paste control wrappers (`[200~` / `[201~`).
- The resize is recorded explicitly at seq 10 with `cols: 120` and `rows: 40`.
- The shutdown path is visible as `signal` -> `output` (`INTERRUPTED`) -> `exit` with `exitCode: 130`.

## Known gaps

- No renderer screenshots are included because the renderer path is not implemented yet.
- No asciicast export is available yet, so the proof is JSON/event-log based rather than video based.
- The `gc` command is not implemented yet, so garbage-collection behavior is out of scope for this bundle.

## Additional notes

- No command failed during this run, so there are no expected `ok: false` envelopes to explain.
- The bundle is intentionally self-contained for reviewer consumption: the JSON envelopes show command results, and `event-log.jsonl` shows the terminal-side evidence those commands produced.
