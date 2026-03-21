# Week 3 renderer-complete dogfood proof bundle

- **Date:** 2026-03-21T21:48:34Z
- **Bundle:** `dogfood/20260321-week3-renderer-complete/`
- **Renderer session ID:** `01KM95Y7RFQZ11N60DR204NK1T`
- **Renderer AGENT_TERMINAL_HOME:** `/tmp/agent-terminal-week3-bundles.Bo0MbU/home.8BRlbs`
- **GC demo AGENT_TERMINAL_HOME:** `/tmp/agent-terminal-week3-bundles.Bo0MbU/home.Ubuxel`
- **Environment:** Node `v24.14.0` on `Linux 6.8.0-94-generic x86_64 GNU/Linux`
- **Headless note:** This bundle was collected in a headless environment, so the reviewer evidence is the CLI JSON envelopes, copied PNG screenshots, copied snapshot artifacts, exported asciicast/WebM recordings, and copied session manifests/event logs.

## Artifacts

| File | Description |
| --- | --- |
| `commands.sh` | Exact shell commands used to generate the renderer-complete bundle. |
| `agent-terminal-home.txt` | The isolated home used for the renderer-complete scenario. |
| `session-id.txt` | Session ID for the main renderer scenario. |
| `doctor.json` | `doctor --json` output proving all environment and renderer checks passed. |
| `create-output.json` | Session creation result for the live renderer session. |
| `wait-text.json` | `wait --text 'Ready'` result proving renderer-visible content appeared. |
| `type-output.json` | `type` result for the live interaction. |
| `wait-regex.json` | Renderer regex wait proving the typed text became visible in the live terminal. |
| `snapshot-structured-live.json` | Live structured snapshot JSON envelope. |
| `snapshot-text-live.json` | Live text snapshot JSON envelope. |
| `screenshot-dark-live.json` | Live dark-profile screenshot JSON envelope. |
| `screenshot-light-live.json` | Live light-profile screenshot JSON envelope. |
| `record-asciicast-live.json` | Live asciicast export JSON envelope. |
| `destroy-output.json` | Session destroy result. |
| `snapshot-structured-post-exit.json` | Post-exit structured snapshot JSON envelope proving offline replay. |
| `screenshot-dark-post-exit.json` | Post-exit dark screenshot JSON envelope proving offline replay. |
| `record-webm-post-exit.json` | Post-exit WebM export JSON envelope proving video export on an exited session. |
| `manifest.json` | Final copied artifact manifest from the session home. |
| `session-manifest.json` | Final copied session manifest showing the exited session state. |
| `event-log.jsonl` | Raw event log copied from the isolated session home. |
| `artifacts/live-snapshot-structured-artifact.json` | Snapshot artifact file copied immediately after the live structured snapshot. |
| `artifacts/live-snapshot-text-artifact.json` | Snapshot artifact file copied immediately after the live text snapshot. |
| `artifacts/post-exit-snapshot-structured-artifact.json` | Snapshot artifact file copied after post-exit offline replay. |
| `artifacts/live-reference-dark.png` | Live screenshot PNG copied from the session artifact path. |
| `artifacts/live-reference-light.png` | Live light-theme screenshot PNG copied from the session artifact path. |
| `artifacts/post-exit-reference-dark.png` | Post-exit screenshot PNG copied from the offline replay artifact path. |
| `artifacts/session-live.cast` | Asciicast exported from the still-running session. |
| `artifacts/session-post-exit.webm` | WebM exported after the session had already been destroyed. |
| `gc/commands.sh` | Exact shell commands used for the GC sub-demo. |
| `gc/agent-terminal-home.txt` | Isolated home used only for the GC demo. |
| `gc/session-id.txt` | Temporary session ID used for the GC demo. |
| `gc/create-output.json` | GC demo session creation result. |
| `gc/destroy-output.json` | GC demo destroy result. |
| `gc/gc-dry-run.json` | `gc --dry-run --json` output showing what would be removed. |
| `gc/gc.json` | `gc --json` output showing the session was actually removed. |
| `gc/list-all.json` | `list --all --json` output proving the removed GC session no longer appears. |

## Verification claims

- `doctor.json` reports `ok: true` and every environment/renderer check has `status: pass`.
- `wait-text.json` matched the live `Ready` line before evidence capture began.
- `wait-regex.json` matched the visible `week3 renderer bundle` text, so the live recording contains interaction beyond the initial prompt.
- The live text snapshot and the post-exit structured snapshot both capture the same terminal text at sequence `4`, and the post-exit structured snapshot remained at sequence `5` after destroy.
- The live dark screenshot SHA256 is `b04565d5ba4c63044469f42ee468ae1900c4274c7ce5704ce0493367becc0967` and the post-exit dark screenshot SHA256 is `b04565d5ba4c63044469f42ee468ae1900c4274c7ce5704ce0493367becc0967`; the files were identical, which helps reviewers judge whether offline replay reproduced the exact same frame bytes.
- `record-asciicast-live.json` proves asciicast export works on a running session, and `record-webm-post-exit.json` proves WebM export works after the session has exited.
- `manifest.json` shows the copied snapshot, screenshot, recording, and video artifacts recorded against the renderer session.
- GC dry-run reported `1` removable session(s), the actual GC run removed the temporary session `01KM95YX5WZBJ570QW3AMD1RJT`, and `gc/list-all.json` shows `0` remaining session(s) in the isolated GC home.

## Issues encountered

- No blocking issues were encountered during bundle generation.
- WebM export can take longer than the other commands, so the generator script retries WebM export once before failing in order to reduce flake risk.
