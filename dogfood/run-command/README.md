# Run command dogfood bundle

This bundle captures a 2026-03-26 end-to-end dogfood pass for the first-class `run` command under an isolated `AGENT_TERMINAL_HOME` recorded in `isolated-home.txt` (removed after capture).

## What was exercised

1. **Interactive bash session**
   - `create-bash.json` shows the interactive proof session created at 2026-03-26T20:54:41.606Z.
   - `waited-success.json` shows `run <bash-session> 'echo hello-dogfood' --timeout 15000 --json` returned `accepted: true`, `completed: true`, and `timedOut: false` (seq 3, 668 ms).
   - `no-wait.json` shows `run <bash-session> 'echo async-dogfood' --no-wait --json` returned `accepted: true` with seq 5 and no completion fields.
2. **Timeout contract**
   - `timeout.json` shows `accepted: true`, `completed: false`, and `timedOut: true` (seq 0, 2002 ms).
   - The timeout proof used a dedicated no-echo session created in `create-timeout.json` with `/bin/sh -c 'stty -echo; exec sleep 60'`, matching the repo's integration coverage for the timeout path.
3. **Reviewable renderer artifacts**
   - `snapshot.json` captures the terminal state after the interactive run scenarios.
   - `screenshot.png` is a copied renderer screenshot from `screenshot-result.json`.
   - `run-command.cast` is the exported asciicast from `record-export-asciicast.json`.
   - `run-command.webm` is the exported WebM recording from `record-export-webm.json`.
4. **Event-log evidence**
   - `input-run-events.jsonl` contains 3 raw `input_run` entries copied from the interactive and timeout-session event logs.

## Important review notes

- The interactive bash session inherited this workspace's normal shell startup files, so `snapshot.json` and `screenshot.png` include the startup noise already visible in the session (for example the local `starship`/`brew` lookup failures). That noise does not affect the JSON run envelopes.
- `commands.sh`, `bash-session-id.txt`, and `timeout-session-id.txt` record the exact CLI flow used to generate the bundle.
- The requested timeout proof is represented by a separate session because the repository's own integration coverage uses a no-echo sleeper to keep the injected wait marker out of rendered output.

## Suggested review order

1. Read `waited-success.json`, `timeout.json`, and `no-wait.json`.
2. Check `input-run-events.jsonl` for the raw `input_run` event evidence.
3. Open `snapshot.json` and `screenshot.png` for terminal-state proof.
4. Play `run-command.cast` and `run-command.webm` if you want the reviewable recording exports.
