# Scenario B — resize

- **Date:** 2026-03-22
- **Bundle:** `dogfood/20260322-dogfood-resize/`
- **CLI entrypoint:** `npx tsx src/cli/main.ts`
- **Fixture:** `npx tsx test/fixtures/apps/resize-demo/main.ts`
- **Session ID:** `01KMBTZ1159XHVV1FX7WJ4YC4X`
- **Isolated home:** `/tmp/tmp.WDlrbWMMxE`

## Outcome

Scenario B did **not** complete successfully. The session launched and accepted both resize commands, and replay exports succeeded, but both post-resize `screenshot` commands and the final `snapshot` command failed with `RPC_ERROR: replay input initial dimensions changed after the first replay`.

## Review

- **Did SIZE indicators update correctly after each resize?** Yes in the recording export — `recordings/resize-demo.cast` captures `SIZE: 120x40`, `SIZE: 140x50`, and `SIZE: 80x24`, matching the requested sizes.
- **Did the screen redraw cleanly?** Could not be fully verified. `03-screenshot-before-resize.json` produced a valid PNG, but both post-resize screenshot attempts failed before producing PNGs, so there is no rendered before/after comparison after the resize operations.

## Issues found

- **BUG:** `06-screenshot-after-resize-large.json`, `09-screenshot-after-resize-small.json`, and `10-snapshot-final.json` all fail with `RPC_ERROR` and message `replay input initial dimensions changed after the first replay` after the first resize.
- Because of that renderer/replay failure, Scenario B is missing the expected post-resize PNG screenshots and a successful final snapshot payload.
- `11-record-export-webm.json` and `12-record-export-cast.json` still succeeded, so replay evidence was preserved despite the snapshot/screenshot failures.

## Artifacts produced

- `01-create.json`
- `02-wait-size.json`
- `03-screenshot-before-resize.json` + `screenshots/01-before-resize.png`
- `04-resize-large.json`
- `05-wait-stable-large.json`
- `06-screenshot-after-resize-large.json` _(error JSON only; no PNG produced)_
- `07-resize-small.json`
- `08-wait-stable-small.json`
- `09-screenshot-after-resize-small.json` _(error JSON only; no PNG produced)_
- `10-snapshot-final.json` _(error JSON only)_
- `11-record-export-webm.json` + `videos/resize-demo.webm`
- `12-record-export-cast.json` + `recordings/resize-demo.cast`
- `13-destroy.json`
- `command-log.tsv`
- `manifest.json`

## Command log

| Step                               | Exit code | Command                                                                                                                                                                                                                  |
| ---------------------------------- | --------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `01-create`                        |         0 | `npx tsx src/cli/main.ts create --cols 120 --rows 40 --json -- npx tsx test/fixtures/apps/resize-demo/main.ts`                                                                                                           |
| `02-wait-size`                     |         0 | `npx tsx src/cli/main.ts wait 01KMBTZ1159XHVV1FX7WJ4YC4X --text SIZE: --json`                                                                                                                                            |
| `03-screenshot-before-resize`      |         0 | `npx tsx src/cli/main.ts screenshot 01KMBTZ1159XHVV1FX7WJ4YC4X --json`                                                                                                                                                   |
| `04-resize-large`                  |         0 | `npx tsx src/cli/main.ts resize 01KMBTZ1159XHVV1FX7WJ4YC4X --cols 140 --rows 50 --json`                                                                                                                                  |
| `05-wait-stable-large`             |         0 | `npx tsx src/cli/main.ts wait 01KMBTZ1159XHVV1FX7WJ4YC4X --screen-stable-ms 500 --json`                                                                                                                                  |
| `06-screenshot-after-resize-large` |         1 | `npx tsx src/cli/main.ts screenshot 01KMBTZ1159XHVV1FX7WJ4YC4X --json`                                                                                                                                                   |
| `07-resize-small`                  |         0 | `npx tsx src/cli/main.ts resize 01KMBTZ1159XHVV1FX7WJ4YC4X --cols 80 --rows 24 --json`                                                                                                                                   |
| `08-wait-stable-small`             |         0 | `npx tsx src/cli/main.ts wait 01KMBTZ1159XHVV1FX7WJ4YC4X --screen-stable-ms 500 --json`                                                                                                                                  |
| `09-screenshot-after-resize-small` |         1 | `npx tsx src/cli/main.ts screenshot 01KMBTZ1159XHVV1FX7WJ4YC4X --json`                                                                                                                                                   |
| `10-snapshot-final`                |         1 | `npx tsx src/cli/main.ts snapshot 01KMBTZ1159XHVV1FX7WJ4YC4X --json`                                                                                                                                                     |
| `11-record-export-webm`            |         0 | `npx tsx src/cli/main.ts record export 01KMBTZ1159XHVV1FX7WJ4YC4X --format webm --out /home/coder/.mux/src/agent-terminal/agent_exec_3a3efb7ac5/dogfood/20260322-dogfood-resize/videos/resize-demo.webm --json`          |
| `12-record-export-cast`            |         0 | `npx tsx src/cli/main.ts record export 01KMBTZ1159XHVV1FX7WJ4YC4X --format asciicast --out /home/coder/.mux/src/agent-terminal/agent_exec_3a3efb7ac5/dogfood/20260322-dogfood-resize/recordings/resize-demo.cast --json` |
| `13-destroy`                       |         0 | `npx tsx src/cli/main.ts destroy 01KMBTZ1159XHVV1FX7WJ4YC4X --json`                                                                                                                                                      |
