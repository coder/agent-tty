# PRD: Session Dashboard — a read-only live viewer for agent sessions

## Problem Statement

`agent-tty` keeps long-lived **Sessions** alive so that AI coding agents (and humans) can drive terminals across separate CLI invocations. But while an agent is working inside a **Session**, the human supervising it is flying blind: the only ways to see what the terminal currently looks like are to take a one-off **Snapshot**, render a **Screenshot**, or export a recording and replay it after the fact. None of those let a person simply _watch_ what an agent is doing in its shell, live, the way they could glance at a browser tab.

As a developer running one or more agents through `agent-tty`, I want to watch what those agents are doing in their shells in real time — ideally in a terminal pane next to the agent itself (e.g. a tmux split) — so that I can supervise progress, notice when something goes wrong, and understand what the agent saw, without interrupting it and without leaving the terminal.

## Solution

Add a new `agent-tty dashboard` subcommand: a **Session Dashboard** — a human-facing, read-only terminal surface that lists **Sessions** and presents a **Live View** of the selected one.

The **Session Dashboard** is master-detail: a list of **Sessions** on one side (the master), and a **Live View** of the currently selected **Session** on the other (the detail). The **Live View** is a continuously-updated reconstruction of that **Session**'s screen, produced by **Event Log Follow** — reading the **Session**'s append-only **Event Log** as new entries are appended and replaying them through the existing renderer. It is strictly read-only: it never sends input, never makes the **Session** a **Command Target**, and never resizes the **Session**.

Because **Event Log Follow** depends only on the immutable **Event Log** (the canonical source of truth) and never queries the live session host, the dashboard is fully decoupled from the host: it cannot disturb a running agent, any number of dashboards can watch the same **Session** at once, and every **Session** state transition degrades gracefully to "the log stopped growing" or "the log is gone." This is recorded in **ADR 0006** (the **Session Dashboard** follows the **Event Log** rather than the live host), along with the decision that the v1 transport is a file tail behind an interface so a future streaming subscribe channel can replace it without changing the UI.

The canonical use is a tmux split: the agent drives `agent-tty` on the left, and `agent-tty dashboard` mirrors the **Session** it's working in on the right.

## User Stories

1. As a developer supervising an agent, I want to run `agent-tty dashboard` and immediately see a list of my **Sessions**, so that I can pick one to watch.
2. As a developer, I want the list to default to **Active Sessions** (mirroring `list`), so that I see what is happening right now without clutter.
3. As a developer, I want a **Live View** of the selected **Session** that updates as the agent works, so that I can watch its terminal in real time.
4. As a developer, I want to run the dashboard in a tmux split next to the driving agent, so that I can watch the **Session** without leaving my terminal.
5. As a developer, I want the **Live View** to faithfully reproduce what the agent sees — colors, cursor, and full-screen TUIs (alt-screen apps like Vim or htop) — so that I trust it as an accurate mirror.
6. As a developer, I want to move the selection up and down the **Session** list with arrow keys or `j`/`k`, so that I can switch which **Session** I'm watching.
7. As a developer, I want to press `a` to toggle the list between **Active Sessions** only and all sessions (**Active** plus **Terminal**, excluding `destroyed`), so that I can also inspect runs that have already finished.
8. As a developer, I want a `--all` flag to open the dashboard already showing all sessions, so that I can start in the wider scope when I know I need it.
9. As a developer, I want a `--session <id>` flag to preselect a **Session** on launch, so that I can jump straight to the one I care about.
10. As a developer, I want the list ordered newest-first and refreshed live, so that new **Sessions** appear and statuses update as they transition.
11. As a developer, I want each row to show the **Session Status** and the command, so that I can tell what each **Session** is and what lifecycle state it's in.
12. As a developer watching a **Session** that exits, I want the **Live View** to freeze on the final screen and the status badge to update (e.g. `exited (code 0)` / `failed`), so that I can see exactly how the run ended.
13. As a developer, I want the **Session** I'm watching to stay pinned in the list even after it becomes **Terminal**, so that watching a run through to completion doesn't make it vanish from under me.
14. As a developer, I want a **Session** that is garbage-collected while I watch it to show a clear "**Event Log** collected — session no longer available" message and then drop out on the next refresh, so that I'm never left staring at a stale or broken view.
15. As a developer, I want the dashboard to never crash or hang when a **Session** changes state, so that I can leave it running for long stretches.
16. As a developer with a **Session** whose screen is larger than my dashboard pane, I want the **Live View** to clip to the top-left at 1:1 by default and show a truncation indicator, so that I still see real, readable output without distortion.
17. As a developer, I want to pan the clipped **Live View** so that I can read parts of a large **Session** screen that don't fit at once.
18. As a developer with a very large **Session** screen, I want to press `z` to toggle a fit-everything **Overview** that downsamples the screen into block glyphs, so that I can see the whole screen's shape at once (accepting that text is not readable in that mode).
19. As a developer, I want a **Session** whose screen is smaller than my pane to be shown at its own size with letterbox padding rather than stretched, so that the mirror stays faithful.
20. As a developer, I want the dashboard to never resize the **Session** I'm watching, so that observing an agent can never disrupt what it's doing.
21. As a developer, I want an in-app footer (and `--help`) listing the keybindings, so that I can discover how to navigate, toggle scope, switch zoom, and quit.
22. As a developer, I want to quit with `q` or `Ctrl-C`, so that I can exit cleanly.
23. As a developer, I want multiple dashboards to be able to watch the same **Session** at once, so that I can share a view or open it from more than one place without contention.
24. As a developer, I want the **Live View** to stay close to real time, so that what I see reflects what the agent is doing now.
25. As a developer running the dashboard in a non-interactive context (a pipe or CI), I want it to fail fast with a clear "requires an interactive terminal" message, so that I don't get garbled output.
26. As a developer whose environment lacks the required renderer, I want the dashboard to fail fast with an actionable message telling me how to enable it, so that I'm not left guessing.
27. As a developer, I want `agent-tty doctor` to report whether the dashboard is ready to run, so that I can diagnose a missing renderer before I try to use it.
28. As a developer, I want machine-readable session listing to remain available via `list --json`, so that the dashboard being interactive-only doesn't remove any scripting capability I already had.
29. As a maintainer, I want the dashboard to require the in-process **`libghostty-vt`** renderer and never silently fall back to the browser-backed renderer, so that the live experience is fast and predictable rather than incurring a multi-second browser boot.
30. As a maintainer, I want **`libghostty-vt`** to remain an optional dependency, so that base `agent-tty` installs stay portable on platforms without a prebuilt native module.
31. As a maintainer, I want the dashboard's screen-data source to sit behind an interface that emits **Event Log** entries, so that a future streaming subscribe channel can replace the file tail without touching the UI.
32. As a maintainer, I want the dashboard to read the **Event Log** as the source of truth and never query the live session host, so that it can't destabilize a running **Session** and behaves identically for live and finished **Sessions**.
33. As a contributor, I want the incremental **Event Log** tail extracted as a deep module with a simple interface, so that its tricky edge cases are tested in isolation.
34. As a contributor, I want the screen projection (clip / pan / letterbox / **Overview**) extracted as a pure function, so that fit-and-zoom behavior is unit-tested without any terminal or I/O.
35. As a contributor, I want the follow orchestration extracted so that coalescing, sequence advancement, and pin-on-exit can be tested against a fake renderer, so that the live-update logic is verified without booting a real backend.
36. As a contributor, I want the renderer-readiness check extracted, so that the missing-renderer error and the `doctor` capability entry are tested by injecting the module loader.
37. As a contributor, I want the new domain language (**Session Dashboard**, **Live View**, **Event Log Follow**) defined in the glossary, so that implementation discussions use precise, shared terms.
38. As a contributor, I want **ADR 0006** to explain why the dashboard follows the **Event Log** instead of the live host, so that nobody "fixes" it later by wiring it to the host RPC.
39. As a product maintainer, I want the dashboard framed as "watch what your agents are doing in their shells," so that the human value is obvious, while the domain model stays agent-neutral and defined over **Sessions**.
40. As a product maintainer, I want the dashboard to be a separate, opt-in surface rather than a change to existing inspection commands, so that the public CLI JSON contracts and artifact formats are untouched.

## Implementation Decisions

- Add a new interactive `agent-tty dashboard` subcommand. It is human-facing and **does not publish a `--json` contract** — a deliberate, documented deviation from the project's `--json`-everywhere convention, justified because the surface is an interactive TUI and `list --json` already covers machine-readable session listing.
- The dashboard is a **Session Dashboard** (master-detail): a live-refreshing **Session** list plus a **Live View** of exactly one selected **Session** at a time.
- The **Live View** is produced by **Event Log Follow**: read a **Session**'s append-only **Event Log** as entries are appended and reconstruct the screen with the existing renderer pipeline (`replayTo` → `snapshot` with cells included). It never queries the live session host (per **ADR 0006**).
- Introduce a `SessionEventSource` interface whose implementations emit **Event Log** entries for a **Session** as they appear. The v1 implementation is a file-tail reader (`EventLogTailSource`) that performs byte-offset incremental reads, buffers partial trailing lines, is safe against multibyte sequences split across reads, and handles truncation and a not-yet-created or collected log. A future streaming subscribe transport implements the same interface without UI changes.
- Introduce a `LiveViewFollower` deep module that consumes a `SessionEventSource`, accumulates entries, drives the renderer to advance to the latest sequence, coalesces frequent updates into a bounded redraw rate, and applies the pin-on-exit behavior. It depends on a renderer backend through a narrow interface so it can be tested with a fake backend.
- Introduce a `LiveViewProjection` pure function that maps a **Semantic Snapshot** plus a target pane size and view mode into the grid to paint: 1:1 clip-top-left with pan offset and a truncation indicator, letterbox for smaller screens, and a lossy block-glyph **Overview** for fit-everything. It performs no I/O and never reflows or stretches.
- Introduce a `RendererReadiness` check that probes **`libghostty-vt`** availability, produces an actionable failure message when it's absent, and contributes a dashboard-readiness capability that `doctor` reports.
- The dashboard always uses the **`libghostty-vt`** renderer regardless of the global renderer default, and never falls back to the browser-backed renderer. **`libghostty-vt`** remains an optional dependency; the dashboard is the feature that requires it and says so clearly when it's missing.
- List scope defaults to **Active Sessions** (mirroring `list`). The `a` key toggles to all sessions — **Active** plus **Terminal**, excluding `destroyed` (a **Collectable Session** whose **Event Log** may already be removed). A `--all` flag sets the initial scope; a `--session <id>` flag preselects a **Session**.
- The currently selected **Session** is pinned in the list through its transition to **Terminal**, with its **Live View** frozen on the final screen and a status badge. A collected **Event Log** (read error) surfaces a "collected — no longer available" state and the **Session** drops out on the next refresh.
- The **Session Dashboard** never resizes a **Session**; the **Live View** reflects the **Session**'s own terminal size and is clipped, panned, letterboxed, or shown as a lossy **Overview** to fit the pane.
- The session-list scope adapter reuses the existing session-listing capability; the Ink-based dashboard shell and the CLI command registration (including a non-TTY guard that fails fast) are thin glue over the deep modules.
- No changes to public CLI JSON contracts, protocol schemas, or artifact formats. No new RPC method is added in v1.

## Testing Decisions

- A good test verifies external behavior through a module's public interface, not its internals. Tests feed inputs and assert observable outputs; they do not assert private helper ordering.
- `EventLogTailSource` is unit-tested with fixture **Event Log** files for: incremental reads across multiple polls, a partial trailing line written mid-append, a multibyte sequence split across reads, truncation/rewrite, and a not-yet-created or removed log. The existing event-log codec tests are prior art for fixture-driven **Event Log** parsing.
- `LiveViewProjection` is unit-tested as a pure function: fixture **Semantic Snapshots** plus pane sizes and modes in, painted grids out — covering clip-top-left, pan offsets, the truncation indicator, letterbox, and **Overview** downsampling. It needs no terminal and no I/O.
- `LiveViewFollower` is unit-tested against a fake `SessionEventSource` and a fake renderer backend: it advances to the latest sequence, coalesces bursts into bounded redraws, freezes and pins on **Session** exit, and surfaces the collected state on a read error. The existing offline-replay and renderer-backend tests are prior art for driving reconstruction from **Event Log** entries.
- `RendererReadiness` is unit-tested by injecting the renderer module loader to simulate present and absent **`libghostty-vt`**, asserting the actionable error and the `doctor` capability entry. The existing capability-discovery and `doctor` tests are prior art.
- The Ink dashboard shell and CLI command wiring are thin glue; coverage focuses on the deep modules above plus a lightweight check that the command rejects a non-interactive terminal. Live, interactive behavior in a real TTY remains manual verification, consistent with how other interactive surfaces are exercised.

## Out of Scope

- **Input take-over.** v1 is strictly read-only; the **Live View** is never **Commandable**. The architecture leaves a seam for an input-capable mode later, but no take-over, focus handoff, or input-ownership model is built now.
- **Multi-session grid.** v1 shows one **Live View** at a time (master-detail). Tiling several live screens at once is deferred.
- **Session Activity (busy/idle) indicators.** v1 shows **Session Status** only. A derived busy/idle signal is deferred, and **Session Status** must not be overloaded to mean "busy."
- **Temporal scrollback, replay-scrubbing, and time-travel.** v1 shows the live visible screen only. After-the-fact review is already served by `record export`/replay and `snapshot`.
- **A streaming subscribe RPC (path C).** Deferred. The v1 file-tail transport is sufficient per the prototype, and the `SessionEventSource` seam lets a subscribe transport drop in later without UI changes.
- **True graphical (pixel) zoom.** A character-cell TTY cannot scale glyphs; an image-protocol path (scaled screenshots) is too slow for live follow and host-terminal-dependent. The lossy **Overview** is the v1 fit-everything answer.
- **Falling back to the browser-backed renderer** when **`libghostty-vt`** is unavailable.
- **Any change to public CLI JSON contracts, protocol schemas, or artifact formats.**

## Further Notes

- This PRD follows a research report and a validated throwaway prototype. The prototype implemented **Event Log Follow** via file-tail into the **`libghostty-vt`** backend and confirmed the reconstructed screen was byte-identical to `agent-tty`'s own `snapshot`, including the alt-screen case (Vim). Measured: backend boot ~29 ms, first paint ~4 ms, steady-state frame work ~2.3 ms p95 against a 33 ms (30 fps) budget, and a 410-event burst absorbed into a single frame. Render cost is never the bottleneck; the only added latency is the follow interval, which is the main thing a future subscribe transport would improve. The prototype lives under a gitignored `proto/` directory and should be removed once the real feature lands.
- New domain language is already recorded in `CONTEXT.md`: **Session Dashboard**, **Live View**, and **Event Log Follow**, plus relationships establishing read-only/never-resize behavior and the flagged-ambiguity note that "agent" stays product copy and is deliberately not a domain term.
- The Event-Log-over-host architecture and the file-tail-now / subscribe-later seam are recorded in **ADR 0006**.
- Product copy (README, `--help`) should use the "watch what your agents are doing in their shells" framing, while the domain model and code stay agent-neutral and defined over **Sessions**.
