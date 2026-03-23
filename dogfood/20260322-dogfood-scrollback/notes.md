# Scenario F — scrollback and replay

## Outcome

- Scenario completed with artifacts captured, but multiple bugs were observed.
- Final successful session: `01KMBVE7WQCJRZMWD0T5VT53F7` (exit code 0).
- The initial rerun without a wait timeout got stuck on `wait --text "SCROLLBACK COMPLETE"` even though the session later exited and the final screenshot showed the completion line. See `preflight/commands-hung-after-create.log`.

## Review answers

- **Does the viewport snapshot show only the LAST lines (not LINE 001)?** No. Both structured and text viewport snapshots showed `SCROLLBACK DEMO START` through `LINE 023`, including `LINE 001`.
- **Does the scrollback snapshot include earlier lines (LINE 001, etc.)?** Not in a useful way. `snapshot --include-scrollback` returned the same visible lines as the default snapshot and did not expose additional scrollback content.
- **Is scrollback length consistent with 80 lines output?** No. The fixture emits 80 numbered lines plus the completion line, but the structured snapshot exposed only 24 visible lines and no `scrollbackLines` array.
- **Is the `.cast` export complete and ordered?** Yes. The exported asciicast contains `LINE 001`, `LINE 024`, `LINE 040`, `LINE 080`, and `SCROLLBACK COMPLETE` in order.
- **Does replay video show scrolling?** Not directly verified in this environment because no local video playback tooling was available. However, the exported `.webm` exists and the final screenshot shows the terminal at the end of the run (`LINE 059`–`LINE 080` plus `SCROLLBACK COMPLETE`), while the `.cast` contains the full ordered stream.

## Week 4 `--include-scrollback` finding

- **Does `--include-scrollback` actually populate `scrollbackLines`?** No. In `04-snapshot-scrollback.json`, the `result` object contains `visibleLines` only; `scrollbackLines` is absent/null in the derived review.
- **Viewport vs scrollback snapshot comparison:** `03-snapshot-viewport.json` and `04-snapshot-scrollback.json` are effectively identical for this run, so the flag did not surface extra history.

## Bugs / unexpected behavior

1. **Dependency preflight issue:** initial `create` failed before `npm ci` because the CLI could not resolve `commander`. See `preflight/01-create-missing-deps.txt`.
2. **`wait --text` did not match rendered completion text:** `02-wait-text.txt` shows `Wait timed out. (capturedAtSeq: 5)` even though the session finished normally and the screenshot shows `SCROLLBACK COMPLETE`.
3. **Snapshot viewport appears stale:** snapshot/text snapshot show the beginning of output (`LINE 001`–`LINE 023`) while the screenshot shows the final viewport (`LINE 059`–`LINE 080` plus `SCROLLBACK COMPLETE`).
4. **`--include-scrollback` produced no extra structured data:** no populated `scrollbackLines` field and no difference from the default structured snapshot.

## Artifacts

- `01-create.json`
- `02-wait-text.txt`
- `03-snapshot-viewport.json`
- `04-snapshot-scrollback.json`
- `05-snapshot-text.json`
- `06-screenshot.json`
- `06-screenshot.png`
- `07-record-export-asciicast.json`
- `07-session.cast`
- `08-record-export-webm.json`
- `08-session.webm`
- `09-wait-exit.txt`
- `10-inspect.json`
- `review.json`
- `command-status.json`
- `commands.log`
- `env.txt`
- `preflight/01-create-missing-deps.txt`
- `preflight/commands-missing-deps.log`
- `preflight/01-create-before-rerun.json`
- `preflight/commands-hung-after-create.log`
