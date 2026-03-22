# agent-terminal v1 week 2 plan

This document extends the Week 1 plan with a concrete Week 2 execution plan.

It is intentionally biased toward:

- turning the Week 1 control plane into an inspectable system,
- landing one renderer-backed vertical slice before broader export work,
- preserving deterministic proof artifacts,
- and leaving behind evidence that a reviewer can verify offline.

## Status update (2026-03-22)

Week 2 landed as the first renderer-backed inspection slice.

Implemented in the Week 2 milestone:

- deterministic event-log replay into a lazy `ghostty-web` renderer,
- `snapshot` and `snapshot --format text`,
- renderer-backed `wait --text`, `wait --regex`, and `wait --screen-stable-ms`,
- deterministic `screenshot` with `reference-dark` and `reference-light`,
- artifact tracking via `artifacts/manifest.json`,
- renderer/browser/screenshot checks in `doctor`,
- and renderer-focused proof bundles under `dogfood/`.

At the time Week 2 closed, the following were still intentionally deferred:

- asciicast export,
- replay video export,
- native renderer adapters,
- mouse input,
- and remote/network session support.

As of 2026-03-22, later Week 3 work has since landed:

- `record export --format asciicast`,
- `record export --format webm`,
- `gc`,
- and crash-retention / post-exit proof bundles under `dogfood/20260321-week3-*`.

The remaining sections below are preserved as the original implementation plan. Any unchecked export/video items should now be read as historical Week 2 scope boundaries rather than current repository gaps.

## 1. Baseline entering Week 2

Week 2 should assume the Week 1 control-plane slice is already real:

- session lifecycle exists,
- a background host process owns each PTY session,
- input, resize, signal, and exit flows work,
- append-only event logging exists,
- `wait --exit` and `wait --idle-ms` exist,
- and the `hello-prompt` and `resize-demo` fixtures already prove the non-rendered path.

Week 2 should **not** start by reworking the PTY lifecycle unless a concrete replay blocker appears.

The main goal now is to add the first renderer-backed inspection path:

1. replay the event log into a reference renderer,
2. expose semantic screen state,
3. support renderer-backed waits,
4. capture deterministic screenshots,
5. and prove those behaviors with screenshots, notes, and short videos.

## 2. Week 2 goal

Week 2 should deliver the first inspectable renderer slice of `agent-terminal`.

At the end of Week 2, an agent should be able to:

- create a session,
- interact with it,
- ask for a semantic snapshot,
- wait for visible text or visible stability,
- capture a deterministic PNG screenshot,
- and leave behind a proof bundle that includes JSON outputs, screenshots, and a short video.

Week 2 is **not** the right time to chase native backends, mouse injection, remote control, or full replay export. Those remain later work.

## 3. Week 2 outcome checklist

Week 2 is done only when every required checkbox below is complete.

- [x] The event-log replay path is strong enough to rebuild visible screen state deterministically.
- [x] A renderer module root exists behind a narrow backend interface.
- [x] A lazy `ghostty-web` renderer harness exists.
- [x] `snapshot` is implemented for at least viewport-scoped JSON output.
- [x] `snapshot --format text` is implemented.
- [x] `wait --text` is implemented.
- [x] `wait --regex` is implemented.
- [x] `wait --screen-stable-ms` is implemented.
- [x] `screenshot` is implemented.
- [x] Built-in render profiles exist for `reference-dark` and `reference-light`.
- [x] Snapshot and screenshot artifacts are linked to the replayed event sequence.
- [x] A basic artifact manifest exists for snapshot and screenshot outputs.
- [x] `doctor` verifies browser / renderer / screenshot viability at least at a smoke-test level.
- [ ] At least one renderer-focused dogfood bundle exists with JSON outputs, snapshots, screenshots, notes, and a short video.
- [ ] The carried-forward Week 1 proof gap is closed by adding a real screen recording / video artifact to the control-plane proof story.

## 4. Scope boundaries for Week 2

### In scope

- replay correctness needed for renderer-backed inspection,
- renderer adapter interface,
- `ghostty-web` harness boot and replay,
- semantic snapshots,
- renderer-backed wait modes,
- deterministic screenshots,
- render profiles,
- snapshot / screenshot manifest entries,
- and proof bundles with screenshots and videos.

### Explicitly out of scope

- `record export --format asciicast`,
- `record export --format webm`,
- native renderer adapters,
- mouse input,
- remote hosts,
- MCP wrappers,
- and cross-platform parity polishing beyond basic smoke coverage.

Those are important, but they should not dilute the Week 2 renderer slice.

## 5. Recommended implementation strategy

I would build Week 2 in four stacked pieces:

1. **Replay foundation** — ensure the event log contains enough information and sequencing discipline for deterministic renderer catch-up.
2. **Renderer harness** — add the backend interface, the lazy browser boot path, and profile resolution.
3. **Semantic inspection** — implement `snapshot` and renderer-backed `wait` modes.
4. **Visual proof** — implement `screenshot`, manifest entries, `doctor` smoke checks, and the first renderer-focused proof bundles.

That sequence keeps the implementation aligned with the broader design docs:

- the architecture doc makes replay and lazy renderer startup foundational,
- the rendering doc treats semantic and visual artifacts as replay products,
- the CLI contract requires machine-usable outputs,
- and the dogfooding doc requires screenshots and videos as evidence rather than unsupported textual claims.

## 6. Day-by-day plan

### Day 1 — replay foundation and renderer contracts

### Implementation checklist

- [ ] Add `src/renderer/` module roots.
- [ ] Add a narrow `renderer/backend.ts` contract.
- [ ] Add replay input and replay state types shared by host and renderer code.
- [ ] Audit the event log against replay needs and document any missing fields or invariants.
- [ ] Tighten replay-critical assertions around event ordering and terminal dimensions.
- [ ] Add sequence bookkeeping so render-related operations can ask for “replay through latest seq”.
- [ ] Define render-profile types and the initial built-in profile registry.

### Checkpoint checklist

- [ ] A renderer backend can be constructed from a replay input shape even if the browser harness is still stubbed.
- [ ] Event ordering assumptions are asserted explicitly rather than implied.
- [ ] Unit tests cover any new replay or profile schemas.

### Dogfooding gate

Use the existing control-plane path and produce a brief engineering note proving that the replay input can be derived from a real Week 1 session.

Required artifacts:

- [ ] one saved event log from a real session,
- [ ] one small notes file describing how replay state is derived,
- [ ] one screenshot of the terminal command flow that produced the sample session,
- [ ] one short terminal video showing the sample create → interact → inspect flow.

### Day 2 — lazy renderer harness and profile boot

### Implementation checklist

- [ ] Add the `ghostty-web` harness under `src/renderer/ghosttyWeb/`.
- [ ] Add browser bootstrap code for a local-only harness.
- [ ] Implement lazy renderer startup on the first render-related request.
- [ ] Add `reference-dark` and `reference-light` built-in profiles.
- [ ] Pin deterministic visual defaults needed for Week 2 screenshots.
- [ ] Add host-side renderer lifecycle wiring so the renderer can be created, reused, and disposed.
- [ ] Add one restart path so a failed renderer can be re-created from the event log.

### Checkpoint checklist

- [ ] First renderer-related command starts the browser harness lazily.
- [ ] The harness can replay a real session through the latest sequence number.
- [ ] Profile lookup succeeds for both built-in profiles and fails clearly for invalid names.

### Dogfooding gate

Run a narrow harness smoke test against a real session.

Required artifacts:

- [ ] one screenshot of the local renderer harness page or equivalent visible proof,
- [ ] one short video showing the renderer boot path,
- [ ] one notes file confirming that the harness stayed local-only and did not require external navigation,
- [ ] one JSON artifact or debug dump showing the renderer replayed through the expected sequence number.

### Day 3 — semantic snapshots and renderer-backed waits

### Implementation checklist

- [ ] Implement `snapshot`.
- [ ] Support viewport-scoped JSON output first.
- [ ] Add `snapshot --format text`.
- [ ] Implement `wait --text`.
- [ ] Implement `wait --regex`.
- [ ] Implement `wait --screen-stable-ms`.
- [ ] Return machine-usable metadata linking snapshots and waits to capture sequence and visible-screen summary.
- [ ] Add structured errors for renderer startup and replay failures.

### Checkpoint checklist

- [ ] `snapshot` returns cursor, rows/cols, alt-screen flag if available, and visible lines.
- [ ] `snapshot --format text` is materially lighter-weight than the structured form.
- [ ] `wait --text` and `wait --regex` operate on visible rendered state rather than raw event-log string matching.
- [ ] `wait --screen-stable-ms` is based on visible-screen stability rather than PTY idleness.
- [ ] Integration tests cover both match and timeout cases.

### Dogfooding gate

Use a fixture that visibly transitions from `Loading` to `Ready`, or add one if needed.

Required artifacts:

- [ ] one snapshot JSON captured during `Loading`,
- [ ] one snapshot JSON captured during `Ready`,
- [ ] one text-format snapshot,
- [ ] one screenshot at the matched `Ready` state,
- [ ] one short video showing the wait condition resolving at the correct moment,
- [ ] notes describing whether the snapshot, wait result, and screenshot all tell the same story.

### Day 4 — deterministic screenshots and artifact manifest

### Implementation checklist

- [ ] Implement `screenshot`.
- [ ] Capture deterministic PNGs from the reference renderer.
- [ ] Record screenshot metadata including profile, captured sequence, and dimensions.
- [ ] Add basic manifest entries for `snapshot` and `screenshot` artifacts.
- [ ] Ensure artifact paths are stable and written atomically.
- [ ] Add failure handling for invalid render profiles and failed browser capture.
- [ ] Teach `doctor` to verify browser availability, renderer startup, and screenshot viability at a smoke-test level.

### Checkpoint checklist

- [ ] The same session state under the same profile yields stable screenshot dimensions.
- [ ] Screenshots are clearly linked to the replayed sequence number.
- [ ] `reference-dark` and `reference-light` both work.
- [ ] `doctor` reports renderer-related failures structurally.
- [ ] Tests cover screenshot creation and at least one `doctor` failure path.

### Dogfooding gate

Use `resize-demo` and `color-grid` style scenarios.

Required artifacts:

- [ ] one `reference-dark` screenshot,
- [ ] one `reference-light` screenshot,
- [ ] one resize-before screenshot,
- [ ] one resize-after screenshot,
- [ ] one short resize video,
- [ ] one notes file calling out clipping, wrapping, cursor, or palette issues if any are observed,
- [ ] one manifest excerpt or saved manifest file showing the screenshot entries.

### Day 5 — renderer proof bundles and CI smoke coverage

### Implementation checklist

- [ ] Produce the first renderer-focused proof bundle under `dogfood/`.
- [ ] Add or refine fixture coverage for renderer-backed waits and screenshots.
- [ ] Add CI smoke coverage for the renderer-backed snapshot / screenshot path where practical.
- [ ] Document known gaps that remain after Week 2.
- [ ] Close the carried-forward Week 1 artifact gap by attaching a real screen recording / video to the control-plane proof story.

### Checkpoint checklist

- [ ] Another team member can review the Week 2 renderer story from the proof bundle alone.
- [ ] The proof bundle contains JSON outputs, snapshots, screenshots, notes, and at least one short video.
- [ ] Known gaps are written down explicitly instead of being implied.

### Dogfooding gate

Produce at least one complete renderer-focused scenario bundle.

Required artifacts:

- [ ] `create` / `inspect` / `wait` / `snapshot` / `screenshot` JSON outputs,
- [ ] snapshot files,
- [ ] screenshot files,
- [ ] notes,
- [ ] one short screen recording or replay video for the interaction,
- [ ] and one bundle manifest that makes the scenario reviewable offline.

## Implementation notes from the shipped Week 2 slice

A few implementation details differed slightly from the original plan and are worth recording here:

- The shipped renderer harness lives in `src/renderer/ghosttyWeb/backend.ts` plus `harness.html`, rather than being split across separate browser/harness/semantics modules.
- Replay preparation stayed host-owned via `buildReplayInput()` and the host-side `EventLog` buffer, which keeps the CLI thin and the renderer interface narrow.
- Artifact storage is centralized under `artifacts/` with deterministic filenames like `snapshot-<seq>-<format>.json` and `screenshot-<seq>-<profile>.png` plus `artifacts/manifest.json`.
- Post-implementation hardening added response validation at the CLI boundary, event-buffer/runtime guards, replay batching, and regex safety checks.

## 7. Week 2 sign-off checklist

- [x] All required implementation and checkpoint checkboxes above are complete for the shipped snapshot / screenshot / renderer-wait slice.
- [x] Relevant tests for the implemented Week 2 scope pass.
- [ ] Renderer-backed proof bundles contain screenshots and at least one short video.
- [x] `doctor` covers renderer smoke checks rather than only baseline environment checks.
- [x] The remaining gaps after Week 2 are documented explicitly.

## 8. Week 2 stretch goals

If the core Week 2 slice lands early, the best stretch goals are:

- [ ] add `wait --cursor-row/--cursor-col`,
- [ ] add scrollback-scoped snapshot support,
- [ ] add a more explicit renderer-crash recovery test,
- [ ] add a proof-of-feasibility spike for `.cast` export from the existing event log,
- [ ] add a minimal review page or helper for browsing proof bundles locally.

Stretch goals should not block Week 2 sign-off.

## 9. Cross-cutting implementation rules for Week 2

### Replay before polish

Do not over-invest in screenshot polish until replay correctness is strong enough that the renderer can reliably rebuild the latest state from the event log.

### Thin CLI, fat host, narrow renderer interface

The CLI should remain translation glue.

The host should continue to own:

- replay preparation,
- renderer lifecycle,
- capture sequencing,
- and artifact coordination.

The renderer implementation should stay behind a narrow interface so later native backends do not force a CLI redesign.

### Defensive programming

Keep using fail-fast checks aggressively:

- [ ] assert replay sequence ordering,
- [ ] assert render-profile lookup success,
- [ ] assert snapshot metadata matches the replayed sequence,
- [ ] assert screenshot metadata includes the profile used,
- [ ] assert manifest writes never point at temp files,
- [ ] assert browser harness requests stay local-only.

## 10. Validation strategy for Week 2

Validation should happen in three layers.

### 10.1 Automated tests

At a minimum, Week 2 should add:

- [ ] unit tests for replay/profile/schema logic,
- [ ] integration tests for renderer-backed `wait` and `snapshot`,
- [ ] screenshot smoke tests,
- [ ] `doctor` renderer smoke tests,
- [ ] and a renderer restart / rebuild test if practical.

### 10.2 Terminal workflow

Use the repo terminal to:

- [ ] run Week 2 commands with `--json`,
- [ ] save outputs into `dogfood/<date>-<scenario>/`,
- [ ] inspect manifest files,
- [ ] inspect snapshot contents,
- [ ] and compare notes against the actual artifacts.

### 10.3 Visual workflows

#### Desktop workflow

Use the desktop agent or an equivalent visual workflow whenever the claim requires human-visible proof.

Examples:

- [ ] showing that `wait --text` matched the intended screen,
- [ ] proving that screenshots are visually sane,
- [ ] proving resize redraw behavior under the renderer,
- [ ] or recording a short walkthrough for review.

For every interaction-heavy checkpoint, capture:

- [ ] at least one screenshot,
- [ ] and at least one short video.

#### Browser workflow with `agent-browser`

Use `agent-browser` or an equivalent browser-grounded tool for:

- [ ] verifying the local `ghostty-web` harness loads correctly,
- [ ] checking pinned render profiles,
- [ ] verifying the harness remains local-only,
- [ ] and reviewing screenshot outputs when that is easier in a browser context than through raw JSON.

## 11. Recommended immediate next step

If implementation starts now, I would begin with the Day 1 replay-contract work and land the narrowest possible renderer-backed slice through:

- `renderer/backend.ts`,
- lazy `ghostty-web` boot,
- `snapshot`,
- `wait --text`,
- `screenshot`,
- and one renderer-focused dogfood bundle.

That gives the team a usable inspectability milestone before moving on to replay export, GC, or broader hardening.
