# agent-terminal v1 week 7 plan

This plan assumes that:

- Week 1 control-plane work is complete,
- Week 2 renderer-backed inspection work is complete,
- Week 3 export / crash-retention / GC work is complete,
- Week 4 CLI / artifact / lifecycle hardening is complete,
- Week 5 config/rendering/platform closeout is complete,
- and Week 6 closed the highest-value `inspect` / `version` / artifact-health / failure-taxonomy code gaps.

Week 7 is therefore not about opening a new product surface.

Week 7 is about ratifying the shipped v1 surface so the docs, examples, JSON envelopes, and proof bundles all tell the same story before the repo moves on to intentionally future-scope platform/runtime expansion.

## Status update (2026-03-25)

This Week 7 plan now reflects the full landed Phase 1–5 contract-closeout sequence plus the follow-up review-hardening pass:

- **Phase 1 — contract audit and doc ratification:** the high-value examples in `02-cli-contract.md` now match the shipped CLI syntax/result shapes for `create`, `list`, `type`, `paste`, `send-keys`, `snapshot`, `screenshot`, `resize`, and `destroy`.
- **Phase 2 — targeted code/schema alignment:** the shipped `send-keys` result now exposes `accepted`, `bytesWritten`, and `seq`, and the shipped `destroy` result now exposes `{ sessionId, destroyed }`.
- **Phase 3 — golden-envelope expansion:** `test/unit/commands/golden-envelopes.test.ts` now covers 10 command surfaces with valid/invalid/extra-field locks for the representative public JSON contracts.
- **Phase 4 — proof bundles and review normalization:** four Week 7 proof bundles now exist with generated review pages, and the browser-verification pass added reviewer screenshots for those pages.
- **Phase 5 — design/doc synchronization:** the CLI contract doc is ratified, the Week 7 proof/docs set is in sync, and the gap-tracker/status docs now describe the same shipped surface.
- **Review hardening:** defensive copies, type import alignment, error-path tests, and tightened assertions landed in follow-up commits, bringing the suite to 510 tests total.

The main open Week 7 carry-over is now only the lower-priority "should lock if time permits" surfaces (`gc`, `record export`, and `doctor`) plus broader platform/runtime work tracked separately in [`../WEEK2-GAPS.md`](../WEEK2-GAPS.md).

See [14-week-6-status.md](./14-week-6-status.md), [02-cli-contract.md](./02-cli-contract.md), [`../WEEK2-GAPS.md`](../WEEK2-GAPS.md), and this file for the current execution focus.

As work lands, this file should be updated in place the same way the earlier weekly plan/status docs were kept in sync:

- mark completed checklist items,
- narrow or remove no-longer-valid scope,
- add a short status note near the top when a workstream materially lands,
- and keep proof-bundle paths current as evidence is generated.

## Week 7 goal

Ratify the public v1 contract and the reviewer proof story so the remaining post-Week-7 delta is clearly intentional future-scope platform/runtime expansion, not ambiguity about what the current CLI actually promises.

That means Week 7 should focus on:

1. closing or explicitly ratifying the remaining CLI syntax/result-shape mismatches,
2. locking the chosen public envelopes/examples down with tests,
3. normalizing proof bundles so they match the review process described in the design docs,
4. reconciling the docs and gap tracker with that ratified surface,
5. and only then leaving the remaining work as clearly future-scope runtime/platform expansion.

## Week 7 outcome checklist

Week 7 is done only when every required checkbox below is complete.

- [x] Every high-value example in `02-cli-contract.md` is either implemented as written or explicitly annotated as historical / aspirational / future scope.
- [x] The remaining syntax/result-shape mismatches for `create`, `list`, `type`, `paste`, `send-keys`, `snapshot`, `screenshot`, and `destroy` are closed or explicitly ratified.
- [x] Golden-envelope or equivalent contract tests cover the representative public JSON surfaces most likely to drift.
- [x] The Week 6 proof bundles, and any critical carried-forward Week 4/5 proof gaps, meet the documented review-bundle minimum or the docs are explicitly updated to describe the lighter accepted standard.
- [x] The top-level design entrypoint, validation docs, Week 6 status record, and gap tracker all describe the same current reality.
- [ ] The remaining post-Week-7 gap is clearly future-scope platform/runtime work rather than unfinished contract or proof closure.

## Scope boundaries

### In scope

- full CLI example/contract audit,
- targeted CLI or result-shape changes where the shipped surface should match the docs,
- explicit doc ratification where the shipped surface is the better contract,
- `list` / `send-keys` / representative envelope improvements if they materially close the remaining public-surface gaps,
- proof-bundle completeness and review-surface normalization,
- bundle-format validation or linting if it helps keep the proof bar honest,
- and design/code synchronization.

### Explicitly out of scope

These remain valid future work items, but they should not dilute Week 7:

- native renderer adapters,
- mouse input,
- remote/network sessions,
- MCP wrapper,
- broad Windows/native parity work,
- runtime renderer capability discovery beyond the current static backend list,
- larger event-log redesign work,
- the fuller snapshot-schema redesign beyond what is required to ratify the current public contract,
- and renderer CSP hardening beyond documenting the current trade-off.

## Workstream A — public CLI contract audit and ratification

**Status (2026-03-25): Completed for the high-value shipped examples.** The contract audit is done, and the Week 7 doc pass now ratifies the shipped `create`, `list`, `type`, `paste`, `send-keys`, `snapshot`, `screenshot`, `resize`, and `destroy` surfaces instead of leaving silent mismatches in the docs.

### Goal

Make the public CLI examples and the shipped command surface tell the same truth.

### Deliverables

- audit every command example and key result-shape example in `02-cli-contract.md` against the actual CLI in `src/cli/main.ts` and the emitted schemas/results,
- decide case-by-case whether to:
  - change the implementation to match the doc, or
  - ratify the shipped behavior by updating the doc,
- explicitly resolve the currently verified mismatches around:
  - `create` syntax/result shape,
  - `list` summary fields and ordering language,
  - `type` / `paste` `--text` examples,
  - `send-keys` echoed/canonicalized result expectations,
  - `snapshot` `--scope` / `--lines` / `--out`,
  - `screenshot` `--out` / cursor flags,
  - and `destroy --purge`,
- and annotate any remaining broader examples that are intentionally aspirational rather than shipped contract.

### Acceptance criteria

- a contributor can execute or inspect the documented high-value examples without discovering silent mismatches,
- automation-facing docs no longer imply flags or result fields that do not exist,
- and any intentionally broader examples are clearly labeled as future scope instead of looking like shipped behavior.

## Workstream B — contract locks and representative JSON coverage

**Status (2026-03-25): Complete.** `19a7223` expanded the golden-envelope suite across 10 representative command surfaces, and follow-up hardening in `652f657` and `061df44` aligned result-type imports, hardened send-keys handling with defensive copies, and tightened the contract/error-path assertions.

### Goal

Prevent the ratified contract from drifting again.

### Deliverables

- expand golden-envelope or equivalent contract tests beyond the current `inspect`, `version`, and representative error coverage,
- cover the most drift-prone surfaces after the audit, especially `create`, `list`, `send-keys`, `wait`, `snapshot`, `screenshot`, `record export`, `destroy`, `gc`, and `doctor` where practical,
- define the canonical expected shape for `list` and `send-keys` if those surfaces are enriched,
- and fail loudly when public JSON envelopes or documented semantics change without an intentional contract update.

### Acceptance criteria

- representative public JSON outputs are locked down by tests rather than only by prose,
- the remaining intentionally-unlocked surfaces are explicitly documented,
- and reviewers can tell whether a change is a real contract change or just an internal refactor.

## Workstream C — proof-bundle completeness and review normalization

**Status (2026-03-25): Complete.** The four Week 7 proof bundles are checked in, their review pages have been regenerated, and the browser-verification pass in `4fe94b3` added reviewer screenshots for the generated review surfaces.

### Goal

Bring the checked-in proof bundles back in line with the validation doc's stated review bar.

### Deliverables

- audit the Week 4–6 bundles against `05-dogfooding-and-validation.md`,
- decide and document the minimum acceptable bundle shape for:
  - contract-only scenarios,
  - renderer/review scenarios,
  - and recovery/failure scenarios,
- backfill or refresh the high-value Week 6 bundles so the committed evidence matches the accepted standard,
- ensure `review-bundle` output is part of the committed proof story for the targeted bundles,
- and add lightweight validation (script, test, or checklist) so future bundles cannot quietly regress to JSON-only evidence when screenshots/videos/review pages are required.

### Acceptance criteria

- the Week 6 proof bundles are reviewable without guesswork about what evidence should exist,
- screenshots, recordings, videos, and generated review pages are present wherever the accepted bundle standard says they must be,
- and the docs stop overstating proof completeness where the repo does not actually ship the artifacts.

## Workstream D — design and gap-tracker synchronization

**Status (2026-03-25): Complete.** The top-level design entrypoint, CLI contract doc, validation/proof docs, and Week 7 status sync now describe the same shipped reality, and Workstream C's bundle/browser pass closed the last proof-tracking dependency.

### Goal

Make the design set read truthfully from the top down.

### Deliverables

- update the top-level design entrypoint so it points at Week 7 as the current execution plan,
- update any stale status sections that still describe Week 4 or Week 5 gaps as if they were current,
- correct Week 6 documentation so it matches the checked-in Week 6 bundles and their actual limitations,
- keep `WEEK2-GAPS.md` aligned with the ratified Week 7 scope,
- and make the remaining future-scope items easy to distinguish from Week 7 carry-over work.

### Acceptance criteria

- a new contributor can read the top-level design docs and understand what is shipped, what is Week 7 carry-over, and what is intentionally future scope,
- no status doc still points readers at an obsolete current milestone,
- and the gap tracker no longer implies that proof/contract ratification is already finished if it is not.

## Dogfooding and validation

Week 7 must keep the same proof-heavy bar as the earlier plans, but it must also fix the places where the repository drifted away from that bar.

### Required dogfood principle

For any change that affects public CLI syntax, JSON envelopes, proof-bundle structure, review pages, or the docs that promise those behaviors, the implementation should produce:

- JSON command outputs,
- generated `review-bundle` output,
- screenshots,
- `.cast` or equivalent textual replay artifacts where relevant,
- `.webm` artifacts where relevant,
- and short written notes describing expected versus observed behavior.

### Required Week 7 dogfood setup

Because this is a CLI project, Week 7 dogfooding should run against an isolated absolute `AGENT_TERMINAL_HOME` and use direct CLI invocation.

At a minimum, the Week 7 proof workflow should document a setup equivalent to:

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

If Week 7 adds a bundle-validator command/script, run that as part of the proof workflow too.

### Required Week 7 proof bundles

At a minimum, Week 7 should leave behind bundles covering:

1. **CLI example parity scenario**
   - prove the ratified `create`, `list`, `type`, `paste`, `send-keys`, `wait`, `snapshot`, `screenshot`, and `destroy` surfaces against the final docs.
2. **Representative envelope-lock scenario**
   - prove the public JSON outputs that are now locked by golden tests and show the committed examples/review page for them.
3. **Proof-bundle completeness scenario**
   - prove the accepted minimum bundle format and any new validator/checker against a real bundle.
4. **Review-surface normalization scenario**
   - prove the generated review pages and refreshed Week 6 bundles are understandable offline.

### Screenshot and video requirements

Week 7 should continue the design rule that screenshots and videos are mandatory proof artifacts for interaction-heavy or reviewer-facing changes.

For every proof bundle above, capture:

- at least one screenshot,
- at least one `.cast` or equivalent textual replay artifact where relevant,
- and at least one short `.webm` recording when the behavior is easier to verify visually than semantically.

Contract-only scenarios should still capture screenshots of terminal outputs or the generated review page rather than leaving behind JSON alone.

## Quality gates between workstreams

Do not move on from a workstream until:

- the new tests for that workstream pass,
- the related proof bundle exists,
- screenshots and video/recording artifacts exist where required,
- the docs for that surface are updated in the same change,
- and any intentionally deferred follow-ups are written down explicitly.

## Recommended implementation order

Implement Week 7 in this order:

1. contract inventory and mismatch audit,
2. ratify or close the highest-value CLI syntax/result-shape gaps,
3. lock the chosen envelopes/examples with tests,
4. normalize the Week 6 proof bundles and review surfaces,
5. finish top-level doc/gap-tracker synchronization.

That order keeps the public contract, test locks, and proof evidence aligned so the final docs describe the same surface that the repository actually ships.

## Definition of done

Week 7 should be considered complete only when:

- the public v1 contract is truthful enough that examples, CLI help, emitted JSON, and tests no longer contradict each other on the high-value surfaces,
- the review bundle story is concrete enough that a reviewer can inspect the targeted Week 6/7 evidence offline without directory spelunking or missing-artifact guesswork,
- the docs accurately describe the shipped implementation and the actual remaining gaps,
- and the remaining delta is clearly future-scope platform/runtime expansion rather than unresolved contract or proof ambiguity.
