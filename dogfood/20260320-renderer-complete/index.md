# Renderer completion proof bundle index

This bundle captures the final Week 2 renderer smoke story for 2026-03-20.

## Primary evidence

| File                       | What it proves                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `notes.md`                 | Narrative summary of the scenario, renderer checks, and what to review.                                            |
| `commands.sh`              | Exact command sequence used to reproduce the create → wait → type → snapshot → screenshot → doctor → destroy flow. |
| `create-output.json`       | Session creation succeeded and returned session ID `01KM63G9DJ4DZD5RCXFJG547XG`.                                   |
| `wait-text.json`           | Renderer-backed `wait --text` matched `Ready`.                                                                     |
| `type-output.json`         | Text input was accepted by the live session.                                                                       |
| `wait-regex.json`          | Renderer-backed `wait --regex` matched the echoed typed text.                                                      |
| `snapshot-structured.json` | Structured renderer snapshot includes viewport metadata and visible lines.                                         |
| `snapshot-text.json`       | Text renderer snapshot includes the visible transcript in lightweight form.                                        |
| `screenshot-dark.json`     | Screenshot capture succeeded with `reference-dark`.                                                                |
| `screenshot-light.json`    | Screenshot capture succeeded with `reference-light`.                                                               |
| `manifest-excerpt.json`    | Artifact manifest recorded both snapshot outputs and both screenshot outputs.                                      |
| `doctor.json`              | Doctor passed renderer checks for Playwright, browser launch, ghostty-web, and screenshot viability.               |
| `destroy-output.json`      | Session cleanup/destroy completed after artifact capture.                                                          |

## Supplemental artifacts

| File                                         | What it shows                                                        |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `artifacts/screenshot-4-reference-dark.png`  | Copied dark-profile screenshot PNG from the temporary session home.  |
| `artifacts/screenshot-4-reference-light.png` | Copied light-profile screenshot PNG from the temporary session home. |

## Reviewer checklist

1. Open `notes.md` for the scenario summary.
2. Confirm `wait-text.json` and `wait-regex.json` both report `matched: true`.
3. Compare `snapshot-text.json` against the copied PNGs in `artifacts/`.
4. Confirm `manifest-excerpt.json` lists two snapshots and two screenshots.
5. Confirm `doctor.json` reports all renderer checks as passing.
