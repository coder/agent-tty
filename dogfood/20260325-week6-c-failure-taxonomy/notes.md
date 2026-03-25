# 2026-03-25 dogfood — Week 6 bundle C failure taxonomy proof

## Bundle metadata

- **Bundle path:** `dogfood/20260325-week6-c-failure-taxonomy/`
- **Non-zero exit session:** `01KMJ2RSD2NWQKAN6NH3TGMSRC`
- **Clean exit session:** `01KMJ2RXN9F3K4H9366FNZZJ79`
- **Host-death session:** `01KMJ2S238K002KNYQWZGCCT3N`
- **Killed host PID:** `831241`
- **Isolated AGENT_TERMINAL_HOME:** `/tmp/agent-terminal-week6.N8X5Dz`

## Scenario summary

This bundle exercises the new failure taxonomy surface across three cases:

1. a shell command that exits with code 42
2. a shell command that exits cleanly with code 0
3. a live host process that is force-killed so reconciliation persists `failureOrigin` and derives `terminationCategory: "host-death"`

## Review answers

- **Did a non-zero exit map to the expected termination category?** Yes. `logs/03-inspect-exit-42.json` shows `exitCode: 42` with `terminationCategory: "nonzero-exit"`.
- **Did a clean exit map to the expected termination category?** Yes. `logs/06-inspect-exit-0.json` shows `exitCode: 0` with `terminationCategory: "clean-exit"`.
- **Was the host-death scenario captured from a live session?** Yes. `logs/09-inspect-live.json` captured the running session and the live `hostPid` before the forced kill recorded in `logs/10-kill-host.json`.
- **Did reconciliation persist `failureOrigin` for host death?** Yes. `logs/11-inspect-host-death.json` shows `status: "failed"`, `failureOrigin: "host-death"`, and `failureReason: "host process died unexpectedly (pid: 831241)"`.
- **Was `terminationCategory` derived correctly after the host died?** Yes. The same inspect output reports `terminationCategory: "host-death"` and `usedOfflineReplay: true`, proving the CLI recovered through offline reconciliation.
- **Is the reconciled session record included?** Yes. `logs/12-host-death-session.json` is the persisted failed session record copied directly from the isolated session directory.

## Issues / limitations

- None during capture. The host-death branch intentionally force-kills the host process with `kill -9` to exercise reconciliation.
