---
status: accepted
---

# Render waits accept an optional Wait Baseline

## Context

The `batch` command runs an ordered sequence of **Batch Steps** — input actions
and **Render Waits** — through one **Command Target** with no human pacing
between them. A **Render Wait** today (`waitForRender` in
`src/host/hostMain.ts`) polls the renderer every 200 ms and matches against the
**latest** **Semantic Snapshot**; `WaitForRenderParams`
(`src/protocol/schemas.ts`) carries text/regex/screenStableMs/cursor/timeout and
nothing about event-log position.

That is fine for a human invoking `wait` once, but unsafe for steps that run
back-to-back. A wait step can match the screen left by the *previous* step
before the current step has rendered (stale-match), and a `screenStableMs` wait
can declare that *old* screen "stable" before the new input even appears. The
batch then advances on a false premise and sends later keystrokes into the wrong
state. This is the property that separates `batch` from a hand-written shell
loop, so it has to be correct.

## Decision

A **Render Wait** accepts an optional **Wait Baseline**: an **Event Log**
sequence (`afterSeq`) it must observe a **Semantic Snapshot** *strictly beyond*
before it may match or accrue **Screen Stability**. The `batch` executor sets
each wait step's baseline to the **Event Log** sequence recorded after the
preceding input **Batch Step**, so a wait only ever reflects state at or after
its own step. The standalone `wait --after-seq <n>` exposes the same gate, since
`snapshot` and `wait` already return a `capturedAtSeq` callers can chain.

- `afterSeq` is added to `WaitForRenderParams`; the host poll and the offline
  replay matcher reject any snapshot whose `capturedAtSeq` is not strictly
  greater than the baseline.
- With no baseline a **Render Wait** behaves exactly as before (matches the
  latest snapshot), so the change is backward compatible.

## Consequences

- `batch` is meaningfully safer than scripting the existing commands in a loop:
  each wait is anchored to its own step rather than racing the previous step's
  screen.
- The **Wait Baseline** fixes **stale-match** only. It does **not** fix
  *echo-match* — a `wait --text "foo"` matching the terminal's echo of a
  just-typed `foo`, which renders *after* the baseline. Echo-match stays the
  caller's concern (use a distinctive output token or `screenStableMs`), exactly
  as with the `wait` command today.
- A small amount of protocol and matcher surface grows (one optional field plus
  a `capturedAtSeq > afterSeq` gate in the live poll and the offline matcher).
  Offline replay can only apply the floor against the single latest snapshot it
  reconstructs.

## Alternatives considered

- **Require the visible text to change from a pre-step capture.** Rejected:
  heuristic rather than exact, never matches a step that legitimately reproduces
  identical text, and does not use the canonical **Event Log**.
- **No baseline in v1 (match the latest screen, document the foot-gun).**
  Rejected: it leaves `batch` only marginally safer than a shell loop, and the
  stale-match failure is silent and order-dependent.
