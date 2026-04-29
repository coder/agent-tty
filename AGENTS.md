You are an experienced, pragmatic software engineering AI agent. Do not over-engineer a solution when a simple one is possible. Keep edits minimal.

Follow these instructions unless they conflict with higher-priority instructions or make the task impossible. Treat destructive actions, running-session deletion, public API/JSON contract changes, and public skill behavior as hard-stop areas: ask before making an exception. For ordinary judgment calls, choose the smallest safe path, state the assumption, and verify it.

# Operating Contract

Goal: complete the user's repo task end to end with the smallest safe change.

Success means:

- Relevant code, tests, and docs were inspected before edits.
- Every changed line traces directly to the request.
- Public CLI JSON, protocol schemas, event logs, and artifacts remain consistent.
- Assertions or Zod validation guard non-obvious assumptions.
- Targeted validation was run, or the reason it could not run is stated.
- The final response names what changed and the exact checks performed.

Stop and ask only when the missing information would materially change the implementation, cause irreversible side effects, or require overriding a hard project invariant.

# Project Overview

`agent-tty` is a CLI-first terminal automation tool for AI agents and humans. It creates long-lived PTY-backed sessions, exposes machine-friendly commands to control them, and produces inspectable artifacts such as semantic snapshots, PNG screenshots, asciicast recordings, and WebM exports.

The current implementation is a TypeScript/Node v1 with these main building blocks:

- **Commander** for the CLI surface (`src/cli/main.ts`).
- **node-pty** for PTY/process lifecycle.
- **Zod** for protocol, manifest, and artifact validation.
- **ghostty-web + Playwright** as the reference renderer for screenshot, wait, snapshot, and replay/export flows.
- **Vitest, ESLint, Prettier, and TypeScript** for quality gates.
- **mise** as the canonical task runner in CI.

Session state is stored under `~/.agent-tty` by default. In tests and automation, prefer an isolated absolute `AGENT_TTY_HOME` instead of writing into the real home directory.

# Reference

## Important files

- `src/cli/main.ts` — public CLI contract and command registration.
- `src/cli/commands/*.ts` — command implementations; most behavior changes start here.
- `src/host/hostMain.ts` — per-session host orchestration for PTY, renderer, RPC, waits, and artifacts.
- `src/host/eventLog.ts` — append-only `events.jsonl` writer/reader; sequence numbers must stay contiguous.
- `src/host/replay.ts` — validated replay loader; keep its event-log assumptions aligned with `src/host/eventLog.ts`.
- `src/protocol/schemas.ts` and `src/protocol/messages.ts` — machine-facing schemas and result shapes.
- `src/storage/` — path guards, home/session resolution, manifest I/O, and artifact manifests.
- `src/renderer/ghosttyWeb/backend.ts` — reference renderer and Playwright browser harness.
- `src/export/asciicast.ts` and `src/export/webm.ts` — recording export logic.
- `src/util/assert.ts` — shared fail-fast assertion helpers.
- `design/ARCHITECTURE.md` — stable architecture and product intent overview.
- `ROADMAP.md` and `RELEASE.md` — shipped scope vs deferred scope at the repo root.
- `dogfood/README.md` and `dogfood/CATALOG.md` — proof-bundle navigation and reviewer-facing validation artifacts.

## Important directories

- `src/cli/` — CLI entrypoint, output envelopes, and user-facing commands.
- `src/host/` — long-lived session host, event logging, replay, RPC.
- `src/renderer/` — renderer abstraction plus the `ghostty-web` reference backend.
- `src/storage/` — filesystem layout and manifest/artifact helpers.
- `src/protocol/` — Zod schemas, envelopes, and command/result types.
- `test/unit/` — focused unit tests with mocked dependencies.
- `test/integration/` — CLI-level behavior against isolated temp homes.
- `test/e2e/` — higher-level fixture-driven flows that assert rendered output and artifacts.
- `test/fixtures/apps/` — tiny terminal apps used by e2e and dogfooding.
- `design/` — architecture references and archived planning/status docs.
- `docs/` — contributor and maintainer workflow docs.

## Architecture

Treat the architecture as:

`CLI -> per-session host -> PTY + append-only event log -> renderer replay -> artifact manifests/files`

Important implications:

- The **CLI JSON envelope** is the stable automation surface.
- The **per-session host** is internal implementation detail.
- The **event log** is canonical execution truth.
- The **renderer** provides reference visual truth, not native-terminal parity.
- Artifacts should be reproducible from session state and replay data, not from ad hoc side channels.

# Essential commands

Preferred setup uses `mise`; fall back to direct `aube` only when necessary.

```sh
mise install
mise run bootstrap
```

If `mise` is unavailable but `aube` is available:

```sh
aube exec playwright install chromium
```

Core commands:

```sh
mise run build          # or: npm run build
mise run format         # or: npm run format
mise run format-check   # or: npm run format:check
mise run lint           # or: npm run lint
mise run typecheck      # or: npm run typecheck
mise run test           # or: npm run test
mise run clean          # or: npm run clean
mise run ci             # or: npm run verify
```

CLI-specific development commands:

```sh
npx tsx src/cli/main.ts --help
npx tsx src/cli/main.ts doctor --json
npm run version:json
```

Other important scripts:

```sh
bash dogfood/generate-week3-bundles.sh
find dogfood -type f -name 'commands.sh' | sort
```

Development server: **none**. This is a CLI project, so iterative development usually means running `npx tsx src/cli/main.ts <command>` against an isolated `AGENT_TTY_HOME`.

# Validation

Run the narrowest useful validation for the change:

- Parser, helper, or schema changes: targeted unit tests.
- CLI behavior: integration tests with isolated `AGENT_TTY_HOME`.
- Renderer, screenshot, wait, export, or retention behavior: relevant e2e tests and dogfood artifact inspection when feasible.
- Broad or release-sensitive changes: `mise run ci`.

If validation cannot run, state why and name the next best check.

# Project Invariants

## Automation Surface

- Prefer `--json` for automation and direct CLI invocation (`npx tsx src/cli/main.ts ...`) while developing.
- Do not scrape human-readable output when a JSON mode exists.
- Do not rely on noisy `npm run` wrappers when you need machine-parseable JSON.
- If CLI JSON changes, update the corresponding schemas/messages/tests in the same change.

## Session And Storage Safety

- Use an isolated absolute `AGENT_TTY_HOME` in tests and automation.
- Never let tests mutate `~/.agent-tty`.
- Never delete running sessions; cleanup code must reconcile state first.
- Keep storage writes inside validated helpers such as `src/storage/sessionPaths.ts`, manifest writers, and artifact helpers.
- Do not write manifest-like files with ad hoc `fs.writeFile()` logic.

## Event Log And Replay

- Treat the event log as canonical execution truth.
- New snapshot, screenshot, wait, or export features should flow through replayable event/state data.
- Do not add one-off state that only live PTY code can see.
- Keep `src/host/eventLog.ts` and `src/host/replay.ts` assumptions aligned.
- If you change the 50 MB event-log limit, update both `src/host/eventLog.ts` and `src/host/replay.ts`.

## CI And Generated Files

- Keep `.github/workflows/ci.yml` hand-curated.
- Do not overwrite the checked-in workflow with `mise generate github-action` output without preserving the repo-specific steps and comments.

## Public Skill Contract

- Keep the public `skills/agent-tty/` artifact binary-first.
- Public skill and public-facing skill docs must use `agent-tty ...`, not repo-local `npx`, `tsx`, or `src/cli/main.ts` invocations.
- When executing those examples from this source tree, translate them locally to `npx tsx src/cli/main.ts ...`, but do not commit that substitution back into public skill or README skill-install guidance.
- Prefer `--home`, `--json`, `run`, `wait`, `snapshot`, `screenshot`, and `record export` when writing or maintaining public skill examples.
- Do not teach `tmux`, blind `sleep`, or out-of-band screenshots as the primary workflow.

## Test Layers

- Unit tests often mock command dependencies and assert exact envelopes or manifest writes.
- Integration tests run the real CLI via `tsx src/cli/main.ts` against temp homes.
- E2E tests use fixture apps such as `hello-prompt`, `color-grid`, and `resize-demo`, then assert visible output, screenshots, casts, videos, and artifact manifests.
- Renderer/export changes should usually be validated with both automated tests and a dogfood bundle under `dogfood/`.

# Anti-patterns

- **Never delete running sessions.** `gc` behavior and tests explicitly protect running sessions; cleanup code must reconcile state first.
- **Do not assume reference rendering equals native rendering.** The `ghostty-web` backend is a pinned reference renderer; parity with native terminal emulators is not guaranteed.
- **Do not bypass protocol/schema updates.** If a CLI JSON shape changes, update the corresponding schemas/messages/tests in the same change.
- **Do not rely on README alone for behavior details.** The README is brief; the design docs, command implementations, and tests are the authoritative references.

# Code style

- Follow the repo defaults: 2-space indentation, single quotes, trailing commas, semicolons, LF endings.
- This is strict TypeScript with `NodeNext` modules and ESM imports that include `.js` file extensions from TypeScript source.
- Prefer `import type` for type-only imports; ESLint enforces this.
- Keep schemas strict (`z.object(...).strict()`) and prefer existing helper/assertion utilities over duplicated validation code.
- Match the existing style of small helpers, explicit invariants, and straightforward control flow. Avoid introducing abstraction layers without a concrete need.

# Commit and Pull Request Guidelines

Before committing:

```sh
mise run ci
```

If `mise` is unavailable, run:

```sh
npm run verify
```

Additional expectations:

- If you touch renderer, screenshot, wait, export, or retention behavior, also run the most relevant e2e test(s) and regenerate or inspect the related `dogfood/` proof bundle when feasible.
- If you touch CLI JSON, schemas, manifests, or artifact formats, verify both implementation and tests in the same change.
- If you change environment/bootstrap assumptions, re-check `.github/workflows/ci.yml` and `mise.toml` together.

Commit messages in recent history commonly use an imperative summary with a type prefix, e.g. `feat: ...`. Default to `type: summary` (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`) unless the user asks for another convention.

There is no checked-in PR template. Write PR descriptions manually and include:

- what changed and why,
- user-facing or automation-facing behavior changes,
- exact validation commands run,
- any design-doc deviations,
- and links or paths to screenshots, video, or `dogfood/` artifacts when the change affects rendered output or reviewable proof.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `coder/agent-tty`; use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: `CONTEXT.md` and `docs/adr/` at the repo root (created lazily by `/grill-with-docs`). See `docs/agents/domain.md`.
