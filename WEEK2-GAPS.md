# Remaining gaps after Week 3

> Historical note: this file keeps its original filename (`WEEK2-GAPS.md`) because earlier design docs and proof bundles already reference it. Its contents now describe the current post-Week-3 gaps rather than the original Week 2-only delta.

The Week 1 control-plane slice, Week 2 renderer slice, and Week 3 export / crash-retention work are now implemented. The remaining work is mostly about design parity, fidelity, and hardening.

## CLI contract and config parity

- **Global CLI flags** from `02-cli-contract.md` are not fully implemented yet (`--home`, `--log-level`, `--timeout-ms`, `--no-color`, and broader `--profile` handling).
- **`create` contract parity** is incomplete; options such as `--env`, `--term`, `--name`, `--shell`, `--idle-timeout-ms`, and initial render-profile selection are not implemented yet.
- **`type` and `paste` machine-first input forms** are incomplete; the richer `--text` / `--file` shapes from the design doc are not implemented yet.
- **Cursor-position waits** (`wait --cursor-row` / `--cursor-col`) are not implemented yet.
- **Recommended exit-code discipline** from the CLI design doc is not implemented yet; most command failures still exit with code `1`.

## Artifact fidelity and metadata

- **Scrollback snapshots** are not implemented yet; snapshots are still viewport-scoped.
- **Per-cell style metadata** is not implemented yet.
- **Screenshot metadata** does not yet include the full design-level surface (for example render-profile hash, renderer backend, pixel width/height, and consistently exposed SHA256 on screenshot results).
- **Bundled deterministic font assets** are not implemented yet; the shipped reference profiles still rely on generic `monospace`.
- **Full replay timing controls** are not fully exposed yet; video export ships a practical accelerated path, but not the complete timing surface envisioned in the design.

## Failure semantics and recovery

- **Session lifecycle states** do not yet expose the richer `failed`, `destroying`, and `destroyed` states from the architecture doc.
- **Stale-host reconciliation** currently collapses to `exited`; it does not yet distinguish host crash from normal child exit.
- **Crash-recovery proof** is stronger for post-exit retention than for explicit host-crash or renderer-crash recovery semantics.

## Fixture suite and dogfooding

- **`unicode-grid` fixture** is not implemented yet.
- **`scrollback-demo` fixture** is not implemented yet.
- **Full scenario coverage** from `05-dogfooding-and-validation.md` is not yet represented by polished proof bundles.
- **Local proof-bundle review helper/page** is not implemented yet.

## Platform and future-scope work

- **Native renderer adapters** are not implemented yet.
- **Mouse input support** is not implemented yet.
- **Remote/network sessions** are not implemented yet.
- **MCP wrapper** is not implemented yet.
- **Cross-platform rendering parity** is not guaranteed yet, and Windows remains behind the design’s intended tier-2 shape.
- **Renderer CSP trade-off** still exists; the localhost-only ghostty-web harness still needs `unsafe-inline` / `unsafe-eval` today.

## Recommended next step

The next milestone should focus on design parity rather than a brand-new feature area:

1. CLI contract alignment,
2. artifact fidelity and metadata,
3. failure-state / recovery hardening,
4. missing fixtures and dogfood bundles,
5. docs sync.

See `design/20260319_agent-terminal-v1/09-week-4-plan.md` for the proposed Week 4 plan.
