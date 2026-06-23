---
name: dogfood-tui
description: Structured TUI dogfooding and QA workflow using agent-tty. Use for exploratory testing, bug hunting, release-readiness validation, and UX review of terminal applications.
advertise: true
---

# Dogfooding TUIs with agent-tty

Use this skill when the user wants structured exploratory testing, bug hunting, release-readiness validation, or UX review for a terminal application or TUI.

## Prerequisites

This workflow assumes the `agent-tty` core skill is already loaded.
If it is not, load it first with `agent-tty skills get agent-tty`.
Use this skill as the specialized QA layer on top of the core terminal automation workflow.

## Choose the Evidence Instrument

Open an `agent-tty` session when the question needs runtime terminal evidence:
crashes, input routing, focus/navigation behavior, resize behavior, alt-screen or
screen-lifecycle cleanup, animation, transient corruption, or a reviewer-facing
recording of a real interaction.

Prefer source reading, focused unit tests, or layout tests before opening a
session for questions about layout math, string width/alignment, style mapping,
or static rendering logic. A session can still corroborate the result, but it
should not be the first or only instrument for source-answerable questions.

Treat `snapshot --format text` as searchable terminal text evidence, not as an
authoritative column-width oracle. For CJK, emoji, and other wide-glyph content,
text snapshots serialize the visible characters and can hide width/column
ambiguity. If a text snapshot disagrees with source or layout tests on wide-glyph
alignment, trust the source/tests first and use screenshots as visual
corroboration.

Sessions cost time and setup overhead. Use one when the bug class requires live
interaction or reviewable runtime proof, not as the default first move for every
visual question.

## Dogfooding Workflow

1. **Create an isolated home** so artifacts and session state stay reviewable and do not pollute the real user environment.
2. **Check renderer and browser prerequisites** with `doctor --json` before any screenshot or recording work.
3. **Create the session** with a known shell or launcher command and capture the returned session ID.
4. **Launch the target app intentionally**:
   - Use `run` for fast setup commands or scripted launches.
   - Use `type` for literal keystroke-by-keystroke text entry that should appear in the session.
   - Use `send-keys` for control input such as arrows, Enter, Escape, Ctrl+C, or function-key navigation.
5. **Wait on observable state** with `wait` instead of blind sleeps:
   - `--text` when a label, prompt, or status message should appear.
   - `--screen-stable-ms` when the UI is animating or repainting.
   - `--idle-ms` when command completion matters more than screen text.
6. **Capture the current screen state** with `snapshot --format text --json` for searchable text evidence.
7. **Capture visual proof** with `screenshot --json` when runtime layout, color, cursor, or rendering quality needs visual corroboration.
8. **Export motion proof** with `record export --format webm --json` when the issue involves navigation, animation, resize behavior, focus handling, or transient corruption.
9. **Repeat the loop** for every meaningful scenario: startup, first-run prompts, resize, help flows, error handling, and teardown.
10. **Destroy the session** when the investigation is complete.

## Recommended Session Skeleton

```bash
DOGFOOD_HOME="$(mktemp -d)"
agent-tty --home "$DOGFOOD_HOME" doctor --json
SESSION_ID=$(agent-tty --home "$DOGFOOD_HOME" create --json -- /bin/bash | jq -r '.result.sessionId')
agent-tty --home "$DOGFOOD_HOME" run "$SESSION_ID" '<launch-command>' --no-wait --json
agent-tty --home "$DOGFOOD_HOME" wait "$SESSION_ID" --screen-stable-ms 1000 --json
agent-tty --home "$DOGFOOD_HOME" snapshot "$SESSION_ID" --format text --json
agent-tty --home "$DOGFOOD_HOME" screenshot "$SESSION_ID" --json
agent-tty --home "$DOGFOOD_HOME" record export "$SESSION_ID" --format webm --json
agent-tty --home "$DOGFOOD_HOME" destroy "$SESSION_ID" --json
```

## Evidence Checklist

Collect enough evidence that another reviewer can reproduce the result without guessing:

- Exact repro commands, including the launch command and every subsequent `run`, `type`, or `send-keys` action.
- Terminal dimensions used for the repro, especially if layout or wrapping is part of the issue.
- At least one screenshot path for the failing or noteworthy state.
- A WebM export path when motion, navigation sequence, or transient rendering matters.
- Snapshot text for the most relevant terminal states so reviewers can search output quickly.
- Expected behavior versus actual behavior written in plain language.
- Whether the issue reproduces consistently, intermittently, or only after a specific setup sequence.
- Cleanup notes, especially if the app leaves background state, temp files, or a broken terminal mode behind.

## Issue Taxonomy

Use consistent labels and notes so findings can be triaged quickly:

- **Rendering corruption** — garbled characters, color loss, double paint, cursor artifacts, or stale cells.
- **Resize/layout** — wrapping bugs, clipped panes, overlapping widgets, incorrect recompute after resize, or unusable small-screen behavior.
- **Focus/input** — lost keystrokes, wrong focused widget, modal traps, broken shortcuts, or incorrect key interpretation.
- **Scrollback** — missing history, jumpy scrolling, incorrect paging, or broken mouse wheel behavior.
- **Alt-screen** — failure to enter or exit cleanly, leaked UI frames, or shell prompt corruption after exit.
- **Copy/paste** — paste corruption, bracketed-paste issues, selection problems, or unsafe multiline submission behavior.
- **Performance/startup** — slow launch, delayed first paint, high-latency navigation, or visible stutter.
- **Crash/recovery/state loss** — panic, unexpected exit, broken resume path, lost form state, or inconsistent restoration after restart.

## Report Template

Use this structure when handing findings back to the user or a maintainer:

- **Title:** concise issue summary
- **Environment:** OS, shell, app version/commit, terminal dimensions, and whether `doctor --json` passed
- **Reproduction steps:** numbered sequence with the exact `agent-tty` commands and key inputs used
- **Evidence bundle:** paths to snapshot text, screenshot PNG, WebM, and any additional logs
- **Expected behavior:** what should have happened
- **Actual behavior:** what happened instead
- **Impact:** severity, user-facing risk, and whether it blocks release-readiness
- **Workaround:** any known mitigation or safer path
- **Regression suspicion:** whether this looks new, long-standing, or tied to a recent change

Prefer concise, repeatable repros and artifact-backed findings over narrative descriptions. The goal is a reviewable proof bundle, not just an anecdote.
