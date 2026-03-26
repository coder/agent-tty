# 2026-03-25 dogfood — Week 8 capability inventory proof

## Bundle metadata

- **Bundle path:** `dogfood/20260325-week8-capability-inventory/`
- **Isolated AGENT_TERMINAL_HOME:** `/tmp/tmp.XlYvQNqMgF`
- **CLI entrypoint:** `npx tsx src/cli/main.ts`
- **Captured commands:** `version --json`, `doctor --json`

## Scenario summary

This bundle proves the Week 8 capability-inventory surface by capturing the ratified JSON envelopes from `version --json` and `doctor --json` in a fresh isolated temp home.

- `01-version.json` and `02-doctor.json` are reviewer-facing top-level JSON copies so the contract-reporting validator and generated review page can parse the captured outputs directly.
- `logs/01-version.json` captures the direct `version --json` command output, and `logs/02-doctor.json` captures the direct `doctor --json` command output plus matching `logs/*.stderr.txt` sidecars.
- `command-status.tsv` records both JSON capture steps with their exact commands and exit codes.
- `agent-terminal-home.txt` records the isolated temp home path used during capture.

## Capability inventory summary

- `version --json` reports five capability entries: `snapshot`, `wait`, `screenshot`, `record-export-asciicast`, and `record-export-webm`. Each entry includes `name` and `status`, and this run reported all five as `available`.
- `doctor --json` reports the same five capability names, but each entry also includes `reason` and `detail` so reviewers can see whether availability comes from built-in behavior or from renderer/browser smoke checks.
- In this capture, `snapshot`, `wait`, and `record-export-asciicast` are available as built-in capabilities, while `screenshot` and `record-export-webm` are available because the Playwright / Chromium / Ghostty Web checks passed.

## Review answers

- **Did the bundle use an isolated temp home?** Yes. `agent-terminal-home.txt` records `/tmp/tmp.XlYvQNqMgF`, and `logs/02-doctor.json` also references that temp home in its `home-writable`, `socket-viable`, `artifact-atomicity`, and `event-log-writable` checks.
- **Did `version --json` expose the Week 8 capability inventory surface?** Yes. `01-version.json` and `logs/01-version.json` both report `result.capabilities` with five structured entries covering snapshot, wait, screenshot, asciicast export, and WebM export.
- **Did `doctor --json` expose the richer capability diagnostics?** Yes. `02-doctor.json` and `logs/02-doctor.json` both report the same capability names plus `reason` and `detail`, tying screenshot and WebM availability to passing renderer/browser checks.
- **Did the underlying doctor checks pass?** Yes. `logs/02-doctor.json` reports `result.ok: true`, all environment checks as `pass`, and all renderer checks as `pass`.
- **Where is the step ledger for the capture run?** `command-status.tsv` records both commands, their exit codes, and `pass` status, and each step has a matching `logs/*.stderr.txt` sidecar.
- **Is there reviewer-facing visual proof of the generated review page?** Yes. `screenshots/01-review-page.png` was captured from the generated `index.html` review page after running `npm run review-bundle -- dogfood/20260325-week8-capability-inventory`.

## Issues / limitations

- This bundle intentionally exercises only the Week 8 capability-inventory reporting surface. It does not create a live session or produce snapshot / recording / video artifacts of its own.
- `01-version.json` and `02-doctor.json` are bundle-root copies of the direct command captures from `logs/`; they exist so the generated review page and `contract-reporting` validator can discover machine-readable JSON outputs.
- The screenshot artifact is for the generated bundle review page, not for a terminal session. The `recordings/`, `videos/`, and `snapshots/` directories are present to match the reviewer bundle structure used in Week 7.
