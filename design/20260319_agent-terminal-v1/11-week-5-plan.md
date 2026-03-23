# agent-terminal v1 week 5 plan

This plan assumes that:

- Week 1 control-plane work is complete,
- Week 2 renderer-backed inspection work is complete,
- Week 3 export / crash-retention / GC work is complete,
- and Week 4 CLI / artifact / lifecycle hardening is complete enough that the remaining delta is now concentrated in a smaller parity-and-proof surface.

Week 5 is therefore not about opening a new feature family.

Week 5 is about closing the most important remaining gap between the **broader v1 design contract** and the **shipped repository** so the project can credibly call the core v1 design materially complete.

## Status update (2026-03-23)

Week 5 landed foundational scaffolding (configuration infrastructure, CLI context extensions, protocol schema additions) and completed the platform/documentation closeout (Workstream D). The remaining workstreams (A end-to-end wiring, B rendering fidelity, C review tooling) remain future scope. See [12-week-5-status.md](./12-week-5-status.md) for the detailed outcome.

This document is the follow-on execution plan created from the current post-Week-4 gap list in [`../WEEK2-GAPS.md`](../WEEK2-GAPS.md), the Week 4 status record, and the broader v1 design docs.

As work lands, this file should be updated in place the same way the earlier weekly plan/status docs were kept in sync:

- mark completed checklist items,
- narrow or remove no-longer-valid scope,
- and add a short status note near the top when a workstream materially lands.

## Week 5 goal

Bring the repository close enough to the full v1 design contract that the remaining work is mostly future-scope platform expansion rather than unfinished parity or reviewability work.

That means Week 5 should focus on:

1. closing the remaining high-value CLI/config parity gaps,
2. closing the highest-value rendering fidelity gaps,
3. making proof bundles easier to review locally,
4. strengthening explicit failure/recovery validation,
5. and tightening platform/documentation closeout around the intended v1 support model.

## Week 5 outcome checklist

Week 5 is done only when every required checkbox below is complete.

- [ ] The highest-value CLI/config parity gaps from `02-cli-contract.md` are closed.
- [ ] Rendering fidelity is materially closer to `03-rendering-and-artifacts.md`.
- [ ] Reviewer-facing replay timing controls are exposed and documented.
- [ ] A local proof-bundle review helper/page exists.
- [ ] Failure/recovery behavior is better proven with dedicated proof bundles.
- [ ] Linux and macOS validation expectations are reflected in CI or explicitly documented if still deferred.
- [ ] Windows tier-2 status is explicitly documented.
- [ ] The stale design/status docs have been updated to match the Week 5 outcome.

## Scope boundaries

### In scope

- remaining CLI/config parity work,
- rendering-fidelity improvements that materially affect reviewability,
- reviewer-facing replay/export option improvements,
- local proof-bundle review tooling,
- failure/recovery validation and proof,
- and platform/documentation closeout for the current v1 support model.

### Explicitly out of scope

These are still valid future work items, but they should not dilute Week 5:

- native renderer adapters,
- mouse input,
- remote/network sessions,
- MCP wrapper,
- inline graphics parity,
- and broad cross-platform rendering parity work beyond the current support-status and smoke/CI story.

## Workstream A — CLI/config parity

### Goal

Close the remaining high-value contract gaps between the shipped CLI and `02-cli-contract.md`.

### Deliverables

- add a global `--log-level` surface with a minimal but real logging story,
- add a true global `--profile` override surface for render-related commands,
- implement config-file loading and document flag/env/config/default precedence,
- add `create --idle-timeout-ms`,
- add `type --append-newline`,
- and improve the highest-value result shapes where the shipped envelopes still materially lag the contract examples.

### Acceptance criteria

- automation callers can rely on an actual CLI/env/config precedence story,
- render-related commands honor a shared profile default unless explicitly overridden,
- `create --idle-timeout-ms` and `type --append-newline` are exposed and tested,
- and the biggest CLI-contract example mismatches are either closed or explicitly documented as future work.

## Workstream B — rendering fidelity and reviewer-facing export controls

### Goal

Close the highest-value fidelity gaps that still make screenshot/snapshot/video review less reproducible than the design intends.

### Deliverables

- bundled deterministic font assets for the reference renderer,
- a richer snapshot surface that moves toward the fuller schema in `03-rendering-and-artifacts.md`,
- optional per-cell styling data where practical,
- screenshot cursor-visibility control if the renderer can support it cleanly,
- and reviewer-facing replay timing controls for WebM export instead of only a hard-coded accelerated mode.

### Acceptance criteria

- reference screenshots are less dependent on host `monospace` behavior,
- snapshots can expose richer review data than line-oriented text alone,
- video export timing behavior is selectable and documented,
- and rendering metadata remains deterministic and test-covered.

## Workstream C — local review tooling and failure/recovery proof

### Goal

Make the proof story easier to consume locally while strengthening the recovery claims that are still lighter than the rest of the shipped evidence.

### Deliverables

- a local proof-bundle review helper/page that can summarize bundle contents and link artifacts,
- a dedicated renderer-restart/rebuild proof path,
- a dedicated stale-host / host-rebuild proof path,
- clearer documentation and notes around child-failure vs host-failure vs renderer-failure semantics,
- and refreshed proof bundles that demonstrate the new review flow.

### Acceptance criteria

- a reviewer can open a local bundle and navigate the important artifacts without manual directory spelunking,
- renderer or host recovery claims are demonstrated by dedicated proof bundles rather than inferred from adjacent tests,
- and the failure/recovery story is clearer in both docs and machine-facing outputs.

## Workstream D — platform and documentation closeout

### Goal

Tighten the repo’s support-story documentation so it matches the v1 design’s Linux/macOS tier-1 and Windows tier-2 intent.

### Deliverables

- add macOS validation to CI or explicitly document why it remains deferred,
- add an explicit Windows/ConPTY status note describing current caveats,
- update the top-level design entrypoint and linked status docs so they describe the post-Week-5 reality,
- and ensure the remaining future-scope work is clearly separated from the core v1 parity work.

### Acceptance criteria

- Linux/macOS expectations are reflected in repo automation or in explicit documented deferrals,
- Windows support status is understandable without reading multiple historical docs,
- and the main design entrypoint no longer points readers only at the Week 4 delta.

## Dogfooding and validation

Week 5 must keep the same proof-heavy bar as the earlier plans.

### Required dogfood principle

For any change that affects config resolution, CLI result shapes, rendering fidelity, replay timing, proof-bundle review, recovery semantics, or platform support guidance, the implementation should produce:

- JSON command outputs,
- screenshots,
- `.cast` artifacts where relevant,
- `.webm` artifacts where relevant,
- and short written notes.

### Required Week 5 proof bundles

At a minimum, Week 5 should leave behind bundles covering:

1. **CLI/config precedence scenario**
   - prove flag/env/config/default precedence, `--log-level`, `--profile`, `--idle-timeout-ms`, and `--append-newline` behavior.
2. **Rendering fidelity scenario**
   - prove bundled-font rendering, richer snapshot data, and any cursor-visibility or timing-mode behavior.
3. **Recovery scenario**
   - prove renderer restart/rebuild and host-recovery semantics using dedicated evidence.
4. **Bundle-review scenario**
   - prove the new local review helper/page can open and summarize a real bundle.
5. **Platform/status scenario**
   - leave behind the screenshots, notes, and CI evidence needed to justify the Linux/macOS/Windows support statements.

### Screenshot and video requirements

Week 5 should continue the design rule that screenshots and videos are mandatory proof artifacts for interaction-heavy changes.

For every proof bundle above, capture:

- at least one screenshot,
- at least one `.cast` or equivalent textual replay artifact where relevant,
- and at least one short `.webm` recording when the behavior is easier to verify visually than semantically.

## Quality gates between workstreams

Do not move on from a workstream until:

- the new tests for that workstream pass,
- the related proof bundle exists,
- screenshots and video/recording artifacts exist where required,
- and any intentionally deferred follow-ups are written down explicitly.

## Recommended implementation order

Implement Week 5 in this order:

1. docs/scope framing and platform closeout plan,
2. CLI/config parity,
3. rendering fidelity and replay timing controls,
4. local review tooling,
5. failure/recovery proof refresh.

That order keeps the contract work and proof tooling aligned so the later bundles validate the final intended workflow rather than an intermediate one.

## Definition of done

Week 5 should be considered complete only when:

- the remaining post-Week-4 parity gap is materially smaller,
- the repo’s proof bundles are easier to review locally,
- the current platform support story is explicit and credible,
- the docs accurately describe the shipped implementation,
- and a reviewer can inspect the updated proof bundles offline and understand both the shipped v1 contract and the intentionally deferred future-scope work.
