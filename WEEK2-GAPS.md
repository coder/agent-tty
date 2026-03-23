# Remaining gaps after Week 5

> Historical note: this file keeps its original filename (`WEEK2-GAPS.md`) because earlier design docs and proof bundles already reference it. Its contents now describe the current post-Week-5 delta rather than the original Week 2-only gap list.

Week 1 control-plane work, Week 2 renderer-backed inspection, Week 3 export / retention, and the core Week 4 CLI / artifact / lifecycle hardening have all landed. Week 5 began with foundational scaffolding for config schema/loading, CLI context extensions (`logLevel`, `profileDefault`), `ReplayTimingModeSchema`, and unit coverage; follow-on commits have since wired most of that behavior end to end. The remaining work is now concentrated in the areas below.

## Post-Week-5 remaining gaps

### CLI contract and config parity

- **`--log-level`** — **Shipped / closed:** root `--log-level` resolves through `src/cli/context.ts`, creates a stderr logger in `src/util/logger.ts`, and is consumed by commands plus the renderer backend (`src/cli/main.ts`, `src/renderer/ghosttyWeb/backend.ts`; `bf0e745`).
- **Global render-profile selection** — **Shipped / closed:** root `--profile` now feeds `context.profileDefault`, and renderer-backed commands consume it in `src/cli/commands/screenshot.ts` and `src/cli/commands/record-export.ts` (`88ad2e7`).
- **`--idle-timeout-ms`** — **Shipped / closed:** `create` forwards and persists the value in `src/cli/main.ts` and `src/cli/commands/create.ts`, and the host enforces it at runtime in `src/host/hostMain.ts` (`7b56d8e`).
- **`--append-newline`** — **Shipped / closed:** `type` registers `--append-newline` in `src/cli/main.ts` and appends `\n` in `src/cli/commands/type.ts` (`6545146`).
- **Config-file loading** — **Shipped / closed:** `src/config/resolveConfig.ts` loads and validates `config.json`, `src/cli/context.ts` applies flag > env > config precedence for `logLevel` / `profileDefault`, and `src/cli/commands/create.ts` consumes `configFile?.idleTimeoutMs`.
- **Full envelope/result-shape parity** — **Future scope / not started:** parity with every CLI-contract example is still incomplete.

### Artifact fidelity and metadata

- **Per-cell style metadata** — **Shipped / closed:** `src/protocol/schemas.ts` now defines styled `SnapshotCell` entries (`fg`, `bg`, `bold`, `italic`, `underline`, `strikethrough`), and `src/cli/commands/snapshot.ts` can request them with `--include-cells` (`ea40a28`).
- **The fuller `SnapshotCell` / expanded snapshot schema** — **Shipped / closed:** structured snapshots now optionally emit `cells` via `StructuredSnapshotResultSchema`, with RPC and offline replay coverage in `test/unit/commands/snapshot.test.ts` (`ea40a28`).
- **Bundled deterministic font assets** — **Shipped / closed:** `src/renderer/bundledFont.ts` bundles `JetBrainsMono-Regular-latin.woff2`, and built-in profiles in `src/renderer/profiles.ts` use the bundled font instead of generic `monospace`.
- **Full replay timing controls** — **Shipped / closed:** `record export --timing <mode>` is wired in `src/cli/main.ts` and `src/cli/commands/record-export.ts`, and supports `recorded`, `accelerated`, and `max-speed` end to end.

### Failure semantics and recovery

- **Renderer/host recovery proof** — **Shipped / closed:** dedicated recovery coverage now exists for renderer restart recovery, stale host reconciliation, and offline replay fidelity (`d8eb54e`, `9799a52`, `b0e16b8`; see `test/integration/lifecycle.test.ts` and the `dogfood/20260323-week5-recovery-*` bundles).
- **Broader failure storytelling** — **Future scope:** the repo records `failed` plus `failureReason`, but richer distinctions between abnormal child exit, host failure, and renderer failure remain unfinished.

### Fixture suite and dogfooding

- **Local proof-bundle review helper/page** — **Shipped / closed:** `src/tools/review-bundle.ts` ships a standalone review helper, with dedicated coverage in `test/unit/tools/review-bundle.test.ts` and proof in `dogfood/20260323-week5-review-helper/`.

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

The next milestone should focus on the genuinely unfinished post-Week-5 delta rather than re-opening areas that have already shipped:

1. finish full CLI envelope/result-shape parity,
2. deepen failure semantics/storytelling beyond the current recovery proofs,
3. then continue broader native/platform future work (native renderers, mouse input, remote sessions, MCP),
4. then harden cross-platform rendering parity and renderer CSP constraints.

See `design/20260319_agent-terminal-v1/10-week-4-status.md` for the detailed Week 4 status record, `design/20260319_agent-terminal-v1/11-week-5-plan.md` for the Week 5 execution plan, and `design/20260319_agent-terminal-v1/12-week-5-status.md` for the detailed Week 5 status record.
