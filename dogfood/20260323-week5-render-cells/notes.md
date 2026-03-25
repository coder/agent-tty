# 2026-03-23 dogfood — Week 5 Lane B per-cell snapshots

## Bundle metadata

- **Bundle path:** `dogfood/20260323-week5-render-cells/`
- **Fixture events:** `dogfood/20260322-dogfood-color/events.jsonl`
- **Replay mode:** offline replay against a synthetic exited session (`session.json`)
- **Session ID:** `01W5CELLS1774283515`

## Scenario summary

This bundle captures the same exited session twice via `snapshot`: once with `--include-cells` and once with the default structured output. Reviewers can diff the JSON files directly.

## Reviewer highlights

- `01-snapshot-include-cells.json` contains a top-level `cells` array with `24` rendered lines of per-cell metadata.
- `02-snapshot-default.json` omits the `cells` key entirely, confirming that per-cell payloads are opt-in.
- Both snapshots agree on the viewport (`80x24`), cursor position (`row 15, col 0`), and captured sequence (`4`).

## Representative cell entries

`cells-sample.json` extracts the first styled cells discovered in the snapshot so reviewers do not have to hunt through the full payload. These sample entries show foreground/background colors from the replayed ANSI output; this copied color-grid fixture does not emit bold or underline escapes, so the optional style-flag booleans are absent in this specific sample:

```json
[
  {
    "lineNumber": 2,
    "cellIndex": 1,
    "char": "B",
    "fg": "#eaeaea",
    "bg": "#1d1f21"
  },
  {
    "lineNumber": 2,
    "cellIndex": 2,
    "char": "G",
    "fg": "#eaeaea",
    "bg": "#1d1f21"
  },
  {
    "lineNumber": 2,
    "cellIndex": 3,
    "char": "-",
    "fg": "#eaeaea",
    "bg": "#1d1f21"
  },
  {
    "lineNumber": 2,
    "cellIndex": 4,
    "char": "4",
    "fg": "#eaeaea",
    "bg": "#1d1f21"
  },
  {
    "lineNumber": 2,
    "cellIndex": 5,
    "char": "0",
    "fg": "#eaeaea",
    "bg": "#1d1f21"
  },
  {
    "lineNumber": 2,
    "cellIndex": 12,
    "char": "B",
    "fg": "#eaeaea",
    "bg": "#cc6666"
  }
]
```

## Comparison guidance

- Open `01-snapshot-include-cells.json` and search for `"cells"` to inspect the full per-cell payload.
- Open `02-snapshot-default.json` and confirm the same visible text is present without the additional cell metadata.
