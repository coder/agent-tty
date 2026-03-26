# agent-terminal v1 week 8 plan

This plan assumes that:

- Week 1 control-plane work is complete,
- Week 2 renderer-backed inspection work is complete,
- Week 3 export / crash-retention / GC work is complete,
- Week 4 CLI / artifact / lifecycle hardening is complete,
- Week 5 config/rendering/platform closeout is complete,
- Week 6 contract/introspection/failure-taxonomy reconciliation is complete,
- and Week 7 ratified the high-value public contract, docs, and reviewer proof surfaces.

Week 8 is therefore not about reopening the core v1 contract from scratch.

Week 8 is about making the runtime and proof surface self-describing enough that follow-on work can add native backends, mouse input, and remote/MCP surfaces on top of a stable capability/reporting foundation instead of relying on inference, stale docs, or reviewer guesswork.

## Status update (2026-03-25)

This Week 8 plan was created after a repo/design audit on 2026-03-25.

That audit found that the Week 1–7 plan and status docs are materially reflected in the current repository. The next meaningful gaps are now concentrated in:

- runtime renderer capability discovery beyond the current static `rendererBackends: ['ghostty-web']` report,
- richer live renderer/runtime state in `inspect --json`,
- the intentionally deferred lower-priority public-envelope locks for `doctor`, `gc`, and `record export`,
- and proof-bundle standard enforcement, where the docs describe a stronger preferred minimum than the repo currently validates automatically.

See [15-week-7-plan.md](./15-week-7-plan.md), [05-dogfooding-and-validation.md](./05-dogfooding-and-validation.md), and [`../WEEK2-GAPS.md`](../WEEK2-GAPS.md) for the current context this plan continues from.

As work lands, this file should be updated in place the same way the earlier weekly plan/status docs were kept in sync:

- mark completed checklist items,
- narrow or remove no-longer-valid scope,
- add a short status note near the top when a workstream materially lands,
- and keep proof-bundle paths current as evidence is generated.

## Completion — 2026-03-25

Week 8 is complete at `fe06bb6`. All Week 8 acceptance criteria in this plan are now met.

Week 8 proof evidence is tracked at these bundle paths:

- `dogfood/20260325-week8-capability-inventory/`
- `dogfood/20260325-week8-contract-locks/`
- `dogfood/20260325-week8-bundle-validation/`
- `dogfood/20260325-week8-inspect-runtime/`

Validation for the completed Week 8 surface includes:

- golden-envelope coverage for the ratified JSON/reporting surfaces,
- `npm run validate-bundle -- <bundle-dir>` for the accepted proof-bundle minimums,
- and `npm run review-bundle -- <bundle-dir>` for the generated reviewer pages.

The remaining post-Week-8 roadmap is now clearly future-scope feature work — native backends, mouse input, remote/network sessions, MCP wrapping, and broader data-model redesigns — rather than missing runtime introspection or proof-surface basics.

## Week 8 goal

Make the runtime self-describing and the review bar enforceable so the remaining post-Week-8 delta is clearly new feature families — native renderers, mouse input, remote/MCP transport, and larger data-model redesigns — rather than missing capability introspection or proof-discipline basics.

That means Week 8 should focus on:

1. teaching the runtime to report what renderer/export capabilities are actually available,
2. making `inspect` explain which renderer/replay path was used and how healthy it is,
3. finishing the remaining lower-priority public-envelope locks,
4. turning the proof-bundle minimum into a checked rule rather than prose alone,
5. and only then leaving native/platform expansion as clearly future-scope follow-on work.

## Week 8 outcome checklist

Week 8 is done only when every required checkbox below is complete.

- [x] `version --json` reports runtime-discovered renderer capability and availability data, not only a static backend list.
- [x] `inspect --json` exposes a stable renderer/runtime summary that distinguishes live rendering, offline replay fallback, and renderer unavailability/recovery.
- [x] Golden-envelope or equivalent contract locks exist for `doctor`, `gc`, and `record export`, plus the new Week 8 capability/introspection fields.
- [x] A bundle validator/checker or equivalent repo-enforced rule exists for the accepted proof-bundle minimum.
- [x] The required Week 8 proof bundles exist with JSON outputs, screenshots, generated review pages, notes, and recordings/videos where relevant.
- [x] The remaining post-Week-8 gap is clearly new feature families (native backends, mouse input, remote/network sessions, MCP wrapper, broader data-model redesigns) rather than missing runtime introspection or proof-surface basics.

## Scope boundaries

### In scope

- renderer capability discovery and schema/reporting work,
- richer `version`, `doctor`, and `inspect` runtime/reporting surfaces,
- remaining lower-priority public JSON contract locks,
- bundle validation / bundle-lint enforcement,
- proof-bundle refresh for the targeted Week 8 scenarios,
- and design/code synchronization for those surfaces.

### Explicitly out of scope

These remain valid future work items, but they should not dilute Week 8:

- shipping a full native renderer backend,
- mouse input support,
- remote/network sessions,
- MCP wrapper,
- broad Windows/native rendering parity work beyond diagnostics/documentation,
- full event-log redesign,
- full snapshot-schema redesign,
- and renderer CSP hardening beyond surfacing and ratifying the current localhost-only trade-off.

## Workstream A — runtime capability discovery

### Goal

Teach the runtime to describe what renderer/export capabilities are available **now**, not just what is theoretically compiled in.

### Deliverables

- define a stable capability model/schema for renderer backends and related review/export features,
- report structured capability/availability data from `version --json`,
- align `doctor --json` with the same capability story so environment diagnostics and public version reporting do not drift,
- make capability failures structured (for example, unavailable browser/runtime/backend) rather than forcing automation to infer from error strings,
- and add tests that lock the chosen capability/reporting surface down.

### Acceptance criteria

- automation can tell ahead of time whether snapshot, screenshot, wait, recording export, and video export are available in the current environment,
- unavailable capabilities have structured reasons,
- and the shipped JSON surface is schema-backed and test-locked.

## Workstream B — richer renderer and session introspection

### Goal

Make `inspect` answer the next set of debugging questions without log spelunking.

### Deliverables

- add a renderer/runtime summary block to `inspect --json`,
- expose whether the inspection/render story is live-host-backed or offline-replay-backed,
- surface the active backend, current renderer health/availability, and the most useful replay/render state markers where stable,
- include clearer structured hints when the CLI had to fall back because the host or renderer was unavailable,
- and add targeted tests for running, exited, reconciled-host, and renderer-unavailable paths.

### Acceptance criteria

- a reviewer can tell whether `inspect` reflects a live host or offline replay from JSON alone,
- renderer failures/unavailability are distinguishable from generic session failure,
- and the Week 8 docs, proof bundles, and emitted terms all use the same language for those states.

## Workstream C — remaining public-surface locks

### Goal

Finish the lower-priority contract locks that Week 7 intentionally left behind.

### Deliverables

- add golden-envelope or equivalent strict contract coverage for `doctor`, `gc`, and `record export`,
- lock the new Week 8 capability and inspect-summary blocks in the same test suite or an equivalent public-surface suite,
- audit whether any currently ad hoc fields should be explicitly ratified or intentionally left unlocked,
- and keep the docs honest about which machine-facing surfaces are locked versus illustrative.

### Acceptance criteria

- machine-facing drift in those commands fails loudly in tests,
- the remaining intentionally unlocked surfaces are explicit,
- and reviewers can tell whether a change is a real public-contract change or only an internal refactor.

## Workstream D — bundle validation and review normalization

### Goal

Make the preferred proof-bundle standard enforceable instead of prose-only.

### Deliverables

- add a bundle validator/checker command, script, or test helper that can evaluate the accepted minimum proof-bundle shape,
- define the minimum rules for the targeted Week 8 bundle classes (contract/reporting scenarios versus interactive renderer scenarios),
- prove the validator against at least one conforming bundle and one intentionally incomplete/failing example,
- refresh or add Week 8 bundles so the committed evidence matches the validator's rules,
- and update the validation docs so the accepted minimum is both documented and mechanically checked.

### Acceptance criteria

- contributors can run a repo-supported check and learn whether a targeted bundle is review-complete,
- the repo no longer depends only on prose to protect bundle completeness for the targeted scenarios,
- and reviewers can tell why a bundle passes or fails without reverse-engineering the directory layout.

## Dogfooding and validation

Week 8 must keep the same proof-heavy bar as the earlier plans.

### Required dogfood principle

For any change that affects runtime capability reporting, renderer/runtime introspection, machine-facing JSON envelopes, or proof-bundle validation, the implementation should produce:

- JSON command outputs,
- generated `review-bundle` output,
- screenshots,
- `.cast` or equivalent textual replay artifacts where relevant,
- `.webm` artifacts where relevant,
- and short written notes describing expected versus observed behavior.

### Required Week 8 dogfood setup

Because this is a CLI project, Week 8 dogfooding should run against an isolated absolute `AGENT_TERMINAL_HOME` and use direct CLI invocation.

At a minimum, the Week 8 proof workflow should document a setup equivalent to:

```sh
mise install
npm ci
npx playwright install chromium
npm run build

export AGENT_TERMINAL_HOME="$(mktemp -d)"
npx tsx src/cli/main.ts version --json
npx tsx src/cli/main.ts doctor --json
```

When a proof bundle is generated, also run:

```sh
npm run review-bundle -- <bundle-dir>
npm run validate-bundle -- <bundle-dir>
```

For renderer/replay-heavy bundles, also run:

```sh
npm run validate-bundle -- <bundle-dir> --profile interactive-renderer
```

### Required Week 8 proof bundles

At a minimum, Week 8 should leave behind bundles covering:

1. **Capability inventory scenario**
   - bundle path `dogfood/20260325-week8-capability-inventory/`; proves `version --json` plus `doctor --json` capability reporting on a healthy environment and shows the generated review surface.
2. **Live-vs-offline inspect scenario**
   - bundle path `dogfood/20260325-week8-inspect-runtime/`; proves running-session inspection, exited/offline inspection, and fallback/recovery paths where the renderer or host is unavailable.
3. **Contract-lock scenario**
   - bundle path `dogfood/20260325-week8-contract-locks/`; proves the `doctor`, `gc`, and `record export` envelope locks and shows the resulting reviewer surface.
4. **Bundle-validation scenario**
   - bundle path `dogfood/20260325-week8-bundle-validation/`; proves the validator/checker accepts a conforming bundle and rejects an intentionally incomplete target.

### Screenshot and video requirements

Week 8 should continue the design rule that screenshots and videos are mandatory proof artifacts for interaction-heavy or reviewer-facing changes.

For every proof bundle above, capture:

- at least one screenshot,
- a generated review page,
- and at least one `.cast` or short `.webm` recording whenever the scenario exercises a live terminal interaction rather than only static JSON/reporting.

Contract-only scenarios should still capture screenshots of terminal outputs, test output, or the generated review page rather than leaving behind JSON alone.

## Quality gates between workstreams

Do not move on from a workstream until:

- the new tests for that workstream pass,
- the related proof bundle exists,
- screenshots and video/recording artifacts exist where required,
- the docs for that surface are updated in the same change,
- and any intentionally deferred follow-ups are written down explicitly.

## Recommended implementation order

Implement Week 8 in this order:

1. capability model and `version` / `doctor` reporting,
2. `inspect` renderer/runtime summary and fallback reporting,
3. remaining public-envelope locks,
4. bundle validator/checker plus Week 8 proof bundles,
5. final doc/gap-tracker synchronization.

That order keeps runtime reporting, contract locks, and proof expectations aligned so the resulting Week 8 surface can serve as the stable foundation for later native-backend and platform-expansion work.

## Definition of done

Week 8 should be considered complete only when:

- the runtime can answer what renderer/export capabilities are available and why,
- `inspect` makes the live-host versus offline-replay story obvious,
- the remaining lower-priority public JSON surfaces are locked down,
- the proof-bundle minimum is enforced by repo-supported checks for the targeted scenarios,
- and the remaining delta is clearly future-scope feature expansion rather than missing capability/reporting discipline.
