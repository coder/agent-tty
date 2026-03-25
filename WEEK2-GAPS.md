# Remaining gaps after Week 6

> Historical note: this file keeps its original filename (`WEEK2-GAPS.md`) because earlier design docs and proof bundles already reference it. Its contents now describe the current post-Week-6 delta rather than the original Week 2-only gap list.

Week 1 control-plane work, Week 2 renderer-backed inspection, Week 3 export / retention, Week 4 CLI / artifact / lifecycle hardening, Week 5 config/rendering/platform closeout, and the Week 6 contract/introspection/failure-taxonomy reconciliation have all landed. The remaining work is now concentrated in intentionally deferred future scope rather than the high-value Week 6 contract gaps.

## Week 6 closures (now shipped)

### CLI contract and inspection surfaces

- **`inspect` result-shape enrichment** — **Shipped / closed:** `src/cli/commands/inspect.ts` now emits `lastEventSeq`, derived `terminationCategory`, computed `artifacts`, and `usedOfflineReplay`, with schema support in `src/protocol/messages.ts` and contract coverage in `test/unit/commands/inspect.test.ts` plus `test/unit/commands/golden-envelopes.test.ts` (`9b14ed2`, `387fc2e`).
- **`version --json` backend reporting** — **Shipped / closed:** `src/cli/commands/version.ts` now reports `rendererBackends: ['ghostty-web']`, with unit and integration coverage in `test/unit/commands/version.test.ts` and `test/integration/cli.test.ts` (`a4ae0c9`).
- **Golden-envelope contract coverage** — **Shipped / closed:** `test/unit/commands/golden-envelopes.test.ts` now locks the shipped `inspect`, `version`, and representative error envelopes so machine-facing drift fails loudly (`387fc2e`).

### Artifact introspection

- **Artifact-health surfacing** — **Shipped / closed:** `src/storage/artifactHealth.ts` computes total counts, `byKind`, missing-artifact detection, and overall health; `inspect` now exposes that summary directly so reviewers do not need to spelunk `artifacts/manifest.json` by hand (`a8f33cf`, `9b14ed2`).

### Failure semantics and recovery reporting

- **Persisted `failureOrigin` plus derived `terminationCategory`** — **Shipped / closed:** `src/protocol/schemas.ts` now carries structured `failureOrigin` in session state, `src/host/lifecycle.ts` stamps stale-host reconciliation as `host-death`, `src/host/terminationCategory.ts` derives the higher-level termination summary, and `inspect` exposes the result (`9782608`).
- **Broader recovery reporting coverage** — **Shipped / closed for the planned Week 6 scope:** the repo now distinguishes clean exit, non-zero exit, signal exit, host death, renderer failure, destroyed sessions, and offline replay fallback in the public inspection surface and related tests.

### Supporting closeout work

- **Doctor result-shape cleanup** — **Shipped / closed:** `DoctorCheck` now requires `durationMs`, removing an avoidable contract inconsistency (`56276de`).
- **Week 6 design/code reconciliation** — **Shipped / closed:** the Week 6 docs now record the contract/introspection/failure work as shipped status rather than leaving it in the open-gap bucket.

## Remaining future scope after Week 6

The items below remain intentionally unfinished and should not be described as shipped:

### Remaining contract/design parity work

- **Full result-shape parity with every CLI-contract example** — **Future scope:** the highest-value public envelopes are now covered, but this design document still contains broader examples than the exact shipped JSON for every command.
- **Runtime renderer capability discovery** — **Future scope:** `version --json` currently reports the static compiled-in backend list `['ghostty-web']`; it does not yet discover capabilities dynamically at runtime.
- **Broader failure taxonomy beyond the current shipped categories** — **Future scope:** Week 6 made the current categories explicit, but it did not introduce a larger redesign of every possible host/renderer/storage failure class.

### Renderer/runtime expansion

- **Native renderer adapters** — **Future scope / not started:** still not implemented.
- **Mouse input support** — **Future scope / not started:** still not implemented.
- **Remote/network sessions** — **Future scope / not started:** still not implemented.
- **MCP wrapper** — **Future scope / not started:** still not implemented.
- **Cross-platform rendering parity** — **Future scope:** the reference renderer remains the source of deterministic review truth, and Windows/native parity is still behind the design's broader ambition.
- **Renderer CSP hardening** — **Future scope:** the localhost-only `ghostty-web` harness still carries the current CSP trade-off.

### Larger model/data redesigns

- **Full event-log redesign** — **Future scope:** Week 6 did not replace the current append-only event-log model with a broader new format.
- **Full snapshot-schema redesign** — **Future scope:** the shipped snapshot surface is richer than Week 2 but still narrower than the fullest schema described in the design docs.

## Recommended next step

The next milestone should treat Week 6 contract closure as done and focus on the genuinely deferred roadmap items instead of reopening shipped inspection/reporting work:

1. decide whether to pursue full doc/example parity for every remaining command surface or explicitly keep the broader examples as aspirational design,
2. choose which larger future-scope data-model changes (event-log redesign, fuller snapshot schema, broader failure taxonomy) are worth doing before native/runtime expansion,
3. then continue broader platform/runtime work (native renderers, mouse input, remote sessions, MCP),
4. and in parallel harden cross-platform parity and renderer CSP constraints where that work becomes actionable.

See `design/20260319_agent-terminal-v1/12-week-5-status.md` for the Week 5 status record, `design/20260319_agent-terminal-v1/13-week-6-plan.md` for the Week 6 execution plan, and `design/20260319_agent-terminal-v1/14-week-6-status.md` for the Week 6 shipped-status record.
