# PRD: External Outer Camera for the Coding-Agent Hero Demo

## Problem Statement

The current coding-agent demo is valuable self-dogfood, but it is too unstable and visually noisy for the README-facing story. It asks `agent-tty` to record an outer Codex or Claude Code TUI while that real coding agent creates an inner `agent-tty` session and exports proof artifacts. This recursive setup couples too many unstable layers: live coding-agent UI behavior, trust prompts, update notices, nested terminal sessions, renderer timing, exit behavior, thumbnail timing, and recording post-processing.

As a maintainer or reviewer, I want the README demo to be a polished, stable **Hero Demo** that shows real coding-agent TUIs using `agent-tty` to produce inner proof artifacts. I do not need the README visual to prove that `agent-tty` recorded the outer coding-agent TUI. That stronger self-dogfood claim makes the demo harder to regenerate and harder to review.

## Solution

Replace the recursive README-facing demo with a **Promoted Hero Demo** that uses an external **Outer Camera** for the visible Codex and Claude Code TUIs, while keeping `agent-tty` responsible for the inner terminal proof artifacts.

The new flow will use a Node/TypeScript **Hero Demo Generator**. The generator prepares isolated inputs for **Manual Demo Regeneration**, creates runner scripts and raw VHS tapes, invokes VHS as the **Outer Camera**, validates the resulting **Curated Hero Artifact Set**, runs automated text leak checks, records tool/model settings, and writes a **Promoted Hero Run Summary**.

The scenario is an **Exploratory Hero Demo**: the real coding-agent TUI loads the packaged `agent-tty` skill, inspects the CLI as needed, chooses its own command flow, drives an inner Neovim workflow through `agent-tty`, and exports inner proof artifacts. The prompt supplies success criteria, required output paths, final text, and a configurable fixed review window, but no prewritten helper script or exact command sequence. The generated VHS tape owns startup waits, the configurable fixed review window, and exit keypresses during recording. Raw VHS tapes, recorder logs, and disposable workspaces are **Debug-Only Raw Demo Files** and are ignored by default.

The existing recursive bundle is removed once the new Hero Demo is promoted. The README claim is narrowed through the **Hero Claim Boundary**: the outer TUI is presentation, and the inner `agent-tty` artifacts are the product proof.

## User Stories

1. As a README reader, I want to see a polished recording of Codex using `agent-tty`, so that I quickly understand the coding-agent workflow.
2. As a README reader, I want to see a polished recording of Claude Code using `agent-tty`, so that I understand the workflow is not tied to one coding-agent CLI.
3. As a README reader, I want the demo recording to be visually stable, so that startup waits and nested recorder noise do not distract from the product story.
4. As a README reader, I want a clickable PNG thumbnail for each outer recording, so that I can preview the coding-agent TUI before opening the WebM.
5. As a README reader, I want the outer WebM to show the real coding-agent TUI, so that the demo feels authentic rather than simulated.
6. As a README reader, I want the demo copy to clearly state that `agent-tty` produced the inner proof artifacts, so that I understand what the product is proving.
7. As a README reader, I want the demo copy not to imply that `agent-tty` recorded the outer coding-agent TUI, so that I do not misunderstand the proof boundary.
8. As a maintainer, I want a named **Hero Demo Promotion Command**, so that I can regenerate the demo without reverse-engineering several scripts.
9. As a maintainer, I want the regeneration command to support Codex-only runs, so that I can debug Codex behavior without paying the Claude Code cost.
10. As a maintainer, I want the regeneration command to support Claude-only runs, so that I can debug Claude Code behavior without paying the Codex cost.
11. As a maintainer, I want the regeneration command to support both agents in one promotion run, so that the promoted summary is coherent.
12. As a maintainer, I want the regeneration command to require three successful Codex runs and three successful Claude Code runs before promotion, so that a one-off smoke does not replace the README demo.
13. As a maintainer, I want a **Hero Demo Partial Pass** to fail promotion, so that the README does not end up with one fresh agent recording and one stale or missing recording.
14. As a maintainer, I want Codex and Claude Code model and effort defaults, so that routine regeneration has a simple happy path.
15. As a maintainer, I want model and effort overrides, so that I can adapt when coding-agent defaults or model availability changes.
16. As a maintainer, I want the resolved tool versions, model names, and effort settings recorded in the run summary, so that future reviewers can understand what produced the artifacts.
17. As a maintainer, I want VHS, ttyd, and ffmpeg pinned as repo tools for named demo tasks, so that regeneration is reproducible without forcing ordinary CI to run live-agent demos.
18. As a maintainer, I want ordinary CI not to require Codex or Claude Code credentials, so that the normal project validation remains portable.
19. As a maintainer, I want CI to keep validating checked-in bundle metadata and normal package behavior, so that the promoted artifacts do not drift silently.
20. As a maintainer, I want raw VHS tapes and recorder logs to remain ignored by default, so that the promoted bundle stays curated and low-noise.
21. As a maintainer, I want raw VHS tapes and recorder logs available locally after a failed run, so that I can debug prompt or UI drift.
22. As a maintainer, I want disposable workspaces to stay out of the curated artifact set, so that local paths and sensitive environment details do not leak.
23. As a maintainer, I want a strict **Hero Demo Leak Check**, so that account details, auth warnings, tokens, and absolute home paths do not get checked in.
24. As a maintainer, I want automated text scanning over transcripts, logs, summaries, and generated text artifacts, so that obvious leakage is caught before visual review.
25. As a maintainer, I want human visual review of PNG and WebM outputs, so that visual-only leakage and poor framing are caught before promotion.
26. As a maintainer, I want benign update or product notices to be allowed if they do not dominate the recording, so that live-agent artifacts do not require brittle post-processing.
27. As a maintainer, I want auth conflicts and billing/account lines to block promotion, so that checked-in visuals do not expose account-sensitive details.
28. As a maintainer, I want generated transcripts for the outer coding-agent TUIs, so that reviewers can audit what happened without watching the video frame-by-frame.
29. As a maintainer, I want inner `agent-tty` cast artifacts, so that reviewers can inspect terminal replay data from the product-generated proof.
30. As a maintainer, I want inner `agent-tty` WebM artifacts, so that reviewers can visually review the inner terminal workflow.
31. As a maintainer, I want final file proof from the inner workflow, so that the demo proves the agent-controlled TUI did the intended work.
32. As a maintainer, I want the prompt checked in with the promoted artifact set, so that reviewers can see exactly what the real coding agent was asked to do.
33. As a maintainer, I want a summary checked in with the promoted artifact set, so that the promotion evidence is easy to find.
34. As a maintainer, I want only one selected promoted run per agent checked in, so that the bundle does not grow with all trial outputs.
35. As a maintainer, I want the summary to prove that three runs per agent passed, so that the reliability bar remains visible even when only selected artifacts are promoted.
36. As a maintainer, I want the canonical manifest to include sha256 and byte counts for promoted artifacts, so that artifact drift is detected.
37. As a maintainer, I want the canonical manifest to exclude debug-only raw files, so that validation focuses on reviewer-facing outputs.
38. As a maintainer, I want the catalog and README to point to the new curated artifacts, so that reviewers do not follow obsolete recursive-flow links.
39. As a maintainer, I want the old recursive bundle deleted after replacement, so that there is one maintained coding-agent demo path.
40. As a maintainer, I want the deletion to be reflected in docs and catalog language, so that future contributors know the recursive proof was intentionally removed.
41. As a contributor, I want the domain glossary to distinguish **Hero Demo**, **Outer Camera**, **Hero Demo Generator**, and **Recursive Dogfood Proof**, so that implementation discussions use precise language.
42. As a contributor, I want the ADR to explain why the outer recording moved outside `agent-tty`, so that I do not reintroduce the recursive flow accidentally.
43. As a contributor, I want tests for the generator's planning and validation logic, so that refactors do not break artifact selection or leak checks.
44. As a contributor, I want tests that avoid live Codex or Claude Code calls, so that the generator's deterministic behavior can be verified in CI.
45. As a contributor, I want smoke/debug modes for the generator, so that I can iterate without running the full promotion bar.
46. As a contributor, I want promotion mode to fail loudly with actionable messages, so that missing artifacts, failed waits, or leak matches are easy to diagnose.
47. As a reviewer, I want the promoted artifacts to be small enough to review in GitHub, so that the demo remains practical to inspect.
48. As a reviewer, I want WebM to remain the primary video format, so that the new demo matches the current README pattern.
49. As a reviewer, I want PNG thumbnails to be captured from meaningful TUI states, so that the README preview shows the real coding-agent UI after useful output appears.
50. As a reviewer, I want the inner and outer artifacts to be clearly named by agent, so that I can compare Codex and Claude Code without guessing.
51. As a reviewer, I want the summary to say which artifacts were selected for promotion, so that I know which of the successful runs became the README-facing artifacts.
52. As a reviewer, I want the summary to say which successful trial outputs stayed debug-only, so that I understand the promotion evidence without checking in every file.
53. As an automation maintainer, I want named demo tasks to stay outside ordinary CI, so that the repository's default validation remains fast and credential-free.
54. As an automation maintainer, I want canonical bundle validation to continue covering the promoted demo, so that a checked-in artifact cannot change without manifest updates.
55. As an automation maintainer, I want the generator to use isolated homes and temporary workspaces, so that regeneration does not mutate the maintainer's real `agent-tty` home or editor state.
56. As an automation maintainer, I want cleanup to avoid deleting live `agent-tty` sessions it does not own, so that demo regeneration remains safe.
57. As an automation maintainer, I want failures to preserve debug-only raw files locally, so that a maintainer can inspect the exact VHS tape, transcript, and logs.
58. As an automation maintainer, I want successful promotion to copy only curated artifacts into the canonical bundle, so that sensitive debug files do not slip into review.
59. As a product maintainer, I want the demo to preserve authenticity by using real Codex and Claude Code, so that the README demonstrates actual coding-agent TUIs rather than fixtures.
60. As a product maintainer, I want the option to evolve to an active PTY proxy controller later if raw VHS tapes flake, so that the current design does not foreclose a more robust control layer.

## Implementation Decisions

- Build a Node/TypeScript **Hero Demo Generator** as the deep module that owns setup, raw tape generation, runner generation, invocation, artifact validation, leak checks, promotion selection, and summary generation.
- Keep the generated VHS tape as the recorder-time control layer. It owns screen waits and keypresses while VHS records the outer coding-agent TUI.
- Keep VHS as the **Outer Camera**. It records the visible Codex and Claude Code TUIs and emits WebM, PNG screenshot/thumbnail, and transcript-like output.
- Keep the scenario as an **Exploratory Hero Demo**. The real agent discovers the `agent-tty` skill and CLI, chooses its own command flow, drives an inner Neovim workflow through `agent-tty`, and exports the inner proof artifacts to required paths.
- Reuse the existing canonical coding-agent demo bundle identity and replace its contents wholesale with the **Promoted Hero Demo**.
- Delete the old recursive `agent-tty`-records-the-agent flow after the new Hero Demo is promoted.
- Narrow the README claim through the **Hero Claim Boundary**: the outer TUI is presentation, and the inner `agent-tty` artifact set is the product proof.
- Expose regeneration through a named mise task that delegates to the generator.
- Pin VHS, ttyd, and ffmpeg as repo tools for named demo tasks, but do not make live-agent regeneration part of ordinary CI.
- Provide smoke/debug modes for one-off agent runs and a promotion mode that requires the full **Hero Demo Promotion Bar**.
- Require three successful local regenerations for Codex and three successful local regenerations for Claude Code before promotion.
- Treat a **Hero Demo Partial Pass** as a failed promotion. Both agents must pass before README, catalog, manifest, or promoted artifacts are replaced.
- Check in one selected promoted run per agent plus a **Promoted Hero Run Summary**. Keep extra successful trial outputs ignored as **Debug-Only Raw Demo Files**.
- Keep WebM as the primary outer video format and PNG as the README thumbnail format.
- Maintain a **Curated Hero Artifact Set** containing outer WebM, outer PNG thumbnail/screenshot, outer transcript, inner `agent-tty` cast, inner `agent-tty` WebM, final file proof, prompt, summary, and canonical manifest entries.
- Keep raw generated VHS tapes, recorder logs, and disposable workspaces out of the curated set by default.
- Maintain canonical manifest validation with sha256 and byte counts for all promoted artifacts.
- Record resolved Codex and Claude Code versions, models, effort levels, tool versions, and relevant generator settings in the promoted run summary.
- Provide default model and effort settings for Codex and Claude Code, with CLI or environment overrides for maintainers.
- Apply strict account-scrub policy during promotion: names, emails, billing/account lines, auth warnings, tokens, and absolute home paths block promotion.
- Allow generic update or product notices only when they do not dominate the recording.
- Use automated text scanning for transcripts, generated text artifacts, summaries, and logs that are candidates for promotion.
- Require human visual review of PNG and WebM outputs before promotion.
- Preserve debug-only raw files after failures so maintainers can inspect UI drift, wait failures, or recorder issues.
- Do not publish a new public CLI JSON contract for this feature. The work is a maintainer-facing demo-generation workflow and checked-in artifact replacement.
- Do not require ordinary users to install VHS, ttyd, or ffmpeg to use `agent-tty`. Those tools are for **Manual Demo Regeneration**.

## Testing Decisions

- Tests should focus on external behavior of the **Hero Demo Generator** rather than implementation details.
- The generator should expose testable planning and validation units so most coverage can run without live Codex or Claude Code credentials.
- The tape-generation behavior should be tested by asserting generated tape intent from stable inputs: selected agent, dimensions, output names, startup waits, configurable fixed review window, and cleanup actions.
- The runner-generation behavior should be tested by asserting that agent-specific commands include expected model/effort settings, prompt wiring, workspace isolation, and environment variables for required artifact paths.
- The artifact validation behavior should be tested with fixture files that simulate complete, missing, empty, and mismatched curated artifact sets.
- The promotion selection behavior should be tested with fixture run records for full pass, partial pass, insufficient run count, and selected-run output.
- The **Hero Demo Leak Check** should be tested with fixture transcripts, summaries, and logs containing allowed generic notices and disallowed account-sensitive patterns.
- The summary-generation behavior should be tested from structured run results so it records tool versions, model settings, selected artifacts, run counts, and promotion outcome.
- The canonical manifest generation or update logic should be tested with fixture artifacts to verify sha256 and byte counts match on-disk content.
- The named demo task should have a lightweight smoke check that validates the command shape without requiring live-agent credentials.
- Live Codex and Claude Code regeneration should remain manual dogfooding, not CI-required tests.
- Manual dogfooding should run the promotion command for both agents with three runs each, then inspect WebM, PNG, transcript, inner cast/WebM, file proof, prompt, summary, and manifest.
- Manual visual review should verify that no names, emails, account/billing lines, auth warnings, tokens, or absolute home paths appear in promoted visuals.
- Manual visual review should verify that benign update/product notices, if present, do not dominate the thumbnail or video.
- Existing canonical bundle validation should remain the prior art for manifest completeness, sha256, and byte-count checks.
- Existing CLI and artifact tests remain prior art for validating JSON envelopes, artifact existence, and isolated homes, but the new generator should avoid depending on live CLIs in automated tests.
- A good test should treat VHS invocation as an external boundary. Unit tests should not assert private helper ordering when an externally visible generated tape, summary, or validation result is the behavior under test.
- A good test should verify failure messages are actionable for missing tools, missing auth, missing artifacts, failed leak checks, partial pass, and manifest mismatch.

## Out of Scope

- Keeping the recursive outer `agent-tty` coding-agent recording as a maintained parallel proof path.
- Claiming that the README Hero Demo proves `agent-tty` can record the outer coding-agent TUI.
- Running live Codex or Claude Code regeneration in ordinary CI.
- Building an active PTY proxy controller in the first implementation.
- Switching the Hero Demo to fixture or mock coding-agent TUIs.
- Using asciinema/agg as the primary outer recording pipeline in this refactor.
- Publishing raw VHS tapes, recorder logs, or disposable workspaces as reviewer-facing artifacts by default.
- Changing public `agent-tty` CLI JSON contracts, protocol schemas, or artifact formats for end users.
- Adding new product features to `agent-tty` recording/export behavior beyond what the demo generator needs.
- Post-processing visuals with blur/crop/redaction as the default approach to secrecy or polish.
- Supporting arbitrary coding-agent CLIs beyond Codex and Claude Code in the initial promoted demo.
- Guaranteeing deterministic model output from live coding-agent services.

## Further Notes

The VHS prototype passed a one-run-per-agent smoke: VHS launched real Codex and Claude Code TUIs, waited on screen regexes, captured PNG screenshots, and rendered compact WebM/ASCII evidence. That prototype proved feasibility, not promotion-level reliability. The promotion bar remains three successful local regenerations per agent plus automated leak checks and human visual review.

The implementation should keep the current ADR and glossary terminology aligned with the resulting code and docs. In particular, use **Hero Demo Generator** rather than “controller”, and use **Exploratory Hero Demo** rather than “Nested Helper Proof” unless the implementation intentionally returns to a deterministic helper design.

If raw VHS tapes fail the promotion bar due to optional prompts or UI drift, the design can evolve to an active PTY proxy controller while preserving the same **Hero Claim Boundary** and curated artifact policy.
