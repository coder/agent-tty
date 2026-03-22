# Week 4 CLI parity proof bundle index

This directory contains the 2026-03-22 CLI parity proof bundle for `dogfood/20260322-week4-cli-parity/`.

## File inventory

- `00-list-empty.json`
- `01-create.json`
- `02-inspect.json`
- `03-list.json`
- `04-wait-idle.json`
- `05-type-file.json`
- `06-send-enter.json`
- `07-wait-echo.json`
- `08-snapshot.json`
- `09-wait-cursor.json`
- `10-destroy.json`
- `index.md`
- `notes.md`

## Quick review order

1. Read `notes.md` for the scenario summary and limitations.
2. Confirm `00-list-empty.json` shows an empty isolated home.
3. Confirm `01-create.json`, `02-inspect.json`, and `03-list.json` cover create-time options plus isolated-home session discovery.
4. Confirm `05-type-file.json`, `07-wait-echo.json`, `08-snapshot.json`, and `09-wait-cursor.json` cover file input plus cursor-aware waiting.
5. Confirm `10-destroy.json` shows cleanup completed.
