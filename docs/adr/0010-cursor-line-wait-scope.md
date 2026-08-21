---
status: accepted
---

# Render waits accept a cursor-line scope to defeat echo-match

## Context

ADR 0007 gave **Render Waits** an optional **Wait Baseline** (`afterSeq`) and
deliberately left _echo-match_ unsolved: a `wait --text "foo"` can match the
terminal's **echo of a just-typed command** because the echo renders _after_
the baseline. Both ADR 0007 and the batch PRD declared echo-match the caller's
concern (use a distinctive output token or `screenStableMs`).

That workaround is weak for the most common wait target: a prompt. Prompts
often reproduce text the caller just typed, and `screenStableMs` trades
correctness for latency and can still accept a stalled-but-wrong screen.

## Decision

A **Render Wait** text/regex condition accepts an optional **scope**:
`screen` (default, the whole visible screen — prior behavior) or
`cursor-line` (only the row the cursor is on). Once Enter is pressed the
cursor moves past the echoed line, so a `cursor-line` wait cannot match the
echo. Prompts render exactly at the cursor, making them the intended target.

- `scope` is added to `WaitForRenderParams` and batch wait steps; it requires
  `text` or `regex`.
- The matcher evaluates `cursor-line` conditions against
  `visibleLines[cursorRow]`, which is right-trimmed of trailing ASCII spaces
  like every rendered line.
- With no `scope` a wait behaves exactly as before, so the change is backward
  compatible.

This amends the echo-match consequence of ADR 0007: echo-match now has a
first-class remedy. The **Wait Baseline** remains the stale-match remedy, and
the two compose — a standalone `cursor-line` wait issued right after an input
command should still thread that input's `seq` into `--after-seq`, because
input RPCs return before the application's response necessarily renders.

## Consequences

- Prompt waits are echo-safe without inventing distinctive output tokens or
  paying `screenStableMs` latency.
- Waiting on output that scrolls past the cursor still needs a distinctive
  token or screen stability; `cursor-line` is a prompt-shaped tool.
- One optional enum grows the protocol and matcher surface.

## Alternatives considered

- **Keep echo-match the caller's concern (status quo).** Rejected: the
  workaround fails precisely on prompts, the most common wait target.
- **Exclude the echoed input line by diffing against a pre-input capture.**
  Rejected: heuristic, breaks when output legitimately repeats the input, and
  does not use the canonical event-log/cursor state.
