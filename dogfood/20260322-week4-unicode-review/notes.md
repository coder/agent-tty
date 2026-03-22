# 2026-03-22 week4 unicode review

## Bundle metadata

- **Date:** 2026-03-22
- **Bundle path:** `dogfood/20260322-week4-unicode-review/`
- **Environment:** Linux x86_64, agent-terminal v0.1.0, CLI runtime Node v24.14.0
- **AGENT_TERMINAL_HOME:** `/tmp/tmp.a1FNvTyErY`
- **Session ID:** `01KMBM9FPEBYVSBBFA0QXG8PNW`

## Scenario summary

This proof bundle captures a live `unicode-grid` fixture run to verify Unicode rendering coverage across:

- box-drawing glyphs
- CJK text
- emoji/symbol rows
- ambiguous-width mathematical/Greek characters

The fixture renders labeled rows `ASCII`, `BOX`, `CJK`, `EMOJI`, and `AMBIG`, then emits the sentinel `UNICODE GRID COMPLETE`.

## Reviewer guide

| File                 | Proof                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------- |
| `01-create.json`     | Session creation for the `unicode-grid` fixture                                       |
| `02-wait-ready.json` | Sentinel wait succeeded, proving the fixture rendered completely                      |
| `03-snapshot.json`   | Text snapshot containing all five row labels: `ASCII`, `BOX`, `CJK`, `EMOJI`, `AMBIG` |
| `04-screenshot.json` | PNG screenshot capture metadata for visual alignment review                           |
| `05-inspect.json`    | Session metadata, command, terminal geometry, and exited status                       |
| `06-destroy.json`    | Clean lifecycle completion via forced destroy                                         |

## Verification claims

1. `02-wait-ready.json` shows `matched: true`, `timedOut: false`, and `matchedText: "UNICODE GRID COMPLETE"`.
2. `03-snapshot.json` contains all five labeled rows: `ASCII`, `BOX`, `CJK`, `EMOJI`, and `AMBIG`.
3. `04-screenshot.json` proves a screenshot PNG was produced for human alignment review at `/tmp/tmp.a1FNvTyErY/sessions/01KMBM9FPEBYVSBBFA0QXG8PNW/artifacts/screenshot-1-reference-dark.png`.
4. `05-inspect.json` shows the fixture command exited with `exitCode: 0`.
5. `06-destroy.json` shows `destroyed: true` for clean teardown.

The screenshot is the primary human proof for alignment-sensitive rendering because it preserves the rendered grid layout, glyph spacing, and terminal cell alignment in a way text JSON alone cannot.

## Live capture

In a GUI-enabled review environment, inspect the PNG referenced by `04-screenshot.json` directly to verify alignment of box-drawing characters, CJK glyph spacing, emoji/symbol cells, and ambiguous-width characters against the surrounding table borders.
