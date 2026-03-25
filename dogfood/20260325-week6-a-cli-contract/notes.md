# 2026-03-25 dogfood — Week 6 bundle A CLI contract proof

## Bundle metadata

- **Bundle path:** `dogfood/20260325-week6-a-cli-contract/`
- **Session ID:** `01KMJ2R5VRY4GS10VZ3VNG52Z1`
- **Isolated AGENT_TERMINAL_HOME:** `/tmp/agent-terminal-week6.N8X5Dz`
- **CLI entrypoint:** `npx tsx src/cli/main.ts`

## Scenario summary

This bundle proves the Week 6 CLI contract additions on the stable JSON surface:

- `version --json` reports `rendererBackends: ["ghostty-web"]`
- `inspect --json` includes `artifacts`, `terminationCategory`, `lastEventSeq`, and `usedOfflineReplay`
- the same session shows the enriched inspect payload both while running and after a clean exit

## Review answers

- **Did `version --json` advertise the renderer backend list?** Yes. `logs/01-version.json` reports `rendererBackends: ["ghostty-web"]` alongside CLI, protocol, and runtime facts.
- **Did the running inspect include the new Week 6 fields?** Yes. `logs/04-inspect-running.json` shows `lastEventSeq: 0`, `terminationCategory: "running"`, `artifacts.health: "no-artifacts"`, and `usedOfflineReplay: false` while the shell command was still sleeping.
- **Did the exited inspect keep the same enriched shape?** Yes. `logs/06-inspect-exited.json` shows `lastEventSeq: 1`, `terminationCategory: "clean-exit"`, the same `artifacts` object, and `usedOfflineReplay: false` after exit.
- **Did the proof exercise real output and exit waits?** Yes. `logs/03-wait-text.json` matched the rendered text `hello`, and `logs/05-wait-exit.json` observed the clean exit.
- **What supporting raw session files are included?** `logs/07-session.json` and `logs/08-events.jsonl` were copied from the isolated session directory so reviewers can correlate the inspect output with the persisted session record and append-only event log.

## Issues / limitations

- None during capture. This scenario intentionally produced no artifacts, so both inspect calls report `artifacts.health: "no-artifacts"`.
