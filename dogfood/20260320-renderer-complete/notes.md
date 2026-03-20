# Renderer completion dogfood notes

- **Date:** 2026-03-20
- **Bundle:** `dogfood/20260320-renderer-complete/`
- **Session ID:** `01KM63G9DJ4DZD5RCXFJG547XG`
- **Scenario command:** `/bin/sh -c "printf \"Loading\\n\"; sleep 1; printf \"3 items\\n\"; sleep 1; printf \"Ready\\n\"; exec cat"`
- **Isolation:** all commands ran under a fresh `AGENT_TERMINAL_HOME=$(mktemp -d)` and the bundle captures the resulting JSON envelopes plus copied screenshot artifacts.
- **Environment note:** this was collected in a headless environment, so the proof relies on CLI JSON outputs, renderer-generated PNGs, and passing automated checks rather than interactive screen recording.

## What was exercised

This run covered the expected renderer-backed Week 2 inspection flow end to end:

1. **Create** a session that visibly transitions through `Loading`, `3 items`, and `Ready` before handing control to `cat`.
2. **Wait --text** for `Ready` to appear in renderer-visible output.
3. **Type** `typed from dogfood` into the live session.
4. **Wait --regex** for the echoed typed text to appear using the renderer path.
5. **Snapshot** the session in both structured and text formats.
6. **Screenshot** the session with both built-in renderer profiles (`reference-dark` and `reference-light`).
7. **Inspect artifact tracking** by reading the generated artifact manifest.
8. **Doctor** the environment and renderer stack.
9. **Destroy** the session cleanly after collecting artifacts.

## What was verified

### Session lifecycle

- `create-output.json` shows session creation succeeded and returned session ID `01KM63G9DJ4DZD5RCXFJG547XG`.
- `type-output.json` shows the typed-text control path acknowledged successfully.
- `destroy-output.json` shows the session was destroyed after evidence collection.

### Renderer-backed waits

- `wait-text.json` shows `wait --text Ready` matched successfully at `capturedAtSeq: 2`.
- `wait-regex.json` shows `wait --regex 'typed.+dogfood'` matched successfully at `capturedAtSeq: 4`.

### Snapshot coverage

- `snapshot-structured.json` contains renderer-structured viewport data, cursor position, and visible lines.
- `snapshot-text.json` flattens the same viewport into text and includes the expected visible transcript:
  - `Loading`
  - `3 items`
  - `Ready`
  - `typed from dogfood`

### Screenshot coverage

- `screenshot-dark.json` proves screenshot capture succeeded with the default `reference-dark` profile.
- `screenshot-light.json` proves screenshot capture succeeded with the `reference-light` profile.
- The actual PNG outputs were copied into `artifacts/screenshot-4-reference-dark.png` and `artifacts/screenshot-4-reference-light.png` so the bundle remains reviewable even though the original session home was temporary.

### Artifact tracking

- `manifest-excerpt.json` shows four tracked artifacts for the session:
  - structured snapshot JSON
  - text snapshot JSON
  - dark-profile screenshot PNG
  - light-profile screenshot PNG
- The tracked filenames line up with the copied bundle artifacts and with the JSON command envelopes.

### Doctor coverage

- `doctor.json` reports `ok: true`.
- All renderer checks passed: `playwright_available`, `browser_launch`, `ghostty_web_available`, and `screenshot_viable`.

## Review guidance

A reviewer can validate the Week 2 renderer slice offline by opening the JSON files in this directory, confirming the manifest artifact list, and comparing the copied PNGs in `artifacts/` against the visible text reported by the snapshot outputs.
