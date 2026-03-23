# 2026-03-22 week4 scrollback review

## Bundle metadata

- Date: 2026-03-22
- Bundle path: `dogfood/20260322-week4-scrollback-review/`
- Workspace: `/home/coder/.mux/src/agent-terminal/agent_exec_1ce545e4ca`
- CLI executable: `node --import tsx ./src/cli/main.ts`
- Fixture: `test/fixtures/apps/scrollback-demo/main.ts`
- Environment: Node v22.19.0, npm 10.9.3, `AGENT_TERMINAL_HOME=/tmp/tmp.IaQz2Y0DK9`
- Session ID: `01KMBM97GGVVAKKQEJ4ZMYV67J`

## Scenario summary

This live capture exercises the `scrollback-demo` fixture in a 10-row by 80-column terminal to compare the default viewport-only snapshot path with `--include-scrollback` and to export an asciicast recording. The fixture emits 80 numbered lines (`LINE 001` through `LINE 080`) followed by `SCROLLBACK COMPLETE`, so early lines should have moved into scrollback once the process finishes.

## Reviewer guide

| File                          | What it proves                                                                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-create.json`              | The create command succeeded and returned session `01KMBM97GGVVAKKQEJ4ZMYV67J` for the requested small-viewport run.                                                 |
| `02-wait-exit.json`           | The fixture exited successfully with `exitCode: 0` and `timedOut: false`.                                                                                            |
| `03-snapshot-viewport.json`   | The default text snapshot captured the same first 10 lines of transcript (`SCROLLBACK DEMO START` plus `LINE 001` through `LINE 009`); it did not expose `LINE 080`. |
| `04-snapshot-scrollback.json` | The structured snapshot with `--include-scrollback` returned `visibleLines` only and did not include a populated `scrollbackLines` array.                            |
| `05-record-asciicast.json`    | The asciicast export succeeded, produced a 3531-byte recording, and points at a copied companion cast file under `artifacts/recording-1-asciicast.cast`.             |
| `06-screenshot.json`          | Screenshot capture succeeded with the `reference-dark` profile; the copied PNG is at `artifacts/screenshot-1-reference-dark.png`.                                    |
| `07-destroy.json`             | Session lifecycle cleanup completed with `destroyed: true`.                                                                                                          |

## Example line checks

Expected for this scenario:

- `LINE 001` should be historical output once the 80-line fixture completes.
- `LINE 080` should be part of the final viewport.

Observed in this capture:

| Line                  | Expected proof path                        | Observed result                                                                                                                       |
| --------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `LINE 001`            | scrollback or full-session recording only  | Present in `03-snapshot-viewport.json`, `04-snapshot-scrollback.json`, and the asciicast export.                                      |
| `LINE 080`            | final viewport plus full-session recording | Confirmed in `artifacts/recording-1-asciicast.cast`, but not present in `03-snapshot-viewport.json` or `04-snapshot-scrollback.json`. |
| `SCROLLBACK COMPLETE` | final output sentinel                      | Confirmed in `artifacts/recording-1-asciicast.cast`, but not present in the two snapshot JSON outputs.                                |

## Verification claims

- The fixture completed normally: `02-wait-exit.json` reports `exitCode: 0` without timeout.
- Small-terminal geometry is preserved through the proof artifacts: `03-snapshot-viewport.json`, `04-snapshot-scrollback.json`, and `06-screenshot.json` all report `rows: 10` and `cols: 80`.
- The default text snapshot and the structured snapshot with `--include-scrollback` both capture the same initial 10 lines rather than a final scrolled viewport.
- The exported asciicast preserves the full session history, including `LINE 001`, `LINE 080`, and `SCROLLBACK COMPLETE`.
- The copied screenshot PNG and copied asciicast file make the bundle reviewable without depending on the temporary `AGENT_TERMINAL_HOME` path embedded in the raw JSON.

## Limitations

- `04-snapshot-scrollback.json` does not contain a `scrollbackLines` field. In this run, the current structured snapshot path did not expose additional scrollback data even when invoked with `--include-scrollback`.
- The two snapshot JSON outputs show the beginning of the transcript instead of a final viewport containing `LINE 080`. This means the current implementation does not yet demonstrate the intended viewport-versus-scrollback distinction for this fixture through the snapshot commands alone.
- `01-create.json` confirms successful session creation but does not echo the requested geometry directly; the 10x80 viewport is verified by the later snapshot and screenshot outputs.
- Because `05-record-asciicast.json` and `06-screenshot.json` store absolute artifact paths under a temporary home directory, this bundle includes copied companion artifacts under `artifacts/` for durable review.

## Live capture

1. Installed dependencies with `npm ci --ignore-scripts`.
2. Manually rebuilt `node-pty` for the local Node v22.19.0 runtime after the ignored install scripts left the native module unavailable.
3. Ran the requested `create`, `wait`, `snapshot`, `record export`, `screenshot`, and `destroy` commands against the live `scrollback-demo` fixture using `AGENT_TERMINAL_HOME=/tmp/tmp.IaQz2Y0DK9`.
4. Copied the exported asciicast and screenshot artifacts into `artifacts/` so reviewers can inspect the recording and PNG directly from the repository bundle.
