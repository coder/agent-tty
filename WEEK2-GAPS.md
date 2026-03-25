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

## Remaining gaps after the Week 6 closeout audit

The items below remain intentionally unfinished or only partially closed. The first section is Week 7 carry-over work that still affects contract truth or proof review. The later sections remain broader future scope.

### Week 7 carry-over work

- **Full CLI example parity / contract ratification** — **Carry-over:** the highest-value `inspect`, `version`, and error envelopes are now covered, but several examples in `02-cli-contract.md` still differ from the shipped CLI syntax or result shapes. Verified mismatches include `create`, `list`, `type`, `paste`, `send-keys`, `snapshot`, `screenshot`, and `destroy`.
- **Proof-bundle completeness / review normalization** — **Carry-over:** dedicated Week 6 bundles now exist under `dogfood/20260325-week6-*`, but proof completeness remains inconsistent. Some bundles rely mostly on JSON/log evidence, none currently ship committed `.cast` or `.webm` artifacts, and only the Week 6 bundle set currently checks in generated `index.html` review pages.

### Remaining broader contract/design parity work

- **Full result-shape parity with every CLI-contract example** — **Future scope beyond the Week 7 audit:** Week 7 should resolve or annotate the high-value mismatches, but the design set may still keep some broader/richer examples aspirational unless the repo intentionally implements them.
- **Runtime renderer capability discovery** — **Future scope:** `version --json` currently reports the static compiled-in backend list `['ghostty-web']`; it does not yet discover capabilities dynamically at runtime.
- **Richer live renderer-state reporting in `inspect`** — **Future scope:** the shipped `inspect` surface now reports artifact health and termination categories, but it does not expose a larger live renderer-state block.
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

The next milestone should not reopen the shipped Week 6 code work, but it also should not skip straight to native/runtime expansion. It should first execute the Week 7 contract/proof closeout:

1. audit and ratify the remaining CLI example/syntax/result-shape mismatches,
2. decide which mismatches should be implemented versus explicitly documented as intentional shipped behavior,
3. normalize the high-value proof bundles and review pages so the validation docs tell the truth,
4. then continue broader future-scope work (native renderers, mouse input, remote sessions, MCP, larger data-model redesigns, platform parity, and renderer CSP hardening).

See `design/20260319_agent-terminal-v1/14-week-6-status.md` for the corrected Week 6 status record and `design/20260319_agent-terminal-v1/15-week-7-plan.md` for the current next-step plan.
