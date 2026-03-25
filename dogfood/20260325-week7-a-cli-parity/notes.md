# 2026-03-25 dogfood — Week 7 bundle A CLI parity proof

## Bundle metadata

- **Bundle path:** `dogfood/20260325-week7-a-cli-parity/`
- **Session ID:** `01KMK8J0XB9THNASXVNPF697ZD`
- **Isolated AGENT_TERMINAL_HOME:** `/tmp/tmp.avp2NwNn0m`
- **CLI entrypoint:** `npx tsx src/cli/main.ts`
- **Fixture app:** `node --import tsx test/fixtures/apps/hello-prompt/main.ts`

## Scenario summary

This bundle proves the ratified Week 7 CLI parity surface against a real isolated interactive session and captures a JSON envelope for every exercised command.

- `doctor --json` and `version --json` verified the runtime, PTY, renderer, and CLI metadata before exercising session control.
- `create --json` launched the `hello-prompt` fixture as a live session, then `send-keys`, `type`, and `paste` drove the prompt without leaving the isolated temp home behind.
- `snapshot --json --format text` and `screenshot --json` captured the live terminal state; their bundle-local reviewer copies are `snapshots/snapshot-01.txt` and `screenshots/screenshot-01.png`.
- `record export` produced both an asciicast and a WebM, and `destroy --json` followed by `list --json` proved cleanup.

## Review answers

- **Did `doctor --json` verify the environment and renderer path?** Yes. `logs/01-doctor.json` reports successful Node, PTY, Playwright, Ghostty Web, and screenshot viability checks.
- **Did `version --json` report the ratified CLI/runtime facts?** Yes. `logs/02-version.json` reports `cliVersion`, `protocolVersion`, `rendererBackends`, and runtime platform details.
- **Did `create --json` start a real isolated prompt session?** Yes. `logs/03-create.json` created session `01KMK8J0XB9THNASXVNPF697ZD`, and `logs/09-list.json` shows the same session still running with the fixture command.
- **Did `send-keys`, `type`, and `paste` all succeed on the running session?** Yes. `logs/04-send-keys.json`, `logs/05-type.json`, and `logs/06-paste.json` all returned `ok: true`, and the resulting prompt buffer is visible in `snapshots/snapshot-01.txt`.
- **Did snapshot capture the live terminal text?** Yes. `logs/07-snapshot.json` captured the text snapshot at `capturedAtSeq: 7`, and `snapshots/snapshot-01.txt` preserves the reviewer-facing copy.
- **Did screenshot capture the rendered terminal state?** Yes. `logs/08-screenshot.json` reports a ghostty-web screenshot with SHA-256 metadata, and `screenshots/screenshot-01.png` is the copied reviewer artifact.
- **Did list and inspect expose the live session state before teardown?** Yes. `logs/09-list.json` shows the running session, and `logs/10-inspect.json` shows `status: "running"`, `lastEventSeq: 7`, `artifacts.byKind.snapshot: 1`, `artifacts.byKind.screenshot: 1`, and `usedOfflineReplay: false`.
- **Did record export produce both ratified formats?** Yes. `logs/11-record-export-cast.json` + `recordings/recording-01.cast` prove asciicast export, and `logs/12-record-export-webm.json` + `videos/video-01.webm` prove WebM export.
- **Did destroy remove the session and leave the home empty?** Yes. `logs/13-destroy.json` reports `destroyed: true`, and `logs/14-list-after-destroy.json` reports `sessions: []`.
- **Where are the stderr sidecars and command ledger?** Each numbered step has a matching `logs/*.stderr.txt` file, and `command-status.tsv` records every command, exit code, and pass/fail status.

## Issues / limitations

- The task brief sketched `--out` flags for `snapshot` and `screenshot`, but the current ratified CLI persists those artifacts inside the isolated session directory instead. This proof captured the JSON envelopes from `snapshot --json --format text` and `screenshot --json`, then copied the resulting reviewer artifacts into `snapshots/` and `screenshots/`.
- The live prompt buffer in `snapshots/snapshot-01.txt` shows bracketed-paste control sequences around the pasted text. That is expected here because the proof captured the session before pressing Enter after `paste`; the `hello-prompt` fixture only normalizes pasted content once it receives a completed input line.
- `logs/08-screenshot.json` points at a PNG path inside `/tmp/tmp.avp2NwNn0m`, which was cleaned up at the end of the run. The durable reviewer copy is `screenshots/screenshot-01.png`.

## Browser Verification (Week 7 remediation)

Review page verified via `agent-browser` — see `screenshots/02-review-page-verified.png`.

## CLI Dogfooding Visual Evidence (Week 7 remediation)

A fresh isolated CLI session was dogfooded on 2026-03-25 and captured as visual proof. See `screenshots/03-cli-session-screenshot-artifact.png` for the CLI-produced terminal screenshot artifact, `screenshots/04-cli-json-evidence.png` for the end-to-end JSON command evidence, and `screenshots/05-cli-result-shapes-evidence.png` for the focused `send-keys` / `destroy` result-shape proof.
