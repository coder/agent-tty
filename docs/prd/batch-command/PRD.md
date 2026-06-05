# PRD: `batch` command

## Problem Statement

Driving a terminal through `agent-tty` today means one CLI invocation per action: `run`, then `wait`, then `send-keys`, then `wait` again, each a separate process. For an AI coding agent — or a human — scripting a multi-step interaction with a **Session**, that has two recurring hazards:

- There is no safe way to express "do this, then wait for _its_ effect, then do the next thing" as one unit. A **Render Wait** issued right after input can match the screen left by the _previous_ action before the new one has rendered, so the script races ahead and sends later keystrokes into the wrong screen.
- The per-action ceremony is verbose, and every caller has to re-implement the same failure handling (stop when a wait times out) and the same sequencing by hand in a shell loop.

## Solution

A new `batch` command runs an ordered sequence of **Batch Steps** against one **Command Target** in a single invocation. Each **Batch Step** is exactly one action — `type`, `paste`, `send-keys`, `run`, or a `wait` (**Render Wait**). The caller supplies the steps as a JSON array, either inline or from a file.

Every `wait` step is anchored to a **Wait Baseline**: it only considers screen state produced _after_ the preceding input step, so a **Batch** is meaningfully safer than a hand-written loop — it cannot match a stale pre-step screen. A **Batch** is fail-fast by default: the first failed **Batch Step** (a timed-out **Render Wait**, or input to a **Session** that is no longer a **Command Target**) stops the run, so later steps never fire against an unexpected screen.

## User Stories

1. As an AI coding agent, I want to run an ordered sequence of terminal actions in one `batch` call, so that I don't coordinate many separate CLI invocations.
2. As an AI coding agent, I want each `wait` step to observe only the screen produced after the preceding input step, so that my batch never matches a stale screen and races ahead.
3. As an AI coding agent, I want to drive an interactive TUI — open it, wait for it to settle, send key chords, wait for a label — in a single batch, so that I can reproduce a TUI workflow deterministically.
4. As a human automating a shell setup, I want to chain `run` and `wait` steps in one command, so that I can express a setup sequence without a sleep-and-grep shell loop.
5. As a caller, I want a batch to stop at the first failed step by default, so that later keystrokes don't land in an unexpected screen state.
6. As a caller, I want a `--keep-going` option, so that I can run a best-effort batch that attempts every step regardless of failures.
7. As a caller, I want the result to tell me exactly which steps completed and which one failed, so that I can diagnose where the interaction broke, since a batch is not atomic and already-sent input cannot be undone.
8. As a caller, I want to supply steps either as an inline positional JSON string or via `--file`, so that I can choose between quick one-offs and reusable step files.
9. As a caller, I want a clear validation error when I pass both inline steps and `--file`, or neither, so that ambiguous input fails fast with a helpful message.
10. As a caller, I want each step to be a single action with one verb, so that the step format is unambiguous and mirrors the rest of the CLI.
11. As a caller, I want `wait` steps to reuse the exact conditions of the `wait` command (text, regex, screen stability, cursor, timeout), so that I don't learn a second wait vocabulary.
12. As a caller using `--json`, I want a stable machine-readable envelope with per-step outcomes, so that I can program against the batch result.
13. As a caller, I want a non-zero exit code when a batch fails fast, so that scripts and agents can detect failure without parsing output.
14. As an agent, I want a `run` step to behave as a **Waited Run** by default and to support a no-wait option, so that command-completion semantics match the standalone `run`.
15. As an agent, I want to set a per-`wait`-step timeout, so that different steps can wait for different durations.
16. As a developer of agent-tty, I want the standalone `wait` command to also accept an explicit **Wait Baseline**, so that the primitive is reusable outside batch (for example, chaining a wait after a captured sequence from `snapshot`).
17. As a caller, I want a batch to target one **Command Target** resolved once at the start, so that the whole sequence applies to a single consistent **Session**.
18. As a caller, I want a batch to stop if the target **Session** exits or becomes non-commandable mid-sequence, so that I never send input to a dead session.
19. As a caller, I want the echo-match limitation documented, so that I know a `wait` can still match the echo of a just-typed command and write distinctive waits or use screen stability instead.
20. As an agent, I want batch to work uniformly whether I am driving a shell or a full-screen TUI, so that one mechanism covers both.
21. As a maintainer, I want the batch orchestration logic to be testable without a real PTY or renderer, so that ordering, baseline threading, and fail-fast are covered by fast, isolated tests.

## Implementation Decisions

- A new `batch <sessionId>` command. Steps are supplied as a positional JSON string XOR a `--file <path>` (mutually exclusive — a validation error if both or neither are given), mirroring the existing input-source convention. No stdin source in v1.
- A **Batch Step** is a tagged union with exactly one verb key: `type`, `paste`, `send-keys` (a list of key names), `run` (a **Waited Run** that supports a no-wait option), or `wait` (a **Render Wait** carrying the standard conditions: text, regex, screen-stable duration, cursor row/col, timeout). `send-keys` and `run` are modeled distinctly rather than as uniform text steps.
- **Wait Baseline**: the **Render Wait** parameters gain an optional event-log sequence floor. The live host poll and the offline replay matcher reject any **Semantic Snapshot** whose captured sequence is not strictly greater than the baseline. The batch executor records the **Event Log** sequence after each input step and passes it as the next `wait` step's baseline. The standalone `wait` command also exposes this baseline as a flag. This decision is recorded in ADR 0007. It fixes stale-match; it does not fix echo-match.
- The executor runs **client-side**: `batch` orchestrates the existing per-step input and **Render Wait** operations and threads baselines between them. Input results return their **Event Log** sequence so the executor can anchor the following wait; `run`, `send-keys`, and `mark` already return one, and the `type` and `paste` results gain it.
- **Fail-fast** by default: the first failed **Batch Step** stops the run and yields a non-zero exit. `--keep-going` attempts every step regardless. A **Batch** is not atomic; the result reports which steps completed. This default deliberately diverges from agent-browser's continue-by-default, because terminal steps are stateful and dependent.
- **Deep modules**: a **Batch Plan** parser (JSON to validated steps; pure) and a **Batch executor** (ordered execution, baseline threading, fail-fast, and result accumulation, driven through an injected step-driver interface so it runs without a real PTY or renderer).
- **Result envelope** (`--json`): a per-step array recording each step's index, kind, the input sequence or wait baseline, the wait outcome (matched, timed-out, matched text), and duration; plus an overall completed-step count and the failed-step index when fail-fast triggers. The **Command Target** is resolved once for the whole invocation.

## Testing Decisions

Good tests assert external behavior, not implementation details.

- **Batch executor (unit).** Drive the executor with a fake step-driver and assert ordering, **Wait Baseline** threading (each wait receives the prior input step's sequence), fail-fast versus `--keep-going`, and result accumulation — with no PTY or renderer. The current render-wait matcher unit tests are prior art for pure-logic coverage.
- **Batch Plan parser (unit).** Assert the tagged-union step kinds parse, the positional-XOR-file rule is enforced, and malformed or empty plans are rejected with clear errors.
- **Wait Baseline gate (unit).** Assert the render-wait matcher never matches a **Semantic Snapshot** at or below the baseline and can match one strictly above it, covering both the live and offline paths. This guards the ADR-0007 invariant.
- **Batch CLI (integration).** Against an isolated `AGENT_TTY_HOME` with a real **Session**: a multi-step plan, the fail-fast exit code, and the `--json` envelope shape. The existing CLI integration tests are prior art.
- **Batch end-to-end.** Drive a real TUI (for example `nvim --clean`) through a batch and assert the rendered result. The existing fixture-driven e2e flows are prior art.

## Out of Scope

- Capture steps inside a batch (taking a snapshot or screenshot, or exporting a recording, as a step). v1 batch is input plus wait; capture stays a separate command the caller runs around the batch.
- A stdin source for steps.
- Fixing echo-match (a `wait` matching the terminal's echo of a just-typed command). The **Wait Baseline** fixes stale-match only; echo-match stays the caller's responsibility — use a distinctive output token or a screen-stability wait — exactly as with the `wait` command today.
- A host-side batch RPC or single-round-trip execution. v1 executes client-side; a host-side executor is a possible later optimization.
- Inline waits attached to input steps, and any control flow (conditionals, loops, retries). v1 is a flat, linear sequence of single-action steps.
- Atomic or transactional rollback. Already-sent input cannot be undone.

## Further Notes

- The `batch` verb matches the closest analog, vercel-labs/agent-browser, which uses `batch` and keeps `wait` a separate step. agent-tty's fail-fast default is the deliberate divergence.
- The domain terms **Batch**, **Batch Step**, and **Wait Baseline** are defined in the project glossary, and the **Wait Baseline** decision is ADR 0007. The glossary terms, ADR 0007, and this PRD are on branch `feat/batch-command`.
- A small illustrative plan (shape only):

  ```json
  [
    { "run": "nvim --clean", "noWait": true },
    { "wait": { "screenStableMs": 1000 } },
    { "sendKeys": ["i"] },
    { "type": "hello" },
    { "sendKeys": ["Escape", ":wq", "Enter"] },
    { "wait": { "text": "written" } }
  ]
  ```
