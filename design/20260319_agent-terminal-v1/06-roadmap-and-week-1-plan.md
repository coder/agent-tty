# agent-terminal v1 roadmap and week 1 plan

This document turns the design set into an execution plan that a small team can actually work from.

It is intentionally biased toward:

- a thin vertical slice first,
- clear team boundaries,
- proof-heavy validation,
- and getting to a usable dogfood loop early.

## Status update (2026-03-21)

Week 1 is complete and has been superseded by a shipped Week 2 renderer-backed slice.

What shipped from the Week 1 plan:

- real session creation, inspection, listing, and teardown,
- a background host process per session,
- PTY spawn and output capture,
- input, paste, key, resize, and signal control,
- append-only event logging,
- `wait --exit` and `wait --idle-ms`,
- deterministic fixture coverage,
- and terminal-only proof bundles.

Week 2 then added renderer-backed snapshots, waits, screenshots, artifact manifests, and browser smoke checks. The Week 1 plan below is preserved as the original execution record, but its outcome and sign-off checklists should now be read as **completed history** rather than future work.

## 1. Current baseline in this repository

As of this draft, the repository already contains a narrow Phase 0 scaffold:

- `package.json` has the intended core stack already declared: TypeScript, Commander, `node-pty`, `ghostty-web`, Playwright, Zod, and ULID.
- `src/cli/main.ts` exposes `version` and `doctor`.
- `src/protocol/envelope.ts` and `src/cli/output.ts` provide the JSON envelope path.
- `src/cli/commands/version.ts` and `src/cli/commands/doctor.ts` are working examples of command wiring.
- `test/integration/cli.test.ts` and the unit tests cover the current command scaffold.

Important gaps are still open:

- there is no `host/` implementation yet,
- there is no `pty/` adapter yet,
- there is no `storage/` or `config/` layer yet,
- there is no renderer harness yet,
- and there are no fixture apps yet.

## 2. Recommended implementation strategy

I would not try to build every command one by one in command-list order.

Instead, I would build four stacked capabilities:

1. **Session foundation** — storage, IDs, host bootstrap, PTY ownership, lifecycle.
2. **Interactive control** — input, resize, signals, and append-only event log.
3. **Inspectable state** — lazy renderer, semantic snapshots, waits, screenshots.
4. **Review artifacts and hardening** — replay export, doctor, GC, fixtures, CI, proof bundles.

That keeps the implementation aligned with the design docs:

- the architecture doc makes the session host and event log foundational,
- the CLI contract expects stable machine-readable behavior from day one,
- the rendering doc treats screenshots and video as replay products rather than direct PTY side effects,
- and the dogfooding doc requires screenshots and videos as proof artifacts before calling the work done.

## 3. Delivery phases

## Phase A — finish Phase 0 and land the session skeleton

### Goal

Close the remaining scaffold gaps and create the minimum real session system.

### Scope

- add `config/`, `storage/`, and `host/` module roots,
- add sortable session ID generation,
- add home/session path helpers,
- add session metadata read/write helpers,
- add structured error catalog and exit-code mapping,
- add internal `_host` entrypoint wiring,
- implement `create`, `list`, `inspect`, and `destroy`.

### Definition of done

- `create` allocates a session directory and starts a background host,
- `list` enumerates sessions,
- `inspect` returns persisted plus live state,
- `destroy` tears a session down cleanly,
- and exited or stale sessions are still explainable.

### Why this first

Nothing else is stable until session ownership is real.

## Phase B — interactive control and canonical event log

### Goal

Make sessions useful for actual automation and establish replay truth.

### Scope

- implement `type`, `paste`, `send-keys`, `resize`, and `signal`,
- append every meaningful action to `event-log.jsonl`,
- enforce monotonic sequence numbers,
- record PTY output and child exit events,
- support wait modes that do not require a renderer yet, especially `--exit` and `--idle-ms`.

### Definition of done

- a fixture app can be created, typed into, resized, signaled, and destroyed,
- the event log fully explains what happened,
- and event ordering is stable enough to replay later.

### Why this second

This is the narrowest vertical slice that proves the host/PTY model before pulling in Chromium and rendering complexity.

## Phase C — renderer, semantic snapshots, waits, and screenshots

### Goal

Make terminal automation inspectable rather than just scriptable.

### Scope

- add `renderer/backend.ts` and the `ghostty-web` reference adapter,
- lazily boot the browser harness on first render-related command,
- replay the event log into the renderer,
- implement `snapshot`,
- implement renderer-backed `wait --text`, `wait --regex`, and `wait --screen-stable-ms`,
- implement `screenshot` with pinned render profiles,
- store manifest-backed artifacts with hashes.

### Definition of done

- a session can produce a semantic snapshot and a deterministic screenshot,
- the renderer can be restarted and rebuilt from the event log,
- and resize- and redraw-heavy fixtures are reviewable from the generated artifacts alone.

### Why this third

The rendering docs are built around replay-from-log. That only becomes straightforward once lifecycle, control, and event persistence are already solid.

## Phase D — replay export, hardening, fixtures, and final proof

### Goal

Make the product reviewable, operable, and ready for broader team work.

### Scope

- implement `record export --format asciicast` and `--format webm`,
- complete `doctor` and `gc`,
- harden manifest atomicity and stale-session handling,
- build the fixture apps,
- wire end-to-end CI around the fixture flows,
- produce the proof bundles required by `05-dogfooding-and-validation.md`.

### Definition of done

- the minimal PR proof bundle exists,
- CI covers the critical flows,
- and another person can review the behavior from screenshots, videos, notes, and JSON artifacts without rerunning the scenario.

## 4. Suggested team split

A small team can work in parallel after the session skeleton is started.

### Lane 1 — CLI, protocol, config, and storage

Best for someone working on:

- command parsing,
- JSON envelopes,
- Zod validation,
- exit-code discipline,
- config precedence,
- session path helpers,
- manifest schema.

### Lane 2 — host, PTY, lifecycle, and event log

Best for someone working on:

- host bootstrap,
- detached-process behavior,
- PTY ownership,
- live session state,
- request/response control socket,
- event sequencing and persistence.

### Lane 3 — renderer and artifact generation

Best for someone working on:

- Playwright integration,
- `ghostty-web` harness,
- replay application,
- snapshot serialization,
- screenshot capture,
- video export.

### Lane 4 — fixtures, e2e, and dogfooding

Best for someone working on:

- deterministic fixture apps,
- integration and e2e tests,
- artifact bundle layout,
- dogfood scripts,
- reviewer notes templates,
- CI packaging of screenshots and videos.

### Merge points

The main integration seams should be:

- `protocol/` schemas,
- `storage/` session and artifact metadata shapes,
- `host` request handlers,
- `renderer/backend.ts`,
- and fixture command contracts.

## 5. Week 1 plan

Week 1 should aim for a working non-rendered vertical slice with one narrow dogfood loop.

A coding agent working from this section should treat every unchecked item below as incomplete work. Week 1 is done only when every required checkbox in this section is checked.

### Week 1 outcome checklist

- [x] Real session creation and teardown exist.
- [x] A background host process exists and is used for sessions.
- [x] PTY spawn and output capture work.
- [x] `create`, `list`, `inspect`, and `destroy` are implemented.
- [x] `type`, `paste`, `send-keys`, `resize`, and `signal` are implemented.
- [x] Append-only event logging exists.
- [x] `wait --exit` and `wait --idle-ms` are implemented.
- [x] One or two deterministic fixture apps exist.
- [x] A terminal-only proof bundle shows that the control plane works.

Renderer work is a stretch goal for week 1, not the baseline commitment.

### Day 1 — finish the scaffold

#### Implementation checklist

- [ ] Add `config/`, `storage/`, and `host/` directories.
- [ ] Add session ID helpers.
- [ ] Add session/home path helpers.
- [ ] Add error codes and exit-code mapping.
- [ ] Add command stubs for the Phase A and Phase B commands.
- [ ] Define protocol request and response schemas.

#### Checkpoint checklist

- [ ] Command parsing compiles cleanly.
- [ ] Schema validation tests exist and pass.

### Day 2 — session creation path

#### Implementation checklist

- [ ] Implement session allocation.
- [ ] Write `session.json`.
- [ ] Add host spawn/bootstrap.
- [ ] Wire `create` and `list`.
- [ ] Add stale-session detection basics.

#### Checkpoint checklist

- [ ] `create` returns a running session.
- [ ] `list` shows the created session.

### Day 3 — inspection and teardown

#### Implementation checklist

- [ ] Implement `inspect`.
- [ ] Implement `destroy`.
- [ ] Surface host PID, child PID, and exit status.
- [ ] Keep exited sessions inspectable.
- [ ] Reconcile stale host metadata.

#### Checkpoint checklist

- [ ] Create → inspect → destroy works end to end in integration tests.

### Day 4 — event log and interaction controls

#### Implementation checklist

- [ ] Implement PTY output capture.
- [ ] Append `output`, `input_text`, `input_paste`, `input_keys`, `resize`, `signal`, and `exit` events.
- [ ] Implement `type`, `paste`, `send-keys`, `resize`, and `signal`.
- [ ] Add `wait --exit`.
- [ ] Add `wait --idle-ms`.

#### Checkpoint checklist

- [ ] A trivial fixture can be driven through a full interaction cycle.
- [ ] The event log is readable.
- [ ] The event log sequence is monotonic.

### Day 5 — fixtures and first dogfood bundle

#### Implementation checklist

- [ ] Add `hello-prompt` and `resize-demo` fixtures.
- [ ] Add integration tests around the fixtures.
- [ ] Produce a first `dogfood/` bundle.
- [ ] Document known gaps before renderer work starts.

#### Checkpoint checklist

- [ ] Another team member can replay the week 1 story by reading the JSON outputs, event log, notes, terminal screenshots, and interim screen recording.

### Week 1 sign-off checklist

- [x] All required implementation and checkpoint checkboxes above are complete.
- [x] Relevant tests for the implemented week 1 scope pass.
- [ ] The dogfood bundle contains screenshots and a screen recording.
- [x] Remaining gaps are documented explicitly rather than implied.

### Week 1 stretch goals

If the core slice lands early, the best stretch goals are:

- [ ] Add a text-oriented replay path that can support an early snapshot implementation.
- [ ] Prove that lazy `ghostty-web` boot and replay are feasible in this repo.

## 6. Cross-cutting implementation rules

These should apply in every phase.

### Defensive programming

Use fail-fast checks aggressively:

- assert session IDs resolve to exactly one directory,
- assert event `seq` values are strictly increasing,
- assert session state transitions are legal,
- assert manifest writes never point at temp files,
- assert renderer replay catches up to the requested sequence,
- assert JSON payloads pass schema validation before use.

### Thin CLI, fat host

Keep the CLI as translation glue.

The host should own:

- PTY lifecycle,
- event logging,
- session state,
- renderer lifecycle,
- and artifact generation.

### Build the renderer behind an interface

Even before there is a native backend, keep a narrow backend contract so `ghostty-web` does not leak everywhere.

## 7. Validation strategy

Validation should happen in three layers.

### 7.1 Automated tests

At a minimum, each phase should add:

- unit tests for schema and helper logic,
- integration tests for CLI-to-host behavior,
- fixture-backed tests for PTY interaction,
- and later, renderer smoke tests for snapshot, screenshot, `.cast`, and `.webm` generation.

### 7.2 Agent-run dogfooding

For this project, I would use both a terminal workflow and a visual workflow.

#### Terminal workflow

Use the repo terminal to:

- run commands directly with `--json`,
- save outputs into `dogfood/<date>-<scenario>/`,
- inspect `event-log.jsonl`,
- verify session directories and manifests,
- and attach notes describing expected versus observed behavior.

#### Desktop workflow

Use the desktop agent when the change needs visual proof in a real terminal window.

Examples:

- showing `create → inspect → destroy` in a real shell,
- proving resize redraw behavior,
- proving that screenshots or replay videos actually look correct,
- or recording a short end-to-end walk-through for review.

For every interaction-heavy checkpoint, capture:

- at least one screenshot,
- and at least one short video.

#### Browser workflow with `agent-browser`

Once the renderer harness exists, use `agent-browser` for browser-grounded checks such as:

- opening the local `ghostty-web` harness page,
- verifying the pinned render profile loads correctly,
- confirming the browser sandbox stays local-only,
- inspecting generated screenshot/video outputs in a lightweight review page if we add one,
- and catching visual regressions that are easier to inspect in a browser than in raw JSON.

For week 1, `agent-browser` is optional. From the first renderer milestone onward, it becomes part of normal validation.

### 7.3 Human review

There are a few checkpoints where I would explicitly ask for your review instead of guessing:

1. **First deterministic screenshot pass** — verify that colors, cursor visibility, and text clarity are acceptable.
2. **First replay video pass** — verify that the video is actually useful for human review and not just technically present.
3. **Unicode and width handling** — verify whether the rendered result is acceptable for your expectations.
4. **Cross-platform caveats** — if you can run on a target OS that differs from mine, a quick smoke check is valuable.

If we are unsure whether an artifact is good enough for reviewers, that is a human-judgment question and we should ask you directly.

## 8. Review artifact expectations

Each meaningful milestone should leave behind a proof bundle under `dogfood/` that includes:

- JSON outputs from the commands under test,
- the event log when relevant,
- screenshots,
- videos,
- and a short `notes.md` file.

The bundle should be reviewable offline by someone who did not run the commands.

## 9. Recommended immediate next step

If we start implementation now, I would begin by finishing the missing Phase 0/Phase A scaffolding and then drive one vertical slice through:

- `create`
- `list`
- `inspect`
- `destroy`
- `hello-prompt` fixture
- week 1 dogfood bundle

That gives the team a stable foundation to parallelize around without dragging renderer complexity into day 1.
