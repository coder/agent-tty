# ADR 0005: Use an external outer camera for the coding-agent Hero Demo

Date: 2026-05-20

## Status

Accepted

## Context

The current README-facing coding-agent demo is the `dogfood/agent-uses-agent-tty/` recursive flow: an outer `agent-tty` session records Codex or Claude Code, and the real coding agent creates an inner `agent-tty` session to drive Neovim and export proof artifacts.

That flow is strong self-dogfood, but it couples the README visual to multiple unstable layers at once: live coding-agent TUI behavior, startup/trust prompts, update notices, nested terminal sessions, renderer timing, exit behavior, thumbnail timing, and WebM post-processing. The resulting artifact proves a lot, but it is not the most stable or polished way to show the user-facing story.

A VHS prototype showed that VHS can launch and record real Codex and Claude TUIs, wait on screen regexes, capture PNG screenshots, and render compact WebM/ASCII artifacts. The first implementation pass used a deterministic helper script, but review of the resulting recordings showed that it hid the most interesting part of the story: how a coding agent discovers and uses `agent-tty` in the wild. The chosen scenario is therefore exploratory, with fixed success criteria, artifact paths, and a configurable fixed review window but no prewritten command script.

## Decision

The README-facing coding-agent demo will become a **Hero Demo** that uses an external **Outer Camera** for the visible coding-agent TUI, while keeping `agent-tty` responsible for the inner proof artifacts.

Concretely:

- `dogfood/agent-uses-agent-tty/` remains the canonical path, but its existing recursive contents are replaced wholesale by the new **Promoted Hero Demo**.
- The old recursive `agent-tty`-records-the-agent bundle is deleted after replacement, rather than maintained as a parallel proof path.
- The README claim is narrowed: the outer Codex/Claude TUI is presentation; the product proof is that the real coding-agent TUI uses `agent-tty` to produce inner terminal proof artifacts.
- The scenario is an **Exploratory Hero Demo**: the real agent loads the `agent-tty` skill, inspects the CLI as needed, chooses its own command flow, drives Neovim through `agent-tty`, and exports inner artifacts to required paths.
- A Node/TypeScript **Hero Demo Generator** prepares workspaces, prompts, runner scripts, and raw VHS tapes; invokes VHS as the **Outer Camera**; validates artifacts; performs automated leak checks; and writes the run summary.
- The generated VHS tape owns startup waits, a configurable fixed review window, and exit keypresses during recording. Raw tapes, logs, and disposable workspaces stay debug-only and ignored by default.
- VHS, ttyd, and ffmpeg are pinned as repo tools for named demo tasks, not used to regenerate real-agent artifacts in ordinary CI.
- The refactor lands as one coherent change: generator, tool pins, promoted artifacts, README/catalog updates, manifest updates, and recursive-bundle deletion.
- Regeneration is exposed through a named mise demo task that delegates to the Node/TypeScript generator.
- Codex/Claude model and effort settings have defaults, support maintainer overrides, and are recorded with tool versions in the promoted run summary.
- The promoted artifact set is curated: one selected run per agent, WebM outer recording, PNG thumbnail/screenshot, outer transcript, inner `agent-tty` cast/WebM, final file proof, prompt, summary, and canonical `manifest.json` entries with sha256 and byte counts.
- A partial pass is not promotable: Codex and Claude must both pass before README and canonical artifacts are replaced.
- Promotion requires three successful local regenerations for Codex and three for Claude, automated text leak checks, and human visual review of PNG/WebM outputs.

## Considered options

- **Keep the recursive `agent-tty` outer recording as the README demo.** This preserved the strongest self-dogfood story, but kept the README artifact exposed to the most timing and UI flake. Rejected because the README demo should optimize for stable presentation.
- **Maintain both a Hero Demo and a recursive dogfood proof.** This preserved self-dogfood coverage, but doubled maintenance for a live-agent scenario and kept the repo carrying two similar bundles. Rejected in favor of deleting the recursive bundle and narrowing the README claim.
- **Use an active PTY proxy controller with VHS only as the camera.** This would handle optional prompts and cleanup more robustly, but adds more implementation complexity than the current goal requires. Rejected for the first refactor; repeated-run promotion is the guard against raw-tape brittleness.
- **Use fixture/mock TUIs for deterministic visuals.** This would produce the cleanest recordings, but would no longer show real Codex or Claude using `agent-tty`. Rejected because the Hero Demo should remain a real-agent artifact.
- **Use a deterministic helper script for the inner proof.** This was more reliable and easy to validate, but made the outer recording look like an agent executing a canned script instead of discovering the skill and CLI. Rejected after prototype review because the Hero Demo should show the workflow in the wild.
- **Use asciinema/agg instead of VHS.** The tuicr reference demonstrates this shape well. Rejected for now because the VHS prototype proved sufficient for real TUIs and provides a convenient path to polished WebM/PNG outputs.

## Consequences

- Future readers should not interpret the README coding-agent demo as proof that `agent-tty` recorded the outer coding-agent TUI. It demonstrates that real coding-agent TUIs can use `agent-tty` to generate inner proof artifacts.
- The canonical `agent-uses-agent-tty` manifest remains important: it locks the promoted curated artifacts even though raw regeneration files stay ignored.
- Real-agent demo regeneration remains auth-gated and manual. CI can validate checked-in metadata and normal package behavior, but it must not require Codex or Claude credentials.
- Strict leak review becomes part of promotion. Names, emails, billing/account lines, auth warnings, tokens, and absolute home paths block promotion; generic update or product notices may remain if they do not dominate the recording.
- If raw VHS tapes fail the three-run promotion bar due to optional prompts or UI drift, the design can evolve to an active PTY proxy controller without changing the Hero Demo claim boundary.
