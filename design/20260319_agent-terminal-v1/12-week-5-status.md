# agent-terminal v1 week 5 status

This document records the repository's actual Week 5 outcome after the plan in [11-week-5-plan.md](./11-week-5-plan.md).

Week 5 began the next round of parity work. The initial landing was mostly scaffolding, but follow-on fixes have since wired most of that planned CLI/config/rendering/review scope end to end. This file now separates what has shipped from the smaller set of genuinely unfinished future work.

## Status update (2026-03-23)

Week 5 started with foundational scaffolding; by 2026-03-23, the repo has since closed most of those gaps.

The remaining future scope is now concentrated in native/platform/runtime expansion rather than the original CLI/config plumbing.

## What shipped in Week 5

- Configuration infrastructure shipped and is now wired through command resolution: `src/config/resolveConfig.ts` loads/validates `config.json`, `src/cli/context.ts` applies flag > env > config precedence, and `src/cli/commands/create.ts` consumes configured idle timeouts.
- End-to-end CLI/config wiring landed for `--log-level`, root `--profile`, `--idle-timeout-ms`, and `--append-newline` (`src/cli/main.ts`, `src/cli/context.ts`, `src/cli/commands/create.ts`, `src/cli/commands/type.ts`).
- Replay timing mode shipped end to end: `ReplayTimingModeSchema` plus `record export --timing <mode>` for `recorded`, `accelerated`, and `max-speed` (`src/protocol/schemas.ts`, `src/cli/commands/record-export.ts`).
- Rendering fidelity improvements shipped: bundled JetBrains Mono assets in `src/renderer/bundledFont.ts`, built-in profiles switched to the bundled font in `src/renderer/profiles.ts`, and renderer-backed commands respect profile defaults.
- Snapshot fidelity improvements shipped: `snapshot --include-cells` now emits optional per-cell data through `SnapshotCellSchema` / `StructuredSnapshotResultSchema` (`src/protocol/schemas.ts`, `src/cli/commands/snapshot.ts`; `ea40a28`).
- Local proof-bundle review tooling shipped as `src/tools/review-bundle.ts`, with dedicated coverage in `test/unit/tools/review-bundle.test.ts` and proof in `dogfood/20260323-week5-review-helper/`.
- Dedicated recovery proof coverage shipped for renderer restart recovery, stale host recovery, and offline replay fidelity (`d8eb54e`, `9799a52`, `b0e16b8`; see `dogfood/20260323-week5-recovery-*/`).
- Unit test coverage for the Week 5 additions landed alongside the shipped features.
- macOS CI validation added (separate `quality-gates-macos` job).
- Platform support documentation (README, design docs, gap tracker).
- Week 5 status and proof-bundle documentation.

## What did NOT fully land in Week 5 (future scope)

- Native renderer adapters
- Mouse input support
- Remote/network sessions
- MCP wrapper
- Cross-platform rendering parity, especially Windows/Tier-2 fidelity
- Renderer CSP hardening for the localhost ghostty-web harness
- Full result-shape parity with every CLI-contract example
- Broader failure taxonomy/storytelling beyond the current recovery proofs

## Week 5 outcome by workstream

- WS-A (CLI/config parity): Completed — `--log-level`, `--profile`, `--idle-timeout-ms`, `--append-newline`, and config precedence are wired end to end.
- WS-B (Rendering fidelity): Completed for the planned Week 5 scope — replay timing CLI wiring, bundled fonts, profile-default rendering, and per-cell snapshots all landed; longer-term native renderer/parity/CSP work remains future scope.
- WS-C (Local review tooling): Completed — the `review-bundle` helper shipped with tests and dogfood proof.
- WS-D (Platform/docs closeout): Completed — macOS CI, platform tiers documented, design docs updated.

## Platform support status

- Linux: Tier-1, CI-tested (`ubuntu-latest`)
- macOS: Tier-1, CI-tested (`macos-latest`)
- Windows: Tier-2, not CI-tested, ConPTY-based

## Proof bundles

- `dogfood/20260323-week5-platform-closure/` — platform/documentation closeout evidence
- `dogfood/20260323-week5-recovery-host/`, `dogfood/20260323-week5-recovery-renderer/`, `dogfood/20260323-week5-recovery-replay/` — dedicated recovery proofs
- `dogfood/20260323-week5-render-fonts/`, `dogfood/20260323-week5-render-timing/`, `dogfood/20260323-week5-render-cells/` — rendering fidelity proofs
- `dogfood/20260323-week5-review-helper/` — local proof-bundle review helper proof

## What remains for future work

- The post-Week-5 delta is now concentrated in native renderer work, broader failure semantics, cross-platform parity, and related platform/runtime hardening rather than foundational CLI/config wiring.
- See `WEEK2-GAPS.md` for the detailed remaining gap list.
