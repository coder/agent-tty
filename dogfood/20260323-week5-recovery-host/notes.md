# 2026-03-23 week 5 — stale host recovery proof

## Bundle metadata

- **Created at:** 2026-03-23T16:09:17Z
- **Bundle path:**   `dogfood/20260323-week5-recovery-host/`
- **Session ID:** `01KMDQ9S6XFPBFZSKPGJCGN2KX`
- **Killed host PID:** `1047819`
- **Isolated AGENT_TERMINAL_HOME:** `/tmp/tmp.ANY5QrINkU`

## Flow summary

This bundle reproduces the stale-host recovery lifecycle from the integration test: create a live session, inspect it while the host is running, force the host to die with `kill -9`, inspect again to trigger reconciliation into a failed terminal session, garbage collect the reconciled session, and confirm the session is gone.

The current CLI `create --json` envelope records the new `sessionId` in `01-create.json`; the live `hostPid` is captured in `02-inspect-live.json`, which is why the forced-kill step is sourced from the live inspect output instead of the create envelope.

## Proof map

- `01-create.json` proves the CLI created session `01KMDQ9S6XFPBFZSKPGJCGN2KX` for the stale-host scenario.
- `02-inspect-live.json` proves the session was live before the crash with `status: "running"` and a numeric `hostPid`.
- `03-list-default.json` shows the default list included the running session before the host died.
- `04-kill-host.json` records the exact forced kill against host PID `1047819`.
- `05-inspect-post-crash.json` proves reconciliation cleared `hostPid` and `childPid`, set `status: "failed"`, and preserved a non-empty `failureReason` describing the unexpected host death.
- `06-list-all.json` shows the reconciled stale session still exists as a failed session before garbage collection.
- `07-gc.json` proves `gc --json` removed the reconciled stale session.
- `08-list-final.json` proves the stale session no longer appears after garbage collection.
- `logs/09-vitest-stale-host.log` is the authoritative targeted test proof for `test/integration/lifecycle.test.ts` with the `stale host recovery` filter.

## Review guidance

Start with `01-create.json`, `02-inspect-live.json`, `04-kill-host.json`, `05-inspect-post-crash.json`, `07-gc.json`, and `08-list-final.json` to follow the state transition end to end. Then confirm the automated regression coverage in `logs/09-vitest-stale-host.log`.
