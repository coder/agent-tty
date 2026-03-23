# Week 5 — Offline Replay Proof

- **Bundle:** `dogfood/20260323-week5-recovery-replay/`
- **Created at:** 2026-03-23T16:11:04Z
- **Session ID:** `01KMDQCW908P2QQNZC9066VEGX`
- **Host PID:** `1065779`
- **AGENT_TERMINAL_HOME:** `/tmp/tmp.RcD4yXCdJh`
- **Environment:** Node `v22.19.0` on `Linux 6.8.0-94-generic x86_64 GNU/Linux`

## Scenario

This bundle proves the offline replay recovery flow documented by `test/unit/replay/offlineReplay.test.ts` and the `failed session supports offline snapshot` integration coverage in `test/integration/lifecycle.test.ts`. The CLI flow was: create a live session, wait for `offline-test-data` to appear, capture a live snapshot, crash the host with `kill -9 1065779`, reconcile the failed session with `inspect`, and then capture an offline text snapshot that reconstructs terminal state from `logs/events.jsonl`.

## Key proof

The authoritative proof is `07-snapshot-offline.json`. Its JSON envelope contains `result.text` with `offline-test-data` even after the host process was forcibly terminated. That reconstructed transcript is copied verbatim to `snapshots/02-snapshot-offline.json`.

## Live vs offline comparison

- `03-snapshot-live.json` captured the live terminal state before the crash and contains `offline-test-data`.
- `07-snapshot-offline.json` captured the post-crash offline replay state and still contains `offline-test-data`.
- `snapshots/01-snapshot-live.json` and `snapshots/02-snapshot-offline.json` are direct copies of those two envelopes for quick review.
- `06-inspect-failed.json` records the failed-session state after the host crash and proves the session remained inspectable for offline replay.
- `logs/events.jsonl` is the canonical event log consumed to reconstruct the offline terminal state.

## Artifact guide

| File | Role |
| --- | --- |
| `01-create.json` | Session creation envelope for the /bin/sh offline replay scenario. |
| `02-wait-ready.json` | Wait proof that the live terminal emitted `offline-test-data`. |
| `03-snapshot-live.json` | Live text snapshot before killing the host. |
| `04-screenshot-live.json` | Live screenshot envelope before the crash (optional capture). |
| `05-kill-host.json` | Recorded `kill -9` action against host PID `1065779`. |
| `06-inspect-failed.json` | Post-crash inspect envelope showing the reconciled failed session. |
| `07-snapshot-offline.json` | Offline replay text snapshot after the crash; the key proof artifact. |
| `08-screenshot-offline.json` | Offline screenshot envelope after host failure (optional capture). |
| `09-export-asciicast.json` | Optional asciicast export envelope from the failed session. |
| `logs/10-vitest-offline-replay.log` | Unit-test proof for offline replay reconstruction. |
| `logs/11-vitest-offline-snapshot.log` | Integration-test proof for failed-session offline snapshot support. |

## Screenshot and recording notes

- Live screenshot capture succeeded; see `screenshots/01-screenshot-live.png` and `04-screenshot-live.json`.
- Offline screenshot capture succeeded; see `screenshots/02-screenshot-offline.png` and `08-screenshot-offline.json`.
- Asciicast export succeeded; see `recordings/offline-replay.cast` and `09-export-asciicast.json`.

The two Vitest logs are the authoritative automated proofs that offline replay reconstruction is covered at both the unit level (`logs/10-vitest-offline-replay.log`) and the integration level (`logs/11-vitest-offline-snapshot.log`).
