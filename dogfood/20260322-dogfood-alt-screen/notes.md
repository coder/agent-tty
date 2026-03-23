# 2026-03-22 dogfood — Scenario D alternate screen behavior

## Bundle metadata

- **Date:** 2026-03-22
- **Bundle path:** `dogfood/20260322-dogfood-alt-screen/`
- **AGENT_TERMINAL_HOME:** `/tmp/tmp.5qVKPi5rha`
- **Session ID:** `01KMBTV99F0QQ1VPW74QDXHB72`
- **Fixture:** `npx tsx test/fixtures/apps/alt-screen-demo/main.ts`

## Scenario summary

This run exercised the bundled `alt-screen-demo` fixture through main-screen capture, alternate-screen entry, alternate-screen capture, alternate-screen exit, replay exports, natural exit, and final inspect.

## Review answers

- **Did the primary screen return intact?** Yes. `11-snapshot-primary-after.json` still contains the original main-screen lines plus the expected post-return lines.
- **Was cursor placement restored correctly?** Yes, as far as the captured state shows. The primary-before snapshot cursor was at row 2/col 0, the alternate snapshot cursor was at row 2/col 0 inside alt-screen, and the primary-after snapshot cursor ended at row 5/col 0 after the fixture printed two additional lines.
- **Did stale alternate-screen content leak into the primary screen?** No. `ALT SCREEN ACTIVE` is absent from `11-snapshot-primary-after.json` and the `primary-after.png` screenshot.
- **Does the snapshot of the alt screen show `ALT SCREEN ACTIVE`?** Yes. `07-snapshot-alt-screen.json` row 0 contains `ALT SCREEN ACTIVE` and `isAltScreen: true`.
- **Does the snapshot after returning show `BACK ON MAIN SCREEN`?** Yes. `11-snapshot-primary-after.json` row 3 contains `BACK ON MAIN SCREEN`.

## Bugs / unexpected behavior

1. **`wait --text "BACK ON MAIN SCREEN"` raced the session teardown.** Step 10 exited with code `6` and `HOST_UNREACHABLE` because the host socket disappeared before the wait RPC could complete, even though the subsequent snapshot and screenshot prove the expected text rendered before exit.

## Command results

See `command-status.tsv` for the exact commands and exit codes. Every scenario-D command exited `0` except step 10 (`wait --text "BACK ON MAIN SCREEN"`), which exited `6` with `HOST_UNREACHABLE`.
