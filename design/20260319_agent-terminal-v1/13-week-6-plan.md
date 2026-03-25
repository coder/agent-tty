# agent-terminal v1 week 6 plan

This plan assumes that:

- Week 1 control-plane work is complete,
- Week 2 renderer-backed inspection work is complete,
- Week 3 export / crash-retention / GC work is complete,
- Week 4 CLI / artifact / lifecycle hardening is complete,
- and Week 5 closed the highest-value config, rendering-fidelity, proof-bundle-review, and platform/documentation gaps.

Week 6 is therefore not about opening a new product surface.

Week 6 is about closing the remaining high-value gap between the **broader v1 design contract** and the **shipped repository** so follow-on work can focus on intentionally future-scope platform/runtime expansion rather than lingering contract ambiguity.

## Status update (2026-03-25)

This Week 6 plan was created after a repo/design audit on 2026-03-25.

That audit found that the Week 1–5 plan and status docs are materially reflected in the current repository. The remaining delta is now concentrated in:

- full CLI envelope/result-shape parity for the highest-value public surfaces,
- richer session/artifact introspection,
- clearer failure taxonomy and reporting,
- and design/code reconciliation where the broader docs still describe richer or different structures than the shipped implementation.

See [12-week-5-status.md](./12-week-5-status.md), [`../WEEK2-GAPS.md`](../WEEK2-GAPS.md), and this file for the current execution focus.

As work lands, this file should be updated in place the same way the earlier weekly plan/status docs were kept in sync:

- mark completed checklist items,
- narrow or remove no-longer-valid scope,
- add a short status note near the top when a workstream materially lands,
- and keep proof-bundle paths current as evidence is generated.

## Week 6 goal

Make the repository credibly design-aligned for the core v1 surface by closing the remaining contract, introspection, and reporting gaps that still separate the shipped implementation from the broader design docs.

That means Week 6 should focus on:

1. closing the highest-value CLI contract/result-shape gaps,
2. making session and artifact health easier to inspect,
3. making failure categories and recovery reporting clearer,
4. reconciling the general design docs with the shipped model,
5. and locking the resulting contract down with tests and proof bundles.

## Week 6 outcome checklist

Week 6 is done only when every required checkbox below is complete.

- [ ] The highest-value CLI envelope/result-shape gaps from `02-cli-contract.md` are closed or explicitly ratified as future scope.
- [ ] `inspect` and `version` expose the missing high-value review data.
- [ ] Artifact health is visible without manual filesystem spelunking.
- [ ] Failure categories and recovery reporting are clearer and better proven.
- [ ] The main design docs no longer describe stale or mismatched contract/event/snapshot expectations as if they are already shipped requirements.
- [ ] The required Week 6 proof bundles exist with JSON outputs, screenshots, notes, `.cast`, and `.webm` artifacts where relevant.
- [ ] The remaining post-Week-6 gap is clearly future-scope platform/runtime work rather than unfinished contract closure.

## Scope boundaries

### In scope

- CLI contract/result-shape parity work,
- `inspect` / `version` / `doctor` contract and introspection improvements,
- artifact-health reporting,
- failure taxonomy and recovery reporting,
- design/code synchronization for contract, event-log, snapshot, and artifact expectations,
- contract/golden tests,
- and refreshed proof bundles.

### Explicitly out of scope

These remain valid future work items, but they should not dilute Week 6:

- native renderer adapters,
- mouse input,
- remote/network sessions,
- MCP wrapper,
- broad Windows/native parity work,
- renderer CSP hardening beyond documenting the current trade-off,
- and other new feature families that are not required to close the remaining v1 contract ambiguity.

## Workstream A — CLI contract and result-shape parity

### Goal

Close the highest-value remaining mismatches between the shipped CLI and `02-cli-contract.md`.

### Deliverables

- enrich `inspect` to expose the most important missing fields where practical and stable,
- make `version --json` report the compiled-in renderer backend surface instead of an empty placeholder,
- audit the public command envelopes/examples and close the highest-value result-shape gaps,
- either align the structured error catalog/exit-code story more closely with the contract or explicitly document the intentionally shipped catalog,
- and add golden or snapshot-style contract tests for the public JSON envelopes most likely to drift.

### Acceptance criteria

- automation callers can rely on `inspect`, `version`, and the error/exit story being materially closer to the contract doc,
- the remaining example mismatches are small and explicitly documented,
- and contract tests fail loudly when machine-facing envelopes drift.

## Workstream B — session and artifact introspection

### Goal

Make session state and artifact health inspectable without manual directory inspection.

### Deliverables

- add artifact counts and artifact summaries to `inspect`,
- surface missing-on-disk artifacts and manifest inconsistencies in `inspect` and/or `doctor`,
- expose the most useful replay/session summary fields that are currently absent from the public surface,
- and tighten proof-bundle metadata or summaries where that materially improves offline review.

### Acceptance criteria

- a reviewer can understand whether a session is healthy, failed, exited, destroyed, or missing expected artifacts from CLI JSON alone,
- missing-artifact cases are caught by tests and surfaced in human/JSON outputs,
- and updated proof bundles do not require manual artifact-manifest spelunking to answer basic health questions.

## Workstream C — failure taxonomy and recovery reporting

### Goal

Make abnormal child exit, host failure, renderer failure, and replay fallback easier to distinguish.

### Deliverables

- define a clearer failure taxonomy and reflect it in machine-facing outputs where practical,
- preserve the current `failed` / `failureReason` model but make failure origin clearer and more stable,
- ensure recovery/fallback paths (renderer restart, host unreachable -> offline replay, stale-host reconcile) produce clearer evidence,
- and add targeted tests and proof bundles for each high-value failure class.

### Acceptance criteria

- abnormal child exit, host death, renderer rebuild/restart, and replay fallback can be distinguished by automation or a reviewer,
- docs and proof bundles use the same language as the implementation,
- and failure-related outputs remain explicit, stable, and test-covered.

## Workstream D — design/code reconciliation

### Goal

Remove the remaining shipped-vs-designed ambiguity in the docs.

### Deliverables

- update the main design entrypoint so it reflects the post-Week-5 reality and points to Week 6 as the current execution plan,
- reconcile `01-architecture.md`, `02-cli-contract.md`, and `03-rendering-and-artifacts.md` with the shipped implementation where they currently describe richer or different structures than the code actually emits,
- decide explicitly whether the remaining event-log and snapshot-schema deltas should be implemented now or reclassified as future scope,
- and keep `WEEK2-GAPS.md` plus the Week 6 docs current as work lands.

### Acceptance criteria

- a new contributor can read the top-level design docs without being misled about what is already shipped,
- remaining future-scope items are clearly separated from Week 6 contract-closure work,
- and historical docs still preserve context without obscuring current reality.

## Dogfooding and validation

Week 6 must keep the same proof-heavy bar as the earlier plans.

### Required dogfood principle

For any change that affects CLI result shapes, session/artifact reporting, failure semantics, recovery evidence, or design-truth surfaces, the implementation should produce:

- JSON command outputs,
- screenshots,
- `.cast` artifacts where relevant,
- `.webm` artifacts where relevant,
- generated `review-bundle` output where relevant,
- and short written notes describing expected versus observed behavior.

### Required Week 6 dogfood setup

Because this is a CLI project, Week 6 dogfooding should run against an isolated absolute `AGENT_TERMINAL_HOME` and use direct CLI invocation.

At a minimum, the Week 6 proof workflow should document a setup equivalent to:

```sh
mise install
npm ci
npx playwright install chromium
npm run build

export AGENT_TERMINAL_HOME="$(mktemp -d)"
npx tsx src/cli/main.ts doctor --json
```

When a proof bundle is generated, also run:

```sh
npm run review-bundle -- <bundle-dir>
```

and capture screenshots of the generated `index.html` plus a short video recording whenever the new behavior is easier to verify visually than by reading JSON alone.

### Required Week 6 proof bundles

At a minimum, Week 6 should leave behind bundles covering:

1. **CLI contract parity scenario**
   - prove richer `inspect`, improved `version --json`, representative error envelopes, and the updated exit-code/error story.
2. **Artifact-health scenario**
   - prove artifact counts, missing-artifact detection, and manifest/report alignment.
3. **Failure taxonomy scenario**
   - prove abnormal child exit, stale host reconciliation, renderer/offline-replay fallback, and the updated reporting language.
4. **Review-surface scenario**
   - prove the refreshed bundles and `review-bundle` output make the new summaries understandable offline.

### Screenshot and video requirements

Week 6 should continue the design rule that screenshots and videos are mandatory proof artifacts for interaction-heavy or reviewer-facing changes.

For every proof bundle above, capture:

- at least one screenshot,
- at least one `.cast` or equivalent textual replay artifact where relevant,
- and at least one short `.webm` recording when the behavior is easier to verify visually than semantically.

Contract-only scenarios should still capture screenshots of the generated review page or terminal outputs rather than leaving behind JSON alone.

## Quality gates between workstreams

Do not move on from a workstream until:

- the new tests for that workstream pass,
- the related proof bundle exists,
- screenshots and video/recording artifacts exist where required,
- and any intentionally deferred follow-ups are written down explicitly.

## Recommended implementation order

Implement Week 6 in this order:

1. docs/scope framing and contract inventory,
2. `inspect` / `version` / envelope/result-shape parity,
3. artifact-health reporting,
4. failure taxonomy and recovery reporting,
5. final design/doc reconciliation and proof-bundle refresh.

That order keeps the contract changes, proof surfaces, and docs aligned so the later bundles validate the final intended workflow rather than an intermediate one.

## Definition of done

Week 6 should be considered complete only when:

- the remaining post-Week-5 contract gap is materially smaller,
- the public inspection/reporting surface answers the highest-value reviewer and automation questions directly,
- the docs accurately describe the shipped implementation,
- proof bundles and contract tests make regressions obvious,
- and the remaining delta is clearly future-scope platform/runtime expansion rather than unfinished v1 contract closure.
