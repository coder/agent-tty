---
status: accepted
---

# Renderer dispose swallows cleanup failures at the public boundary

## Context

The `ghostty-web` renderer backend acquires several resources during `boot()`:
a local HTTP server, a Playwright browser, a browser context, and a page.
Cleanup of these resources can fail for many reasons: the browser may have
already crashed, the page may already be closed, the local server socket may
have an outstanding connection, or Playwright may reject during teardown.

The `dispose()` boundary is called from two distinct paths:

1. Normal session shutdown, where higher layers expect dispose to settle
   without forcing them to handle additional rejection cases.
2. Boot-failure rollback inside `bootInternal()`, which already has an
   in-flight error to propagate and should not have its rollback hidden by a
   later cleanup rejection.

We refactored cleanup onto a `ResourceScope` helper that registers a release
callback for every acquired resource, runs the releases in LIFO order, and
collects any failures into a `ResourceScopeCloseError` so the caller can see
the resource name + original error for each failure.

We had to choose what `dispose()` should do when one or more registered
releases fail.

## Decision

`GhosttyWebBackend.dispose()` is best-effort at the public boundary:

- Cleanup continues through every registered release even if earlier
  releases throw.
- A private helper closes the per-lifecycle `ResourceScope` and catches the
  resulting `ResourceScopeCloseError`.
- Each individual release failure is logged via `this.logger.warn` with the
  resource name and original error attached.
- `dispose()` itself resolves successfully (it does not propagate the
  cleanup error).
- Cleanup failures are not appended to the session event log; the event log
  remains canonical execution truth, not a renderer-internal diagnostic
  channel.

The same helper is used during boot-failure rollback so that a partially
booted backend can still propagate the original boot error without it being
overwritten by a cleanup error.

## Consequences

- Higher layers (host, CLI, integration tests) keep their existing contract:
  `dispose()` resolves cleanly, including after boot failure or repeated
  calls.
- Operators who run with `AGENT_TTY_LOG_LEVEL=warn` or lower see one warn
  log entry per failed release, with the resource name and original error
  preserved by `ResourceScopeCloseError`. This makes it possible to
  diagnose stuck Playwright handles or orphan local servers without
  destabilising shutdown.
- A new failure mode (a release helper itself throwing something other
  than `ResourceScopeCloseError`) is also caught defensively and warned,
  so dispose cannot crash the host on an unexpected internal bug.
- Because the `ResourceScope` is per-lifecycle (a fresh scope is created at
  the start of every `bootInternal()`), the existing contract that supports
  `boot()` after `dispose()` is preserved. The renderer can recover and
  re-boot, and a subsequent `dispose()` call sees a fresh scope with no
  stale registrations from the previous lifecycle.

## Alternatives considered

- **Propagate cleanup failures from `dispose()`**. Rejected because shutdown
  paths (CLI exit, host teardown, integration tests calling
  `await backend.dispose()` in `finally`) would all have to grow new
  rejection-handling. The previous behaviour was already best-effort cleanup;
  this ADR records that contract and replaces ad hoc per-resource
  `try/catch` blocks with a structured helper.
- **Append cleanup failures to the session event log**. Rejected because
  the event log is the canonical execution truth for replay and renderer
  parity, not a place to record renderer-internal cleanup diagnostics.
  Operators already have the standard logger for this kind of telemetry.
- **Single class-level `ResourceScope` reused across lifecycles**. Rejected
  because the existing integration test
  (`test/integration/renderer-backend.test.ts`) explicitly supports
  `boot()` after `dispose()`. A per-lifecycle scope keeps that contract
  intact while still letting acquisition-time `scope.add(...)` register
  every release deterministically.
