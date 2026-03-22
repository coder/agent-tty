# 2026-03-22 dogfood — Scenario C color fidelity

## Bundle metadata

- **Date:** 2026-03-22
- **Bundle path:** `dogfood/20260322-dogfood-color/`
- **AGENT_TERMINAL_HOME:** `/tmp/tmp.5qVKPi5rha`
- **Session ID:** `01KMBTSNSRFHX2A7ZYDYVR16D9`
- **Fixture:** `npx tsx test/fixtures/apps/color-grid/main.ts`

## Scenario summary

This run exercised the bundled `color-grid` fixture through session creation, sentinel wait, dark/light screenshots, structured/text snapshots, asciicast export, natural exit, and final inspect.

## Review answers

- **Are the normal and bright colors distinct in the screenshots?** Yes. The dark and light renders both show visible differences between the basic row (`BG-40`..`BG-47`) and bright row (`BG-100`..`BG-107`).
- **Are foreground labels readable against their backgrounds?** Mostly yes. Labels remain readable in both render profiles, including the 256-color and truecolor swatches.
- **Are any cells shifted or clipped?** The longest swatch rows wrap at the default 80-column width. `BG-47`, `BG-107`, and the 256-color row continue onto the next terminal line, so the grid is not preserved as a single-row comparison layout.

## Bugs / unexpected behavior

1. **Structured snapshot lacks per-cell style payloads.** `05-snapshot-structured.json` contains `visibleLines[].text` only, not the cell/style data requested by the dogfood step. That limits semantic color review to plain text instead of structured style inspection.
2. **Default geometry is too narrow for the fixture.** The captured screenshots and structured snapshot show wrapping in the longest color rows, which makes side-by-side palette comparison harder.

## Command results

See `command-status.tsv` for the exact commands and exit codes. All scenario-C CLI commands exited `0`.
