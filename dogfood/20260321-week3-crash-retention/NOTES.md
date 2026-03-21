# Week 3 crash-retention dogfood proof bundle

- **Date:** 2026-03-21T21:48:34Z
- **Bundle:** `dogfood/20260321-week3-crash-retention/`
- **Crash session ID:** `01KM95Z3QSQKN28SVD03BP28Z2`
- **AGENT_TERMINAL_HOME:** `/tmp/agent-terminal-week3-bundles.Bo0MbU/home.KGOAC6`
- **Environment:** Node `v24.14.0` on `Linux 6.8.0-94-generic x86_64 GNU/Linux`
- **Headless note:** Review this bundle via the JSON envelopes plus the copied snapshot/screenshot/recording/video artifacts.

## Artifacts

| File | Description |
| --- | --- |
| `commands.sh` | Exact shell commands used to generate the crash-retention bundle. |
| `agent-terminal-home.txt` | The isolated home used for the crash-retention scenario. |
| `session-id.txt` | Session ID for the crash-retention scenario. |
| `doctor.json` | `doctor --json` output proving the environment and renderer checks passed before running the crash scenario. |
| `create-output.json` | Session creation result for the crashing command. |
| `wait-exit.json` | `wait --exit --json` result capturing the crash exit code. |
| `inspect-post-crash.json` | `inspect --json` result showing the session remains persisted after the abnormal exit. |
| `snapshot-post-crash.json` | Offline replay snapshot taken after the crash. |
| `screenshot-post-crash.json` | Offline replay screenshot taken after the crash. |
| `record-asciicast-post-crash.json` | Asciicast export JSON envelope from the crashed session. |
| `record-webm-post-crash.json` | WebM export JSON envelope from the crashed session. |
| `manifest.json` | Final copied artifact manifest from the crash session home. |
| `session-manifest.json` | Copied session manifest showing the persisted exited state and crash metadata. |
| `event-log.jsonl` | Raw event log copied from the crash session home. |
| `artifacts/post-crash-snapshot-structured-artifact.json` | Snapshot artifact copied after offline replay. |
| `artifacts/post-crash-reference-dark.png` | Screenshot PNG copied after offline replay. |
| `artifacts/session-post-crash.cast` | Asciicast exported from the crashed session. |
| `artifacts/session-post-crash.webm` | WebM exported from the crashed session. |

## Verification claims

- `doctor.json` reports `ok: true` and all checks passed before the crash scenario ran.
- `wait-exit.json` captured exit code `42`, demonstrating non-zero exit retention.
- `inspect-post-crash.json` shows the session persisted in `exited` state after the abnormal termination rather than disappearing.
- `snapshot-post-crash.json` and `screenshot-post-crash.json` prove offline replay remained available after the crash.
- `record-asciicast-post-crash.json` and `record-webm-post-crash.json` prove recording export also remained available after the crash.
- `manifest.json`, `session-manifest.json`, and `event-log.jsonl` preserve the evidence that remained after the process exited non-zero.

## Issues encountered

- No blocking issues were encountered during bundle generation.
- As with the renderer bundle, the generator retries WebM export once before failing because video export is the slowest step.
