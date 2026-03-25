# 2026-03-25 dogfood — Week 6 bundle B artifact health proof

## Bundle metadata

- **Bundle path:** `dogfood/20260325-week6-b-artifact-health/`
- **Session ID:** `01KMJ2RDHRZPYTZQW4WJH2717B`
- **Isolated AGENT_TERMINAL_HOME:** `/tmp/agent-terminal-week6.N8X5Dz`
- **Fixture:** `test/fixtures/apps/color-grid/main.ts`

## Scenario summary

This bundle proves the new artifact health summary by creating a screenshot artifact from an exited `color-grid` session, inspecting the healthy state, manually deleting the screenshot file from disk, and inspecting again to confirm missing-artifact detection.

## Review answers

- **Did the bundle create a real artifact?** Yes. `logs/03-screenshot.json` reports a screenshot artifact captured at sequence 1 with `rendererBackend: "ghostty-web"`, `pngSizeBytes: 48895`, and SHA-256 `8d62ca0c2ce4c8b4b3c99c7374db8ef5b5896f5751b4e24758c9a1c8ddf410c9`.
- **What artifact metadata was persisted?** `logs/04-session-artifact-manifest.json` records one artifact entry with ID `01KMJ2RH4H4ZDTYJ5SZQD785SB`, kind `screenshot`, and filename `screenshot-1-reference-dark.png`.
- **Did inspect report the healthy state?** Yes. `logs/05-inspect-healthy.json` shows `artifacts.total: 1`, `artifacts.byKind.screenshot: 1`, `missingCount: 0`, and `health: "healthy"`.
- **Did inspect detect a missing-on-disk artifact after deletion?** Yes. `logs/06-delete-artifact.json` records the manual removal, and `logs/07-inspect-missing.json` then reports `missingCount: 1`, `health: "missing-artifacts"`, plus a `missing` entry naming the deleted screenshot artifact.
- **Is there a reviewer-friendly copy of the generated PNG?** Yes. `screenshots/01-color-grid.png` preserves the screenshot before deletion from the temp home so the rendered output is still reviewable.

## Issues / limitations

- None during capture. The missing-artifact proof intentionally deletes the session-owned screenshot file after copying it into the bundle for review.
