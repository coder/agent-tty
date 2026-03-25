# 2026-03-25 dogfood — Week 8 inspect runtime proof

## Bundle metadata

- **Bundle path:** `dogfood/20260325-week8-inspect-runtime/`
- **Session ID:** `01KMKNZXNWZKGCXTCKGTVHC9T7`
- **Isolated AGENT_TERMINAL_HOME:** `/tmp/tmp.s3O1Nrg0On`
- **CLI entrypoint:** `npx tsx src/cli/main.ts`
- **Fixture app:** `node --import tsx test/fixtures/apps/hello-prompt/main.ts`

## Scenario summary

This bundle proves the Week 8 `inspect --json` renderer runtime summary against a real isolated PTY-backed `hello-prompt` session. The same session was inspected twice: once while it was still running and once after `destroy --json` had transitioned it into retained offline state.

## `rendererRuntime` proof

| Capture              | Evidence                       | `session.status` | `rendererRuntime.mode` | `rendererRuntime.status` | `rendererRuntime.reason` | `usedOfflineReplay` |
| -------------------- | ------------------------------ | ---------------- | ---------------------- | ------------------------ | ------------------------ | ------------------- |
| Live inspect         | `logs/02-inspect-live.json`    | `running`        | `live-host`            | `healthy`                | _omitted_                | `false`             |
| Post-destroy inspect | `logs/04-inspect-offline.json` | `destroyed`      | `offline-replay`       | `fallback`               | `session-not-running`    | `false`             |

Key observations from the captured JSON envelopes:

- `rendererRuntime.backend` stayed `ghostty-web` in both states; only the runtime mode changed.
- While the host was still alive, `inspect --json` reported `rendererRuntime.mode = "live-host"` and `status = "healthy"`.
- After `destroy --json`, the retained session metadata still inspected successfully, but `rendererRuntime.mode` switched to `"offline-replay"` with fallback reason `"session-not-running"`.
- `usedOfflineReplay` stayed `false` in both captures. This is an important nuance: an offline renderer mode does **not** automatically mean the command had to fall back from a failed live RPC call.

## Fallback reason interpretation

The Week 8 surface distinguishes two fallback reasons:

- **`session-not-running`** — captured directly in this bundle via `logs/04-inspect-offline.json` after the session was destroyed.
- **`host-unreachable`** — the alternate path used when a session still appears live but its host cannot answer RPC. The real PTY run here stayed healthy, so this bundle does not force that failure mode. The repo's inspect unit test (`test/unit/commands/inspect.test.ts`) explicitly covers it and asserts `rendererRuntime.mode = "offline-replay"`, `rendererRuntime.reason = "host-unreachable"`, and `usedOfflineReplay = true` for that case.

That distinction matches the implementation in `src/cli/commands/inspect.ts`: `usedOfflineReplay` only flips to `true` when the command expected to use the live host but had to reconcile from retained state after a host-unreachable failure.

## Review answers

- **Did live inspect report the new live-host runtime summary?** Yes. `logs/02-inspect-live.json` shows `rendererRuntime.backend = "ghostty-web"`, `mode = "live-host"`, `status = "healthy"`, and `usedOfflineReplay = false` while the session status is `running`.
- **Did offline inspect report the new offline-replay runtime summary?** Yes. `logs/04-inspect-offline.json` shows `rendererRuntime.mode = "offline-replay"`, `status = "fallback"`, `reason = "session-not-running"`, and `usedOfflineReplay = false` after the same session was destroyed.
- **Did destroy preserve enough retained state for post-destroy inspect?** Yes. `logs/03-destroy.json` reports `destroyed: true`, and the subsequent `logs/04-inspect-offline.json` still reports the original command, retained size metadata, event count, and termination category.
- **Did the JSON envelopes show any artifact-health side effects?** Yes. Both inspect captures report `artifacts.health = "no-artifacts"`, which is expected because this proof only exercised `create`, `inspect`, and `destroy` without generating snapshots or screenshots.
- **Where is the command ledger?** `command-status.tsv` records the exact create / live inspect / destroy / offline inspect sequence, commands, exit codes, and pass/fail status. Each step also has a matching `logs/*.stderr.txt` sidecar.

## Browser verification

The generated review page was opened from the local bundle `index.html` and captured with Playwright. Reviewer-facing proof lives at `screenshots/01-review-page.png`.

## Issues / limitations

- This bundle directly proves the `session-not-running` fallback path with a real PTY session. It does not intentionally simulate a broken live host, so `host-unreachable` remains code-and-unit-test-backed rather than PTY-captured evidence here.
- The post-destroy inspect result reports `exitSignal = "1"` alongside `terminationCategory = "destroyed"`. That is consistent with the teardown path used by `destroy --json` and does not indicate a bundle failure.
- No renderer artifacts were generated in this proof bundle by design, so `artifacts.total = 0` and `health = "no-artifacts"` are expected in both inspect captures.
