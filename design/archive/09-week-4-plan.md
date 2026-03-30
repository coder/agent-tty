# agent-terminal v1 week 4 plan

This plan assumes that:

- Week 1 control-plane work is complete,
- Week 2 renderer-backed inspection work is complete,
- and Week 3 export / crash-retention / GC work is complete.

Week 4 is therefore not about introducing a brand-new product surface.

Week 4 is about closing the most important gap between the **shipped implementation** and the **broader v1 design contract**.

## Week 4 goal

Bring the repository materially closer to full v1 design parity.

That means Week 4 should focus on:

1. CLI contract alignment,
2. artifact fidelity and metadata,
3. failure-state and recovery semantics,
4. missing fixture / dogfood coverage,
5. and documentation sync.

## Week 4 outcome checklist

Week 4 is done only when every required checkbox below is complete.

- [ ] The highest-value CLI contract gaps from `02-cli-contract.md` are closed.
- [ ] Snapshot and screenshot artifacts expose richer metadata and fidelity.
- [ ] Failure-state handling is clearer and better proven.
- [ ] The missing fixture scenarios are implemented.
- [ ] The required dogfood bundles exist with screenshots, notes, `.cast`, and `.webm` artifacts.
- [ ] Stale design/status docs have been updated to match reality.

## Scope boundaries

### In scope

- practical CLI contract parity work,
- richer snapshot / screenshot metadata,
- explicit failure and recovery improvements,
- fixture completion,
- proof-bundle completion,
- and design-doc synchronization.

### Explicitly out of scope

These are still valid future work items, but they should not dilute Week 4:

- native renderer adapters,
- mouse input,
- remote/network sessions,
- MCP wrapper,
- and broad cross-platform parity polishing.

## Workstream A — CLI contract alignment

### Goal

Close the highest-value contract gaps between the shipped CLI and `02-cli-contract.md`.

### Deliverables

- support the most important global flags where practical (`--home`, `--timeout-ms`, `--no-color`, and a clearer `--profile` story),
- improve `create` contract parity for the most valuable missing options,
- add file-based input forms for `type` / `paste`,
- add cursor-position render waits,
- and improve exit-code discipline so automation can distinguish common failure modes.

### Acceptance criteria

- automation callers can use the CLI in a way that is materially closer to the contract doc,
- `type` / `paste` can accept both direct text and file input,
- cursor-position waits are exposed and tested,
- and common failure categories produce meaningfully distinct exit codes.

## Workstream B — artifact fidelity and metadata

### Goal

Make the shipped artifacts better match the rendering/artifact design doc.

### Deliverables

- scrollback-aware snapshot support,
- optional richer snapshot metadata for cells/styles,
- fuller screenshot metadata (at minimum backend, width/height, hash, and stronger profile linkage),
- bundled deterministic font assets for reference rendering,
- and a more explicit timing surface for replay video export.

### Acceptance criteria

- snapshots can represent more than just the visible viewport when requested,
- screenshot outputs expose enough metadata for offline review and reproducibility,
- the reference renderer no longer depends on host `monospace` vagaries alone,
- and video export options are documented and test-covered.

## Workstream C — failure semantics and recovery

### Goal

Make failure states easier to reason about and better aligned with the architecture doc.

### Deliverables

- clearer distinction between normal exit, abnormal child exit, and host failure,
- more explicit state modeling where it materially helps users or automation,
- renderer-recovery proof for restart / rebuild from the event log,
- and better tests around stale host and crash scenarios.

### Acceptance criteria

- users can distinguish a stale/crashed host from a normal exited session,
- the event log + manifest story remains the canonical recovery path,
- and at least one dedicated proof path exists for renderer or host recovery semantics.

## Workstream D — fixture suite and dogfooding completion

### Goal

Finish the missing design-level proof surface.

### Deliverables

- `unicode-grid` fixture,
- `scrollback-demo` fixture,
- updated scenario coverage matching the most important gaps in `05-dogfooding-and-validation.md`,
- and polished proof bundles for the highest-risk flows.

### Acceptance criteria

- the missing fixtures exist under `test/fixtures/apps/`,
- each new fixture is used by tests,
- and the proof bundles are reviewable without rerunning the scenario.

## Workstream E — docs and status sync

### Goal

Make the docs tell the truth about the repo's current state.

### Deliverables

- update stale status notes in the main design docs,
- preserve Week 2 as historical context while making Week 3 shipped work explicit,
- and ensure the remaining gaps are documented as Week 4 work rather than still being described as Week 2 omissions.

### Acceptance criteria

- no top-level design/status doc still claims export is unshipped,
- Week 3 has an explicit status record,
- and Week 4 work is recorded in a way a follow-up agent can execute directly.

## Dogfooding and validation

Week 4 must keep the same proof-heavy bar as the earlier plans.

### Required dogfood principle

For any change that affects rendering, replay, crash handling, waits, screenshots, recordings, or exported artifacts, the implementation should produce:

- JSON command outputs,
- screenshots,
- `.cast` artifacts where relevant,
- `.webm` artifacts where relevant,
- and short written notes.

### Required Week 4 proof bundles

At a minimum, Week 4 should leave behind bundles covering:

1. **CLI contract parity scenario**
   - prove the most important new flags/options behave as intended.
2. **Unicode / width scenario**
   - prove alignment and rendering remain inspectable.
3. **Scrollback scenario**
   - prove scrollback-aware snapshot/export behavior.
4. **Failure / recovery scenario**
   - prove the new failure-state / recovery semantics.

### Screenshot and video requirements

Week 4 should continue the design rule that screenshots and videos are mandatory proof artifacts for interaction-heavy changes.

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

Implement Week 4 in this order:

1. docs sync and scope framing,
2. CLI contract alignment,
3. artifact fidelity,
4. failure-state / recovery hardening,
5. fixture and proof-bundle completion.

That order keeps the work reviewable while ensuring the later proof bundles exercise the updated contract and recovery behavior rather than the old ones.

## Definition of done

Week 4 should be considered complete only when:

- the remaining gaps after Week 3 are materially smaller,
- the docs accurately describe the shipped implementation,
- the missing fixture scenarios are in place,
- and a reviewer can inspect the new proof bundles offline and understand both the new behavior and the remaining future-scope work.
