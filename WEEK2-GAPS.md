# Remaining gaps after Week 4

> Historical note: this file keeps its original filename (`WEEK2-GAPS.md`) because earlier design docs and proof bundles already reference it. Its contents now describe the current post-Week-4 delta rather than the original Week 2-only gap list.

Week 1 control-plane work, Week 2 renderer-backed inspection, Week 3 export / retention, and the core Week 4 CLI / artifact / lifecycle hardening have all landed. The remaining work is now concentrated in the areas below.

## Post-Week-4 remaining gaps

### CLI contract and config parity

- **`--log-level`** is still not implemented.
- **Global render-profile selection** is still partial; `screenshot` exposes a command-local `--profile`, but there is not yet a broader global/profile-default story.
- **`--idle-timeout-ms`** is still not implemented for `create`.
- **`--append-newline`** is still not implemented for `type`.
- **Config-file loading** is still not implemented, and the broader env/config precedence story from `02-cli-contract.md` remains incomplete.
- **Full envelope/result-shape parity** with every CLI-contract example is still incomplete.

### Artifact fidelity and metadata

- **Per-cell style metadata** is still not implemented.
- **The fuller `SnapshotCell` / expanded snapshot schema** from `03-rendering-and-artifacts.md` is still not implemented.
- **Bundled deterministic font assets** are still not implemented; built-in profiles still rely on generic `monospace`.
- **Full replay timing controls** are still not exposed as a complete reviewer-facing CLI surface.

### Failure semantics and recovery

- **Renderer/host recovery proof** is still lighter than the main event-log/offline-replay story.
- **Broader failure storytelling** is still incomplete; the repo now records `failed` plus `failureReason`, but the docs still sketch richer future distinctions between abnormal child exit, host failure, and renderer failure.

### Fixture suite and dogfooding

- **Local proof-bundle review helper/page** is still not implemented.

### Platform and future-scope work

- **Native renderer adapters** are still not implemented.
- **Mouse input support** is still not implemented.
- **Remote/network sessions** are still not implemented.
- **MCP wrapper** is still not implemented.
- **Cross-platform rendering parity** is still not guaranteed, and Windows remains behind the design’s intended tier-2 shape.
- **Renderer CSP trade-off** still exists; the localhost-only ghostty-web harness still needs `unsafe-inline` / `unsafe-eval` today.

## Recommended next step

The next milestone should focus on the still-open parity and validation work rather than a brand-new feature family:

1. finish CLI/config parity,
2. finish snapshot/rendering fidelity,
3. finish the remaining validation/tooling work around local proof-bundle review,
4. strengthen failure/recovery validation,
5. then continue broader native/platform future work.

See `design/20260319_agent-terminal-v1/10-week-4-status.md` for the detailed Week 4 status record, `design/20260319_agent-terminal-v1/09-week-4-plan.md` for the original Week 4 plan, and `design/20260319_agent-terminal-v1/11-week-5-plan.md` for the current follow-on execution plan.
