---
status: accepted
---

# Session Dashboard follows the Event Log rather than the live host

## Context

The **Session Dashboard** presents a read-only **Live View** of a selected
**Session**'s screen. It needs fresh screen state for sessions that are still
`running` — which `CONTEXT.md` classifies as **Live Host Eligible Session**s,
where "callers should ask the live session host for fresh state."

There are three ways the dashboard could source that screen state:

1. **Ask the live host over RPC** (the Live-Host-Eligible path). The host owns
   the PTY and an in-memory renderer. But the RPC transport is one request /
   one response per connection (`src/host/rpcServer.ts` sends a single response
   and closes the socket), and there is no `subscribe`/`stream` method. A live
   dashboard would have to poll `snapshot` on a fresh connection per tick, which
   couples the dashboard to host availability and adds connect-per-poll cost.
2. **Follow the Event Log** (path chosen). The host already appends every
   `output`/`resize`/`exit` event to the append-only `events.jsonl` as it
   happens. Reconstructing the screen from those events is the same mechanism
   the renderer already uses for snapshots and offline replay
   (`buildReplayInput` → `RendererBackend.replayTo` → `snapshot`).
3. **Add a streaming `subscribe` RPC** to the host and push events to viewers.
   Lowest latency and centralised fan-out, but it requires extending the
   one-shot RPC dispatch model to support server-initiated frames.

A throwaway prototype validated option 2: following `events.jsonl` and replaying
into the `libghostty-vt` backend produced a screen **byte-identical to
`agent-tty`'s own `snapshot`** (including alt-screen apps such as Vim), with
frame work at ~2.3 ms p95 against a 33 ms (30 fps) budget. Render cost is never
the bottleneck; the only added latency is the follow interval, which is tunable.

## Decision

The **Session Dashboard** sources all screen state via **Event Log Follow** —
including for **Live Host Eligible** (`running`) Sessions — and does **not**
query the live session host. This is a deliberate departure from the
Live-Host-Eligible policy, justified because the append-only **Event Log** is
the canonical source of truth and is kept current for running sessions.

- v1 transport is a **file tail** of `events.jsonl` (byte-offset incremental
  reads, complete-line parsing), with **zero** changes to the RPC protocol.
- Screen reconstruction reuses the existing renderer pipeline
  (`replayTo` → `snapshot({ includeCells: true })`) on the **`libghostty-vt`**
  backend (pure Node/WASM, ~100 ms boot), not `ghostty-web` (which requires a
  Playwright Chromium and a 2–5 s boot).
- The dashboard reads the **Event Log** as the source of truth and treats the
  live host as an implementation detail it intentionally avoids touching.
- The screen-data source sits behind an interface so the transport can later
  change to a streaming `subscribe` RPC (option 3) without changing the
  **Session Dashboard** UI. **Event Log Follow** is defined by what it does, so
  it survives that transport change.

## Consequences

- The dashboard is read-only by construction and fully decoupled from the host:
  it never sends input, never participates in PTY size negotiation, and cannot
  destabilise a running **Session**. Many dashboards can follow the same
  **Session** concurrently because they only read a file.
- Liveness is gated by the follow interval (and the host's write cadence), not
  by a push channel, so the **Live View** can lag real output by up to roughly
  one interval. This is acceptable for human observation and is the main thing a
  future `subscribe` transport would improve.
- The dashboard depends on the on-disk **Event Log** being current for running
  sessions. If a host buffered output without appending promptly, the **Live
  View** would lag; today the host appends per output chunk, so this holds.
- A reader who expects the Live-Host-Eligible policy will find the dashboard
  ignoring the host on purpose; this ADR is the "why."

## Alternatives considered

- **Poll the live host's `snapshot` RPC for running sessions.** Rejected for
  v1: the one-shot socket forces a connect-per-poll, couples the dashboard to
  host availability, and still is not push. It also would not work uniformly for
  `destroying`/terminal sessions, which are not **Live Host Eligible**.
- **Add a streaming `subscribe` RPC now.** Deferred, not rejected. It is the
  natural next step if follow latency or many-session fan-out demands it, and
  the data-source seam is designed so it can replace the file tail without
  touching the UI. It was not justified for a usable v1 given the measured
  headroom.
- **Use the `ghostty-web` renderer backend.** Rejected for the dashboard:
  Playwright Chromium dependency and multi-second boot are unacceptable for an
  interactive, frequently-(re)started viewer. `libghostty-vt` reconstructs the
  same screen in-process.
