# Scenario B-redux — resize bugfix verification

- **Date:** 2026-03-23
- **Bundle:** `dogfood/20260323-bugfix-resize/`
- **CLI entrypoint:** `npx tsx src/cli/main.ts`
- **Fixture:** `npx tsx test/fixtures/apps/resize-demo/main.ts`
- **Session ID:** `01KMCYX32BMKX4F48WRMRSDC12`
- **Isolated home:** recorded in `agent-terminal-home.txt`

## Outcome

Scenario B-redux completed successfully. The previously failing post-resize `screenshot` and `snapshot` commands all returned exit code 0 and produced real artifacts.

## Command log

| User step | Stored file                             | Exit code | Command                                                                                                        |
| --------- | --------------------------------------- | --------: | -------------------------------------------------------------------------------------------------------------- |
| 2         | `01-create.json`                        |         0 | `npx tsx src/cli/main.ts create --cols 120 --rows 40 --json -- npx tsx test/fixtures/apps/resize-demo/main.ts` |
| 3         | `02-wait-size.json`                     |         0 | `npx tsx src/cli/main.ts wait 01KMCYX32BMKX4F48WRMRSDC12 --text "SIZE:" --json`                                |
| 4         | `03-screenshot-before-resize.json`      |         0 | `npx tsx src/cli/main.ts screenshot 01KMCYX32BMKX4F48WRMRSDC12 --json`                                         |
| 5         | `04-resize-large.json`                  |         0 | `npx tsx src/cli/main.ts resize 01KMCYX32BMKX4F48WRMRSDC12 --cols 140 --rows 50 --json`                        |
| 6         | `05-wait-stable-large.json`             |         0 | `npx tsx src/cli/main.ts wait 01KMCYX32BMKX4F48WRMRSDC12 --screen-stable-ms 500 --json`                        |
| 7         | `06-screenshot-after-resize-large.json` |         0 | `npx tsx src/cli/main.ts screenshot 01KMCYX32BMKX4F48WRMRSDC12 --json`                                         |
| 8         | `07-snapshot-after-resize-large.json`   |         0 | `npx tsx src/cli/main.ts snapshot 01KMCYX32BMKX4F48WRMRSDC12 --json`                                           |
| 9         | `08-resize-small.json`                  |         0 | `npx tsx src/cli/main.ts resize 01KMCYX32BMKX4F48WRMRSDC12 --cols 80 --rows 24 --json`                         |
| 10        | `09-wait-stable-small.json`             |         0 | `npx tsx src/cli/main.ts wait 01KMCYX32BMKX4F48WRMRSDC12 --screen-stable-ms 500 --json`                        |
| 11        | `10-screenshot-after-resize-small.json` |         0 | `npx tsx src/cli/main.ts screenshot 01KMCYX32BMKX4F48WRMRSDC12 --json`                                         |
| 12        | `11-snapshot-after-resize-small.json`   |         0 | `npx tsx src/cli/main.ts snapshot 01KMCYX32BMKX4F48WRMRSDC12 --json`                                           |
| 13        | `12-destroy.json`                       |         0 | `npx tsx src/cli/main.ts destroy 01KMCYX32BMKX4F48WRMRSDC12 --json`                                            |

## Previously failing steps

- **Step 7 screenshot after resize to 140x50:** now **SUCCEEDS**. `06-screenshot-after-resize-large.json` is `ok: true` and produced `screenshots/06-after-resize-large.png`.
- **Step 8 snapshot after resize to 140x50:** now **SUCCEEDS**. `07-snapshot-after-resize-large.json` is `ok: true` with `cols: 140`, `rows: 50`, and visible lines including `SIZE: 140x50`.
- **Step 11 screenshot after resize back to 80x24:** now **SUCCEEDS**. `10-screenshot-after-resize-small.json` is `ok: true` and produced `screenshots/10-after-resize-small.png`.
- **Step 12 snapshot after resize back to 80x24:** now **SUCCEEDS**. `11-snapshot-after-resize-small.json` is `ok: true` with `cols: 80`, `rows: 24`, and visible lines including `SIZE: 80x24`.

## Evidence the bug is fixed

- The old failure message `replay input initial dimensions changed after the first replay` did **not** occur in any step in this rerun.
- The large post-resize screenshot captured at sequence 4 reports the resized dimensions `140x50` and saved a real PNG at `screenshots/06-after-resize-large.png`.
- The large post-resize snapshot reports `cols: 140`, `rows: 50` and visible lines:
  - `SIZE: 120x40`
  - `SIZE: 140x50`
- The small post-resize screenshot captured at sequence 6 reports the resized dimensions `80x24` and saved a real PNG at `screenshots/10-after-resize-small.png`.
- The small post-resize snapshot reports `cols: 80`, `rows: 24` and visible lines:
  - `SIZE: 120x40`
  - `SIZE: 140x50`
  - `SIZE: 80x24`

## Artifacts

- `01-create.json`
- `02-wait-size.json`
- `03-screenshot-before-resize.json`
- `04-resize-large.json`
- `05-wait-stable-large.json`
- `06-screenshot-after-resize-large.json`
- `07-snapshot-after-resize-large.json`
- `08-resize-small.json`
- `09-wait-stable-small.json`
- `10-screenshot-after-resize-small.json`
- `11-snapshot-after-resize-small.json`
- `12-destroy.json`
- `screenshots/03-before-resize.png`
- `screenshots/06-after-resize-large.png`
- `screenshots/10-after-resize-small.png`
- `summary.json`
- `command-log.tsv`
