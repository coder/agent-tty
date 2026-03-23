# Scenario F-redux — scrollback bugfix verification

- **Date:** 2026-03-23
- **Bundle:** `dogfood/20260323-bugfix-scrollback/`
- **CLI entrypoint:** `npx tsx src/cli/main.ts`
- **Fixture:** `npx tsx test/fixtures/apps/scrollback-demo/main.ts`
- **Session ID:** `01KMCYYK6GSKR6ZF3NAW7GFE5N`
- **Isolated home:** recorded in `agent-terminal-home.txt`

## Outcome

Scenario F-redux completed successfully. The wait matched `SCROLLBACK COMPLETE`, the viewport snapshot showed the final viewport instead of stale early lines, and `snapshot --include-scrollback` returned a populated `scrollbackLines` array.

## Command log

| User step | Stored file | Exit code | Command |
| --- | --- | ---: | --- |
| 2 | `01-create.json` | 0 | `npx tsx src/cli/main.ts create --cols 80 --rows 24 --json -- npx tsx test/fixtures/apps/scrollback-demo/main.ts` |
| 3 | `02-wait-text.json` | 0 | `npx tsx src/cli/main.ts wait 01KMCYYK6GSKR6ZF3NAW7GFE5N --text "SCROLLBACK COMPLETE" --timeout 10000 --json` |
| 4 | `03-snapshot-viewport.json` | 0 | `npx tsx src/cli/main.ts snapshot 01KMCYYK6GSKR6ZF3NAW7GFE5N --json` |
| 5 | `04-snapshot-scrollback.json` | 0 | `npx tsx src/cli/main.ts snapshot 01KMCYYK6GSKR6ZF3NAW7GFE5N --include-scrollback --json` |
| 6 | `05-screenshot.json` | 0 | `npx tsx src/cli/main.ts screenshot 01KMCYYK6GSKR6ZF3NAW7GFE5N --json` |
| 7 | `06-wait-exit.txt` | 0 | `npx tsx src/cli/main.ts wait 01KMCYYK6GSKR6ZF3NAW7GFE5N --exit` |
| 8 | `07-destroy.json` | 0 | `npx tsx src/cli/main.ts destroy 01KMCYYK6GSKR6ZF3NAW7GFE5N --json` |

## Previously failing checks

- **Step 4 viewport snapshot should not contain `LINE 001`:** now **SUCCEEDS**. `03-snapshot-viewport.json` shows the viewport beginning at `LINE 059` and includes late lines through `LINE 080` plus `SCROLLBACK COMPLETE`; `LINE 001` is absent.
- **Step 5 scrollback snapshot should populate `scrollbackLines`:** now **SUCCEEDS**. `04-snapshot-scrollback.json` includes a non-empty `scrollbackLines` array with 59 entries.
- **Step 6 screenshot:** succeeds with a real PNG saved as `05-screenshot.png`.

## Evidence the bug is fixed

- `02-wait-text.json` reports `matched: true`, `timedOut: false`, and `matchedText: "SCROLLBACK COMPLETE"`.
- `03-snapshot-viewport.json` visible lines start at `LINE 059` and continue through `LINE 080`, followed by `SCROLLBACK COMPLETE`; it does **not** contain `LINE 001`.
- `04-snapshot-scrollback.json` includes `scrollbackLines`, and the first entries are:
  - `SCROLLBACK DEMO START`
  - `LINE 001 | abcdefghijklmnopqrstuvwxyz`
  - `LINE 002 | abcdefghijklmnopqrstuvwxyz`
- `summary.json` records `viewportContainsLine001: false`, `viewportLateLines` containing `LINE 059` through `LINE 069`, and `scrollbackLinesCount: 59`.
- `05-screenshot.json` is `ok: true` and produced `05-screenshot.png`, which visually shows the final viewport with `LINE 059` through `LINE 080` and `SCROLLBACK COMPLETE`.

## Artifacts

- `01-create.json`
- `02-wait-text.json`
- `03-snapshot-viewport.json`
- `04-snapshot-scrollback.json`
- `05-screenshot.json`
- `05-screenshot.png`
- `06-wait-exit.txt`
- `07-destroy.json`
- `summary.json`
- `command-log.tsv`
