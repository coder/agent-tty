# Resize demo proof bundle

- **Date:** 2026-03-19
- **Scenario:** Resize behavior against the `resize-demo` fixture
- **Fixture command:** `node --import tsx ../../test/fixtures/apps/resize-demo/main.ts`
- **Session ID:** `01KM3M6RF40VCPP4WR580KDBE0`
- **Isolation:** run under a fresh `AGENT_TERMINAL_HOME=$(mktemp -d)` so only this scenario's state was present
- **Overall result:** pass; every JSON envelope in this directory has `ok: true`

## What was run

This scenario focuses on PTY size propagation. The fixture prints its current size on startup and again after resize, which makes it a compact proof that the control plane can create, wait, resize, observe the new size, inspect metadata, and destroy the session.

For the `create` step, the working invocation was `create --json --cols 80 --rows 24 -- node --import tsx ...` so the size flags were consumed by the control plane and the remainder was passed to the child process.

## Step-by-step review guide

| Step | File                  | What the command did                                         | What the reviewer should observe                                                                       |
| ---- | --------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 1    | `01-create.json`      | Created a session with explicit initial dimensions `80x24`.  | `ok: true`, `command: "create"`, and `result.sessionId == "01KM3M6RF40VCPP4WR580KDBE0"`.               |
| 2    | `02-wait-idle.json`   | Waited for the fixture's initial size print to complete.     | `timedOut: false`. The corresponding event-log output at seq 0 is `SIZE: 80x24`.                       |
| 3    | `03-resize.json`      | Resized the PTY to `120x40`.                                 | `result.cols == 120` and `result.rows == 40`.                                                          |
| 4    | `04-wait-idle-2.json` | Waited for the fixture to emit its post-resize size message. | `timedOut: false`. The event log records the new output `SIZE: 120x40`.                                |
| 5    | `05-inspect.json`     | Inspected the still-running session after the resize.        | `status: "running"`, `cols: 120`, `rows: 40`, and the command array points at the resize-demo fixture. |
| 6    | `06-destroy.json`     | Force-destroyed the session after collecting evidence.       | `destroyed: true` with the matching `sessionId`.                                                       |

## Event log observations

- `event-log.jsonl` has 3 entries with monotonic sequence numbers `0` through `2`.
- Seq 0 shows the initial size report `SIZE: 80x24`.
- Seq 1 shows the updated size report `SIZE: 120x40` after the resize command.
- Seq 2 records the explicit `resize` event with `cols: 120` and `rows: 40`.
- Notably, the fixture's output for the new size lands just before the explicit resize event entry in this run, so reviewers should treat both lines together as the resize proof rather than assuming a stricter output-before/after ordering contract.

## Known gaps

- No renderer screenshots are included because the renderer path is not implemented yet.
- No asciicast export is available yet, so the proof is JSON/event-log based rather than video based.
- The `gc` command is not implemented yet, so garbage-collection behavior is out of scope for this bundle.

## Additional notes

- No command failed during this run, so there are no expected `ok: false` envelopes to explain.
- This fixture is intentionally narrow: it exists to prove resize propagation rather than interactive input handling.
