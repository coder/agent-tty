# agent-terminal v1 dogfooding and validation

This document defines how to prove that `agent-terminal` actually works for TUI dogfooding.

It is intentionally prescriptive.

A follow-up AI coding agent should treat this file as the minimum review protocol, not optional guidance.

## Current shipped state (2026-03-22)

This document still describes the broader dogfooding target, but the repository now ships the full core artifact set needed for review bundles.

Shipped today:

- JSON command outputs,
- semantic snapshots, including optional scrollback capture,
- PNG screenshots with richer metadata,
- `.cast` export,
- replay video export,
- artifact manifests,
- and notes / proof bundles under `dogfood/`.

The remaining gaps are now mostly about local review ergonomics rather than missing artifact classes. The dedicated `unicode-grid` and `scrollback-demo` fixtures, their matching E2E coverage, and the Week 4 proof bundles are now shipped; the biggest open item is a local bundle review helper.

Read the remainder of this file as the broader validation target and checklist for closing those remaining gaps.

## Week 4 coverage

As of 2026-03-22, the repo ships the deterministic `unicode-grid` and `scrollback-demo` fixtures plus dedicated E2E coverage in `test/e2e/unicode-grid.test.ts` and `test/e2e/scrollback-demo.test.ts`.

The repo also now has four Week 4 proof bundles that cover the shipped gap-closing work:

- `dogfood/20260322-week4-cli-parity/` proves CLI-contract parity and result-shape behavior,
- `dogfood/20260322-week4-failure-recovery/` proves failure retention and recovery evidence,
- `dogfood/20260322-week4-scrollback-review/` proves scrollback capture and replay review,
- and `dogfood/20260322-week4-unicode-review/` proves unicode/width review coverage.

Earlier proof bundles remain relevant context:

- `dogfood/20260321-post-hardening-smoke/` revalidates live inspect/wait/snapshot/screenshot/doctor flows,
- `dogfood/20260321-week3-renderer-complete/` proves live and post-exit snapshot/screenshot/export plus GC,
- `dogfood/20260321-week3-crash-retention/` proves abnormal-exit evidence retention,
- `dogfood/20260322-global-cli-context/` proves `--home`, `--no-color`, and exit-code differentiation for missing sessions,
- and `dogfood/20260322-lazyvim-scenario/` demonstrates real-world TUI driving plus screenshot / asciicast / WebM review artifacts.

The main remaining validation gap is:

- there is still no local proof-bundle review helper/page.

## 1. Dogfooding goals

Dogfooding must prove that an agent can:

- launch a TUI,
- interact with it,
- wait for meaningful state changes,
- capture semantic state,
- capture visual state,
- survive resize and redraw transitions,
- and leave reviewable artifacts behind.

## 2. Required proof artifacts

Every serious dogfood run must produce:

- at least one semantic snapshot JSON,
- at least one PNG screenshot,
- at least one video recording,
- at least one recording export (`.cast`),
- and a short human-readable notes file.

If any of these are missing, the run is incomplete.

## 3. Recommended artifact bundle layout

```text
dogfood/
└── <date>-<scenario>/
    ├── notes.md
    ├── manifest.json
    ├── create.json
    ├── inspect.json
    ├── snapshots/
    ├── screenshots/
    ├── recordings/
    └── videos/
```

## 4. Review rules

Reviewers should be able to verify a scenario by inspecting only the bundle.

That means:

- filenames must be descriptive,
- notes must explain what happened,
- screenshots should be named in order,
- videos should be short and focused,
- and manifest entries should link artifacts back to capture points.

## 5. Fixture-first validation strategy

Dogfooding should begin with bundled fixtures before moving to third-party TUIs.

Why:

- fixtures are deterministic,
- fixtures can be asserted in CI,
- fixtures reduce ambiguity when debugging tool failures.

Third-party TUIs are still valuable, but only after fixtures are solid.

## 6. Required fixture scenarios

## Scenario A — hello prompt

### Purpose

Validate the absolute basics:

- session creation,
- typing,
- key injection,
- clean exit.

### Steps

1. `create` the `hello-prompt` fixture.
2. `snapshot` immediately.
3. `type` a short string.
4. `send-keys` `Enter`.
5. `wait --text` for the echoed string.
6. `screenshot` the result.
7. `send-keys` `q`.
8. `wait --exit`.
9. `record export` as both `.cast` and `.webm`.

### Required artifacts

- initial snapshot JSON,
- echoed-result screenshot,
- final inspect JSON,
- `.cast`,
- `.webm`,
- notes explaining whether echoed text matched expectations.

## Scenario B — resize behavior

### Purpose

Validate the core value proposition around resize safety.

### Steps

1. `create` the `resize-demo` fixture at `40x120`.
2. capture screenshot `before-resize`.
3. `resize` to `50x140`.
4. `wait --screen-stable-ms 300`.
5. capture screenshot `after-resize-large`.
6. `resize` to `24x80`.
7. `wait --screen-stable-ms 300`.
8. capture screenshot `after-resize-small`.
9. export replay video.

### Review questions

- Did the border redraw cleanly?
- Did rows/cols indicators update correctly?
- Did any clipping or duplicated lines appear?
- Did the cursor remain inside the visible bounds?

### Required artifacts

- three screenshots,
- one replay video,
- one snapshot after the second resize,
- notes explicitly answering the review questions.

## Scenario C — color fidelity

### Purpose

Validate that the reference renderer is visually useful for color review.

### Steps

1. `create` the `color-grid` fixture.
2. capture a `reference-dark` screenshot.
3. capture a `reference-light` screenshot.
4. export one semantic snapshot with cell styles included.

### Review questions

- Are the normal and bright colors distinct?
- Are foreground labels readable against their backgrounds?
- Are any cells shifted or clipped?

### Required artifacts

- dark screenshot,
- light screenshot,
- styled snapshot JSON,
- notes listing any suspicious cells or palette issues.

## Scenario D — alternate screen behavior

### Purpose

Validate that the renderer and event log handle alternate-screen transitions.

### Steps

1. `create` the `alt-screen-demo` fixture.
2. capture screenshot `primary-before`.
3. enter alternate screen via the fixture keybinding.
4. `wait --text` for the alternate-screen marker.
5. capture screenshot `alternate`.
6. exit alternate screen.
7. capture screenshot `primary-after`.

### Review questions

- Did the primary screen return intact?
- Was cursor placement restored correctly?
- Did stale alternate-screen content leak into the primary screen?

### Required artifacts

- three screenshots,
- one snapshot from inside alternate screen,
- one replay video,
- notes answering the review questions.

## Scenario E — unicode and width handling

### Purpose

Validate that width-sensitive TUIs remain inspectable.

### Steps

1. `create` the `unicode-grid` fixture.
2. capture screenshot.
3. capture a full cell snapshot.
4. inspect alignment rows in notes.

### Review questions

- Are box-drawing characters continuous?
- Do CJK rows stay column-aligned?
- Do emoji rows visibly shift alignment?
- Are any replacement glyphs present?

### Required artifacts

- screenshot,
- cell snapshot JSON,
- notes calling out alignment observations.

## Scenario F — scrollback and replay

### Purpose

Validate large-output handling and replay export.

### Steps

1. `create` the `scrollback-demo` fixture.
2. wait for bulk output completion.
3. capture a viewport snapshot.
4. capture a scrollback snapshot.
5. export `.cast` and `.webm`.

### Review questions

- Does scrollback length match the fixture output count?
- Is replay export complete and ordered?
- Does the final video frame match the final screenshot?

### Required artifacts

- viewport snapshot,
- scrollback snapshot,
- final screenshot,
- `.cast`,
- `.webm`,
- notes answering the review questions.

## Scenario G — abnormal exit handling

### Purpose

Validate failure reporting and artifact retention.

### Steps

1. `create` the `crash-demo` fixture.
2. capture screenshot before triggering crash.
3. trigger crash.
4. `wait --exit` or inspect failure.
5. export final snapshot if supported.
6. export replay video.

### Review questions

- Is the failure visible in `inspect`?
- Are artifacts preserved after the crash?
- Does the event log clearly explain the final state?

### Required artifacts

- pre-crash screenshot,
- post-crash inspect JSON,
- replay video,
- notes on artifact retention and failure clarity.

## 7. Optional third-party smoke scenarios

Only run these after fixture scenarios are passing.

Suggested apps:

- `fzf`
- `htop`
- `gitui` or `lazygit`
- `vim` or `nvim`

These scenarios are useful for confidence but should not replace the fixture suite as the primary acceptance basis.

## 8. Minimal proof bundle for a pull request or review handoff

A minimal acceptable proof bundle should include:

- Scenario B resize artifacts,
- Scenario C color artifacts,
- Scenario D alternate-screen artifacts,
- Scenario F replay artifacts,
- Scenario G abnormal-exit artifacts.

This minimum set proves the tool can handle the most failure-prone terminal behaviors.

## 9. Screenshots and videos are mandatory

This requirement is deliberate.

A textual claim like "resize works" is insufficient.

For any change that affects rendering, replay, resize, cursor behavior, colors, or screen state, the follow-up AI agent should attach:

- before/after screenshots,
- and at least one video showing the interaction.

## 10. Suggested notes template

Every scenario directory should include `notes.md` using a template like:

```markdown
# Scenario: resize-demo

## Command under test

`agent-terminal ...`

## Expected behavior

- border redraws cleanly
- size indicators update
- no duplicated lines

## Observed behavior

- ...

## Artifacts

- screenshots/before-resize.png
- screenshots/after-resize-large.png
- screenshots/after-resize-small.png
- videos/resize-demo.webm
- snapshots/after-resize-small.json

## Issues found

- none / list here
```

## 11. CI validation guidance

CI should validate as much of the dogfood flow as practical.

### In CI, require:

- fixture integration tests,
- screenshot generation smoke tests,
- `.cast` export smoke tests,
- `.webm` export smoke tests on at least one tier-1 platform.

### In CI, optional initially:

- full video export on all platforms,
- heavy third-party TUI smoke runs,
- pixel-perfect screenshot diff gates.

## 12. Manual validation checklist

A human reviewer or implementing AI agent should answer these after a dogfood run:

- Can the session be created reliably?
- Do typed text and pasted text behave differently where expected?
- Does resize visibly redraw the whole screen without corruption?
- Do semantic snapshots describe what the screenshot shows?
- Does the video tell the same story as the screenshots?
- Can the session fail cleanly while preserving evidence?
- Is the generated bundle sufficient for someone else to review the issue offline?

## 13. Native rendering follow-up protocol

When native backends are added later, re-run at least:

- Scenario B resize behavior,
- Scenario C color fidelity,
- Scenario D alternate-screen behavior,
- Scenario E unicode and width handling.

For native backends, add environment metadata to the notes:

- OS version,
- terminal app and version,
- font name,
- display scale factor.

## 14. Validation acceptance checklist

The implementation should not be declared ready until:

- all required fixture scenarios were executed,
- screenshots exist for each required visual checkpoint,
- videos exist for each required interaction-heavy checkpoint,
- the artifacts match the notes,
- and at least one reviewer could validate the behavior from the bundle alone.
