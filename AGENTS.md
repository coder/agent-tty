You are an experienced, pragmatic software engineering AI agent. Do not over-engineer a solution when a simple one is possible. Keep edits minimal. If you want an exception to ANY rule, you MUST stop and get permission first.

# Project Overview

`agent-terminal` is a CLI-first terminal automation tool for AI agents and humans. It creates long-lived PTY-backed sessions, exposes machine-friendly commands to control them, and produces inspectable artifacts such as semantic snapshots, PNG screenshots, asciicast recordings, and WebM exports.

The current implementation is a TypeScript/Node v1 with these main building blocks:

- **Commander** for the CLI surface (`src/cli/main.ts`).
- **node-pty** for PTY/process lifecycle.
- **Zod** for protocol, manifest, and artifact validation.
- **ghostty-web + Playwright** as the reference renderer for screenshot, wait, snapshot, and replay/export flows.
- **Vitest, ESLint, Prettier, and TypeScript** for quality gates.
- **mise** as the canonical task runner in CI.

Session state is stored under `~/.agent-terminal` by default. In tests and automation, prefer an isolated absolute `AGENT_TERMINAL_HOME` instead of writing into the real home directory.

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

Preferred setup uses `mise`; fall back to direct `npm` only when necessary.

```sh
mise install
mise run bootstrap
```

If `mise` is unavailable:

```sh
npm ci
npx playwright install chromium
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

Development server: **none**. This is a CLI project, so iterative development usually means running `npx tsx src/cli/main.ts <command>` against an isolated `AGENT_TERMINAL_HOME`.

# Patterns

- **Do use `--json` for automation and prefer direct CLI invocation (`npx tsx src/cli/main.ts ...`) while developing.** Tests and design docs assume automation consumers read JSON envelopes. **Do not** scrape human-readable output when a JSON mode exists, and do not rely on noisy `npm run` wrappers when you need machine-parseable JSON.
- **Do isolate session homes in tests.** Follow the pattern in `test/helpers.ts` and `test/e2e/helpers.ts`: create a temp directory, set absolute `AGENT_TERMINAL_HOME`, clean it up, and destroy any surviving sessions. **Do not** let tests mutate `~/.agent-terminal`.
- **Do fail fast with assertions and schemas.** Existing code uses `invariant()`, `assertString()`, and `.safeParse()`/`.strict()` heavily. **Do not** silently coerce invalid paths, session IDs, or manifest data.
- **Do preserve the event-log-as-truth model.** New snapshot, screenshot, wait, or export features should flow through replayable event/state data. **Do not** add one-off state that only live PTY code can see.
- **Do keep storage writes inside validated helpers.** Path resolution in `src/storage/sessionPaths.ts`, manifest writers, and artifact helpers intentionally guard against path escape and invalid filenames. **Do not** write manifest-like files with ad hoc `fs.writeFile()` logic.
- **Do keep CI hand-curated.** `.github/workflows/ci.yml` is intentionally maintained by hand even though `mise generate github-action` can scaffold it. **Do not** overwrite the checked-in workflow with generated output without preserving the repo-specific steps and comments.
- **Do update coupled limits together.** `src/host/eventLog.ts` and `src/host/replay.ts` both enforce the 50 MB event-log limit. **Do not** change one without the other.
- **Do add tests at the right layer.** Small parser/validation changes usually belong in `test/unit`; CLI wiring and temp-home behavior fit `test/integration`; renderer/artifact flows belong in `test/e2e`.

- **Do keep the public `skills/agent-terminal/` artifact binary-first.** The committed public skill and public-facing skill docs must use `agent-terminal ...`, not repo-local `npx`, `tsx`, or `src/cli/main.ts` invocations. When you execute those examples from this source tree, translate them locally to `npx tsx src/cli/main.ts ...`, but do not commit that substitution back into the public skill or README skill-install guidance.
- **Do teach the terminal workflow the public skill is supposed to reinforce.** Prefer `--home`, `--json`, `run`, `wait`, `snapshot`, `screenshot`, and `record export` when writing or maintaining public skill examples. **Do not** teach `tmux`, blind `sleep`, or out-of-band screenshots as the primary workflow.

## Testing patterns

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
