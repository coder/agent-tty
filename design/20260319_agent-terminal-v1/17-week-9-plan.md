# agent-terminal v1 week 9 plan

This plan assumes that:

- Week 1 control-plane work is complete,
- Week 2 renderer-backed inspection work is complete,
- Week 3 export / crash-retention / GC work is complete,
- Week 4 CLI / artifact / lifecycle hardening is complete,
- Week 5 config/rendering/platform closeout is complete,
- Week 6 contract/introspection/failure-taxonomy reconciliation is complete,
- Week 7 ratified the high-value public contract, docs, and reviewer proof surfaces,
- and Week 8 completed runtime capability reporting, renderer/session introspection, and proof-bundle validation.

Week 9 is therefore not about reopening the v1 architecture or starting a broad new feature family.

Week 9 is about deciding what **must** land before the first `0.1.0` release so that `agent-terminal` is not merely impressive in controlled demos, but reliable enough that an agent can use it for real TUI dogfooding and light day-to-day development work without repeated environment-specific workarounds.

## Status update (2026-03-26)

This Week 9 plan was created after a fresh dogfood pass on the latest `origin/main` on 2026-03-26.

That dogfood pass validated several encouraging facts:

- the current `main` branch can launch isolated sessions, render screenshots, and export recordings,
- a LazyVim + Claude Code scenario is viable on current `main`,
- Nerd Font glyphs now render correctly in the renderer output for the tested scenario,
- and the current runtime is already good enough to function as a TUI verification harness for a real Neovim plugin workflow.

That same pass also exposed the highest-value remaining pre-`0.1.0` rough edges:

- isolated session `HOME` handling still creates renderer/bootstrap sharp edges unless browser asset lookup is explicitly managed,
- there is still no first-class high-level command primitive for “run this shell command robustly inside the session,” forcing long setup flows through fragile keystroke simulation,
- current TUI automation is workable but still too brittle for comfortable iterative plugin development without extra wrapper logic,
- `doctor` and the docs do not yet make TUI prerequisites and isolated-environment caveats obvious enough,
- and there is not yet a clearly ratified release-grade dogfood scenario proving that a complex TUI workflow is stable enough to represent the `0.1.0` ship bar.

The purpose of Week 9 is to turn those findings into a narrow, explicit release-readiness milestone rather than letting them remain scattered as tribal knowledge or ad hoc workarounds.

As work lands, this file should be updated in place the same way the earlier weekly plan/status docs were kept in sync:

- mark completed checklist items,
- narrow or remove no-longer-valid scope,
- add a short status note near the top when a workstream materially lands,
- and keep dogfood bundle paths current as evidence is generated.

## Week 9 goal

Make `agent-terminal` release-ready for `0.1.0` by closing the most important **reliability**, **ergonomics**, and **proof-discipline** gaps revealed by real TUI dogfooding, while intentionally deferring larger future-scope features such as native renderers, mouse input, remote transports, and MCP wrapping.

Concretely, Week 9 should make the answer to the following question comfortably “yes”:

> If an agent or human wants to automate and verify a real TUI workflow — for example launching Neovim, exercising a plugin keymap, checking split-pane rendering, and capturing screenshots/video in an isolated environment — can they do so with the shipped `0.1.0` surface without custom environment surgery, unstable multiline typing tricks, or ambiguous setup guidance?

## Week 9 outcome checklist

Week 9 is done only when every required checkbox below is complete.

- [ ] Isolated session environments do not break renderer-backed screenshot / snapshot / recording workflows, or the required environment contract is handled automatically and test-locked.
- [ ] A first-class high-level shell-command primitive exists for robust in-session command execution, with a ratified JSON surface and targeted tests.
- [ ] `doctor --json` and related docs clearly explain whether the environment is suitable for renderer-backed TUI workflows, including isolated-home scenarios.
- [ ] A release-grade Neovim/LazyVim/Claude Code dogfood scenario exists with screenshots, recordings, review output, and notes proving the intended `0.1.0` TUI bar.
- [ ] The public docs explain the recommended TUI workflow, the role of `type` / `paste` / `send-keys` versus the new command primitive, and the known limitations that remain acceptable for `0.1.0`.
- [ ] The remaining post-Week-9 gap is clearly future-scope product expansion rather than unresolved `0.1.0` reliability or proof-bar ambiguity.

## Scope boundaries

### In scope

- renderer/bootstrap reliability work for isolated session environments,
- a high-level shell command primitive for session setup and automation,
- tighter TUI-focused diagnostics and docs,
- at least one release-grade TUI dogfood bundle that proves the `0.1.0` story,
- contract/schema/test coverage for any new public CLI surface,
- and release-readiness documentation that states what `0.1.0` does and does not promise.

### Explicitly out of scope

These remain valid future work items, but they should not dilute Week 9:

- shipping a native renderer backend,
- mouse input support,
- remote/network sessions,
- MCP wrapping,
- deep editor-specific integrations,
- broad event-log or snapshot model redesign,
- pixel-perfect parity across terminal emulators,
- or turning `agent-terminal` into a full semantic TUI automation framework for all apps.

Week 9 should improve the shipped TUI automation story enough for `0.1.0`, not attempt to solve every future TUI problem before release.

## Workstream A — isolated environment and renderer/bootstrap reliability

### Goal

Ensure that the most important inspection and artifact flows still work when sessions run with an isolated `HOME` and related XDG directories — because that is exactly how agents, tests, and reproducible dogfood scenarios are supposed to run.

### Why this matters

The recent dogfood pass showed that the core renderer works, but its browser/bootstrap dependencies still rely too heavily on ambient user-home assumptions. That turns isolated sessions — one of the product’s strongest patterns — into a source of accidental breakage.

If screenshots or recordings fail under isolation, then `agent-terminal` is not yet meeting its own recommended workflow for agents.

### Deliverables

- audit how Playwright/browser assets, font assets, and related renderer prerequisites are resolved when session `HOME` is overridden,
- decide on the intended contract for browser asset lookup (for example, automatic shared cache discovery, copied bootstrap assets, or explicit internal environment propagation),
- implement that contract so the common isolated-session path works without manual user intervention,
- add targeted tests that create isolated `AGENT_TERMINAL_HOME` and isolated session `HOME` values and still prove screenshot viability,
- ensure `record export --format webm` follows the same environment story as `screenshot`,
- and document any remaining explicit environment assumptions that are still intentionally required.

### Acceptance criteria

- a newly created isolated session can produce screenshots without requiring a manual `PLAYWRIGHT_BROWSERS_PATH` workaround,
- isolated sessions can also export a WebM recording when the renderer/export capability is otherwise available,
- the selected bootstrap strategy is reflected in docs and tests rather than hidden in local machine state,
- and renderer/bootstrap failures in this area are reproducible, structured, and diagnosable.

## Workstream B — first-class in-session command execution

### Goal

Add one reliable, ergonomic primitive for running shell commands inside a session without requiring users or agents to simulate every setup step through brittle multiline typing.

### Why this matters

The current low-level primitives are valuable and should remain:

- `type`,
- `paste`,
- `send-keys`,
- `wait`,
- `snapshot`,
- and `screenshot`.

But the dogfood session made it clear that these primitives alone are not the best public surface for common setup tasks such as:

- cloning a repo,
- writing a small config file,
- installing a tool,
- setting environment variables for the current shell,
- and preparing a TUI app before interaction-heavy validation begins.

A release-grade agent tool should not require repeated here-doc gymnastics or fragile long typed strings for routine shell setup.

### Deliverables

- define a new CLI command or subcommand (for example `run`, `exec`, or equivalent) whose purpose is robust shell command execution inside an existing session,
- decide how command input is provided (inline text, `--file`, stdin, or a combination),
- decide how completion is reported (for example, accepted/queued only versus command-boundary markers plus wait semantics),
- ensure the surface composes clearly with existing low-level primitives rather than trying to replace them,
- emit a stable JSON envelope for automation,
- add targeted tests for single-line commands, multiline scripts, non-zero exits, and shell-state-preserving scenarios where applicable,
- and document when users should choose the new command primitive instead of `type` or `paste`.

### Acceptance criteria

- a user can reliably execute a multiline shell setup script in-session without simulating each line as fragile keystrokes,
- automation can determine whether the command was accepted and where its execution boundaries are,
- common setup workflows in docs and dogfood bundles use the new primitive rather than ad hoc typing hacks,
- and the new public surface is schema-backed and test-locked.

## Workstream C — TUI-focused diagnostics and environment explainability

### Goal

Make `doctor` and related introspection answer the setup questions that real TUI workflows actually need answered.

### Why this matters

The current `doctor` command is already useful, but the recent dogfood pass still required trial-and-error to answer questions like:

- will screenshot rendering work with this isolated session setup?
- where are browser assets being resolved from?
- is this Neovim build new enough for the intended workflow?
- is the environment expected to render Nerd Font glyphs correctly?
- and which failures are product limitations versus simple local prerequisites?

If those answers require repo spelunking or prior maintainer knowledge, the product is not yet ready to explain itself to first-time `0.1.0` users.

### Deliverables

- extend `doctor --json` to surface the environment facts most relevant to real TUI automation,
- make the renderer/bootstrap path and capability story legible when isolation is in play,
- decide whether a lightweight glyph/font-render smoke check belongs in `doctor`, a separate validation helper, or the dogfood bundle only,
- ensure the docs describe the expected Neovim/TUI prerequisites for the reference workflow,
- and add tests that keep the newly surfaced diagnostics stable.

### Acceptance criteria

- `doctor --json` makes it obvious whether renderer-backed inspection is expected to work in the current environment,
- the docs explain how to interpret failed versus unavailable checks,
- and users can distinguish product limitations, missing dependencies, and scenario-specific application prerequisites without guesswork.

## Workstream D — release-grade TUI dogfood bundle and proof bar

### Goal

Ratify at least one realistic TUI workflow as the concrete `0.1.0` proof bar and preserve it as reviewer-facing evidence.

### Why this matters

A release candidate should not rely only on unit tests and generic fixture TUIs. The strongest evidence from the latest dogfood pass came from a real workflow:

- create an isolated environment,
- prepare a Neovim config,
- launch LazyVim,
- verify Nerd Font rendering,
- trigger the Claude Code keybind,
- inspect the split-pane UI,
- and leave behind screenshots/video proving the result.

That kind of scenario is much closer to what users will actually care about than a synthetic “hello world” fixture alone.

### Deliverables

- create a dedicated Week 9 proof bundle for the Neovim/LazyVim/Claude Code scenario,
- keep the commands scripted and reproducible,
- include screenshots for each milestone,
- include at least one `.webm` recording showing the TUI interaction flow,
- generate and validate the review bundle output,
- add short notes describing the observed result, including any limitations that are still acceptable for `0.1.0`,
- and decide whether this scenario should remain a dogfood-only script or graduate into a heavier e2e/fixture-backed test over time.

### Acceptance criteria

- a reviewer can inspect the bundle and understand the exact TUI workflow without reproducing it locally,
- the bundle demonstrates isolated-session setup, TUI launch, Nerd Font rendering, keymap-driven interaction, and screenshot/video proof,
- the bundle passes the repo’s bundle validation rules,
- and the scenario is documented as a representative `0.1.0` TUI success case rather than a one-off experiment.

## Workstream E — release docs and explicit `0.1.0` contract statement

### Goal

Describe the `0.1.0` release target clearly enough that users know what is reliable, what is intentionally limited, and what will wait for post-`0.1.0` milestones.

### Why this matters

A strong `0.1.0` does not require perfection. It does require clarity.

The release should make it easy to answer:

- what workflows is `agent-terminal` good at today?
- what should users expect from the reference renderer?
- when should they use the new command primitive versus low-level input commands?
- what does “good enough for TUI dogfooding” actually mean?
- and which gaps are known but intentionally deferred?

### Deliverables

- update the main design/roadmap docs to reflect Week 9 as the pre-`0.1.0` closeout milestone,
- add or refresh user-facing documentation that explains the recommended TUI workflow,
- state the known limitations that remain acceptable for `0.1.0`,
- add a concise release-readiness checklist that maintainers can use before tagging,
- and ensure any new commands, diagnostics, or bundle expectations are documented in the same change that implements them.

### Acceptance criteria

- reviewers can point to one document that explains the `0.1.0` bar,
- the docs no longer imply stronger TUI semantics than the product actually provides,
- and post-`0.1.0` feature ideas remain clearly separated from must-have release work.

## Dogfooding and validation

Week 9 must keep the same proof-heavy bar as the earlier plans.

### Required dogfood principle

For any change that affects isolated-session behavior, TUI setup ergonomics, renderer/bootstrap reliability, `doctor --json`, or other machine-facing release-readiness surfaces, the implementation should produce:

- JSON command outputs,
- screenshots,
- generated `review-bundle` output,
- `.webm` recordings for interaction-heavy scenarios,
- and short written notes describing expected versus observed behavior.

### Required Week 9 dogfood setup

Because this is a CLI project, Week 9 dogfooding should run against an isolated absolute `AGENT_TERMINAL_HOME` and use direct CLI invocation.

At a minimum, the Week 9 proof workflow should document a setup equivalent to:

```sh
mise install
mise run bootstrap
npm run build

export AGENT_TERMINAL_HOME="$(mktemp -d)"
npx tsx src/cli/main.ts version --json
npx tsx src/cli/main.ts doctor --json
```

For isolated TUI scenarios, the workflow should additionally make the session-local `HOME` and XDG directories explicit rather than silently using the real user environment.

### Required Week 9 proof bundles

At a minimum, Week 9 should leave behind bundles covering:

1. **Isolated renderer/bootstrap scenario**
   - proves that a fresh isolated session can capture screenshots and, when supported, export a WebM without manual environment surgery.
2. **High-level command primitive scenario**
   - proves that the new command surface can run a multiline setup script more reliably than low-level typing and that its JSON/reporting contract is reviewer-visible.
3. **Release-grade Neovim/LazyVim scenario**
   - proves isolated setup, Neovim launch, Nerd Font rendering, plugin/keymap interaction, and visual proof output.
4. **Doctor/release-readiness scenario**
   - proves the environment diagnostics and the generated reviewer surface explain the release bar and common prerequisites.

### Screenshot and video requirements

Week 9 should continue the design rule that screenshots and videos are mandatory proof artifacts for reviewer-facing interaction changes.

For the release-grade Neovim/LazyVim scenario, capture at least:

- one screenshot showing successful environment/bootstrap setup,
- one screenshot showing Neovim / LazyVim running with glyph-heavy UI visible,
- one screenshot showing the target interaction result (for example, Claude Code launched from a keybind),
- one generated review page,
- and one `.webm` recording of the workflow.

For the more command/reporting-focused bundles, still capture at least one screenshot and the generated review page instead of relying on JSON alone.

## Quality gates between workstreams

Do not move on from a workstream until:

- the new tests for that workstream pass,
- the related proof bundle exists,
- screenshots and `.webm` artifacts exist where required,
- the docs for that surface are updated in the same change,
- and any intentionally deferred follow-ups are written down explicitly.

## Proposed release-candidate checklist

Before tagging `0.1.0`, maintainers should be able to answer “yes” to all of the following:

- Does isolated-session screenshot rendering work on a clean, documented setup?
- Does the recommended command surface support robust shell setup for real TUI workflows?
- Can `doctor` explain the renderer/bootstrap prerequisites and likely failure modes clearly?
- Is there a reviewer-ready TUI dogfood bundle that demonstrates the release bar with screenshots and video?
- Do the public docs explain both the strengths and the known limits of the `0.1.0` TUI workflow?
- Are remaining major asks now clearly post-`0.1.0` feature work rather than unresolved release blockers?

If the answer is “no” to any of the above, Week 9 should stay open until the gap is either closed or explicitly reclassified as acceptable `0.1.0` scope.
