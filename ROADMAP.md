# agent-terminal roadmap

`RELEASE.md` defines what `0.1.0` ships today. This roadmap tracks intentionally deferred work and post-release direction so the repository front door separates shipped scope from future scope.
For historical week-by-week planning and status context, see [`design/archive/`](./design/archive/). For the stable design overview, see [`design/ARCHITECTURE.md`](./design/ARCHITECTURE.md).

## Near-term refinements

- Broader reviewer-oriented introspection in `inspect --json`, especially around live renderer/session state when that adds clear operational value.
- Stronger proof-bundle conventions and automation so canonical `dogfood/` bundles stay easy to review and harder to let drift.
- Continued hardening around renderer/bootstrap ergonomics in isolated environments.

## Renderer and platform expansion

- Native renderer adapters beyond the current `ghostty-web` reference backend.
- Broader native-platform parity work, especially where Windows or native terminals diverge from the reference renderer.
- Follow-on renderer hardening such as tighter CSP or sandbox assumptions if the backend model evolves.

## Input and automation expansion

- Mouse input support.
- Richer semantic TUI automation beyond the current shell-oriented lifecycle, wait, snapshot, screenshot, and export flows.
- Additional higher-level workflows only after they fit the event-log-as-truth model and do not undermine the stable CLI surface.

## System integration

- Remote or networked session control.
- An MCP wrapper or other external control layers built on top of the CLI contract.

## Data-model redesigns

- Broader failure-taxonomy work beyond the current shipped termination/reporting categories.
- Event-log redesign only if the current append-only model proves too limiting for replay or recovery needs.
- Snapshot-schema expansion where the existing structured surface is not sufficient for review or automation use cases.

## Prioritization notes

1. Preserve the current release contract before widening scope.
2. Prefer incremental additions that reuse the existing CLI, storage, replay, and artifact model.
3. Archive historical planning/status detail instead of mixing it back into the roadmap.
