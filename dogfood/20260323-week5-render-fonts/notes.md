# 2026-03-23 dogfood — Week 5 Lane B bundled font rendering

## Bundle metadata

- **Bundle path:** `dogfood/20260323-week5-render-fonts/`
- **Fixture events:** `dogfood/20260323-week5-render-fonts/events.jsonl` copied from `dogfood/20260322-dogfood-color/events.jsonl`
- **Replay mode:** offline replay against a synthetic exited session (`session.json`)
- **Session ID:** `01W5FONTS1774283413`

## Scenario summary

This bundle replays the color-grid fixture twice through `screenshot`, once with `reference-dark` and once with `reference-light`, to prove the built-in render profiles can render reviewer-facing PNGs from the bundled JetBrains Mono font path.

## Reviewer highlights

- `01-screenshot-reference-dark.json` reported `renderProfileHash=908ba0076143741bddebfffd75b4eca8397f320131ef8173a77302a39b2376f8` and produced `screenshots/reference-dark.png`.
- `02-screenshot-reference-light.json` reported `renderProfileHash=edc8d16eecb0904138aef5a119c6d2888529b16f16172971add3cf9f43368d6f` and produced `screenshots/reference-light.png`.
- Both built-in profiles use the bundled **JetBrains Mono** family with a baked-in `fontAssetIdentity`; the hashes differ here because the full render profile also includes theme/background/foreground fields, but each hash is deterministic for its exact built-in profile definition.
- Both screenshots replayed the same 80×24 exited session at `capturedAtSeq=4`, so reviewers can compare just the profile/rendering differences.

## Artifact details

- `screenshots/reference-dark.png` — 48882 bytes, SHA-256 `55c7d357604a5c7bd200680d61b98d3e4dfd27a139a4c0dad6ee1df800a51c87`
- `screenshots/reference-light.png` — 48153 bytes, SHA-256 `f48f2bf87f4bbc5b051caa4b70585e3d44ba632263a11938b19df9b65b1de74d`
- Both JSON outputs include `rendererBackend: "ghostty-web"`, pixel dimensions, and the emitted `renderProfileHash` for reproducibility.
