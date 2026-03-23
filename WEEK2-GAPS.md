# Remaining gaps after Week 5

> Historical note: this file keeps its original filename (`WEEK2-GAPS.md`) because earlier design docs and proof bundles already reference it. Its contents now describe the current post-Week-5 delta rather than the original Week 2-only gap list.

Week 1 control-plane work, Week 2 renderer-backed inspection, Week 3 export / retention, and the core Week 4 CLI / artifact / lifecycle hardening have all landed. Week 5 added foundational scaffolding for config schema/loading, CLI context extensions (`logLevel`, `profileDefault`), `ReplayTimingModeSchema`, and unit coverage, but that infrastructure is not yet wired end to end. The remaining work is now concentrated in the areas below.

## Post-Week-5 remaining gaps

### CLI contract and config parity

- **`--log-level`** — **Scaffolded (partially shipped):** context plumbing exists, but commands do not yet consume it end to end.
- **Global render-profile selection** — **Scaffolded (partially shipped):** context plumbing exists, but there is still no end-to-end global/profile-default command wiring.
- **`--idle-timeout-ms`** — **Scaffolded (partially shipped):** schema default exists, but `create` is not yet wired to use it.
- **`--append-newline`** — **Future scope / not started:** still not implemented for `type`.
- **Config-file loading** — **Scaffolded (partially shipped):** schema plus loader exist in `src/config/resolveConfig.ts`, but command flow integration and the broader env/config precedence story remain incomplete.
- **Full envelope/result-shape parity** — **Future scope / not started:** parity with every CLI-contract example is still incomplete.

### Artifact fidelity and metadata

- **Per-cell style metadata** — **Future scope / not started:** still not implemented.
- **The fuller `SnapshotCell` / expanded snapshot schema** — **Future scope / not started:** still not implemented.
- **Bundled deterministic font assets** — **Future scope / not started:** built-in profiles still rely on generic `monospace`.
- **Full replay timing controls** — **Scaffolded (partially shipped):** `ReplayTimingModeSchema` exists, but the reviewer-facing CLI surface is not wired.

### Failure semantics and recovery

- **Renderer/host recovery proof** — **Future scope:** still lighter than the main event-log/offline-replay story.
- **Broader failure storytelling** — **Future scope:** the repo records `failed` plus `failureReason`, but richer distinctions between abnormal child exit, host failure, and renderer failure remain unfinished.

### Fixture suite and dogfooding

- **Local proof-bundle review helper/page** — **Future scope / not started:** still not implemented.

### Platform and future-scope work

- **macOS CI coverage** — **Shipped / closed in Week 5:** this gap is now closed.
- **Platform support tier documentation** — **Shipped / closed in Week 5:** the README now documents platform support tiers.
- **Native renderer adapters** — **Future scope / not started:** still not implemented.
- **Mouse input support** — **Future scope / not started:** still not implemented.
- **Remote/network sessions** — **Future scope / not started:** still not implemented.
- **MCP wrapper** — **Future scope / not started:** still not implemented.
- **Cross-platform rendering parity** — **Future scope:** still not guaranteed, and Windows remains behind the design's intended tier-2 shape.
- **Renderer CSP trade-off** — **Future scope:** the localhost-only ghostty-web harness still needs `unsafe-inline` / `unsafe-eval` today.

## Recommended next step

The next milestone should focus on turning the Week 5 scaffolding into end-to-end behavior before opening a brand-new feature family:

1. wire the scaffolded CLI/config/replay infrastructure through command execution and JSON envelopes,
2. then finish snapshot/rendering fidelity work,
3. then finish local review/proof-bundle tooling,
4. then strengthen failure/recovery validation,
5. then continue broader native/platform future work.

See `design/20260319_agent-terminal-v1/10-week-4-status.md` for the detailed Week 4 status record, `design/20260319_agent-terminal-v1/11-week-5-plan.md` for the Week 5 execution plan, and `design/20260319_agent-terminal-v1/12-week-5-status.md` for the detailed Week 5 status record.
