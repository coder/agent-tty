# Week 4 failure-recovery proof bundle

- **Date:** 2026-03-22
- **Bundle:** `dogfood/20260322-week4-failure-recovery/`
- **Session ID:** `01KMBMBQR0QJ0P5QP9S4NYT8KY`
- **AGENT_TERMINAL_HOME:** `/tmp/agent-terminal-week4-failure-recovery.L38bis`
- **Environment:** Node `v24.14.0` on `Linux 6.8.0-94-generic x86_64 GNU/Linux`

## Scenario summary

This bundle proves crash/failure recovery using the `test/fixtures/apps/crash-demo/main.ts` fixture, which prints crash-demo output and exits with code `1` after roughly 800 ms. The captured JSON envelopes show that the session persisted in an `exited` state after the crash, offline replay remained available after the process had already failed, and `destroy --force --json` completed the session lifecycle.

## Reviewer guide

| File                            | Proof                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `01-create.json`                | Crash session creation succeeded.                                                        |
| `02-wait-exit.json`             | Captured the crash exit with `exitCode: 1`.                                              |
| `03-inspect-failed.json`        | Session persisted in `exited` state with `exitCode: 1`.                                  |
| `04-snapshot-post-crash.json`   | Offline replay text snapshot preserved the crash-demo terminal output after failure.     |
| `05-screenshot-post-crash.json` | Offline replay screenshot succeeded and recorded a PNG artifact for the crashed session. |
| `06-record-asciicast.json`      | Asciicast export preserved the crashed session history after failure.                    |
| `07-destroy.json`               | Destroy completed the lifecycle with `destroyed: true`.                                  |

## Verification claims

- The session persisted in `exited` state after the crash rather than disappearing; see `03-inspect-failed.json`.
- Offline replay remained available after the crash; `04-snapshot-post-crash.json` contains the crash-demo text transcript and `05-screenshot-post-crash.json` reports a PNG artifact with `pngSizeBytes: 9373`.
- Recording export remained available after the crash; `06-record-asciicast.json` reports an asciicast artifact path, `bytes: 357`, `durationMs: 817`, and SHA-256 `fa6fd80363fdf11ac13dd82672667f2b304ce125f92c8621e72903d82f70f413`.
- Destroy completed successfully; `07-destroy.json` reports `destroyed: true`.
- No deterministic capture of an intermediate `destroying` state is included here because that state is transient; this bundle documents the successful terminal state instead.

## Live capture

Dependency prep before the live run:

`npm ci --ignore-scripts`

Commands executed against the crash-demo fixture:

`AGENT_TERMINAL_HOME=/tmp/agent-terminal-week4-failure-recovery.L38bis node --import tsx ./src/cli/main.ts create --json -- node --import tsx test/fixtures/apps/crash-demo/main.ts`

`AGENT_TERMINAL_HOME=/tmp/agent-terminal-week4-failure-recovery.L38bis node --import tsx ./src/cli/main.ts wait 01KMBMBQR0QJ0P5QP9S4NYT8KY --exit --timeout 10000 --json`

`AGENT_TERMINAL_HOME=/tmp/agent-terminal-week4-failure-recovery.L38bis node --import tsx ./src/cli/main.ts inspect 01KMBMBQR0QJ0P5QP9S4NYT8KY --json`

`AGENT_TERMINAL_HOME=/tmp/agent-terminal-week4-failure-recovery.L38bis node --import tsx ./src/cli/main.ts snapshot 01KMBMBQR0QJ0P5QP9S4NYT8KY --format text --json`

`AGENT_TERMINAL_HOME=/tmp/agent-terminal-week4-failure-recovery.L38bis node --import tsx ./src/cli/main.ts screenshot 01KMBMBQR0QJ0P5QP9S4NYT8KY --json`

`AGENT_TERMINAL_HOME=/tmp/agent-terminal-week4-failure-recovery.L38bis node --import tsx ./src/cli/main.ts record export 01KMBMBQR0QJ0P5QP9S4NYT8KY --format asciicast --json`

`AGENT_TERMINAL_HOME=/tmp/agent-terminal-week4-failure-recovery.L38bis node --import tsx ./src/cli/main.ts destroy 01KMBMBQR0QJ0P5QP9S4NYT8KY --force --json`
