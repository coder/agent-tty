# 2026-03-23 dogfood — Week 5 Lane B WebM timing modes

## Bundle metadata

- **Bundle path:** `dogfood/20260323-week5-render-timing/`
- **Fixture events:** `dogfood/20260322-dogfood-color/events.jsonl`
- **Replay mode:** offline replay against a synthetic exited session (`session.json`)
- **Session ID:** `01W5TIMNG1774283448`

## Scenario summary

This bundle exports the same exited session to WebM three times, varying only `--timing recorded|accelerated|max-speed`.

## Reviewer highlights

- `01-record-export-recorded.json` reports `metadata.timingMode="recorded"` and wrote `recordings/recorded.webm` (91218 bytes).
- `02-record-export-accelerated.json` reports `metadata.timingMode="accelerated"` and wrote `recordings/accelerated.webm` (112431 bytes).
- `03-record-export-max-speed.json` reports `metadata.timingMode="max-speed"` and wrote `recordings/max-speed.webm` (109662 bytes).
- The implementation default is `accelerated`; this bundle captures all three explicit modes so reviewers can compare the generated files directly.
- For this short color-grid replay, all three exports report the same event-span `durationMs=1233` because the underlying output timestamps are already close together; the reviewer-visible proof here is the distinct `timingMode` metadata plus differing WebM file sizes.

## Comparison guidance

- `recorded` preserves the real event gaps from the log.
- `accelerated` caps long gaps while keeping a readable replay speed.
- `max-speed` minimizes delays further (subject to the renderer's minimum frame hold).
- The JSON payloads also carry a shared `renderProfileHash=908ba0076143741bddebfffd75b4eca8397f320131ef8173a77302a39b2376f8` for the bundled `reference-dark` profile used for all three exports.
