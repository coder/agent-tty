# 2026-03-23 dogfood — Week 5 Lane B cursor visibility screenshots

## Bundle metadata

- **Bundle path:** `dogfood/20260323-week5-render-cursor/`
- **Fixture events:** `dogfood/20260322-dogfood-color/events.jsonl`
- **Replay mode:** offline replay against a synthetic exited session (`session.json`)
- **Session ID:** `01W5CURSR1774283429`

## Scenario summary

This bundle runs `screenshot` three ways against the same exited session: explicit `--show-cursor`, explicit `--hide-cursor`, and the default invocation with no flag.

## Reviewer highlights

- `01-screenshot-show-cursor.json` reports `cursorVisible=true` and produced `screenshots/show-cursor.png`.
- `02-screenshot-hide-cursor.json` reports `cursorVisible=false` and produced `screenshots/hide-cursor.png`.
- `03-screenshot-default.json` also reports `cursorVisible=false`, confirming the default behavior matches `--hide-cursor`.
- PNG digests make the pairing easy to verify: show `8d62ca0c2ce4c8b4b3c99c7374db8ef5b5896f5751b4e24758c9a1c8ddf410c9`, hide `55c7d357604a5c7bd200680d61b98d3e4dfd27a139a4c0dad6ee1df800a51c87`, default `55c7d357604a5c7bd200680d61b98d3e4dfd27a139a4c0dad6ee1df800a51c87`.
- The default and explicit hide renders match exactly, which is the key reviewer check for the default-hidden contract.

## Artifact details

- `screenshots/show-cursor.png` — 48895 bytes
- `screenshots/hide-cursor.png` — 48882 bytes
- `screenshots/default.png` — 48882 bytes
- All three JSON outputs include `renderProfileHash=908ba0076143741bddebfffd75b4eca8397f320131ef8173a77302a39b2376f8` for the shared `reference-dark` profile.
