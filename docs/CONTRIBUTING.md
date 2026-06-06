# Contributing

## Setup

Preferred setup uses `mise`:

```bash
mise install
mise run bootstrap
```

Fallback setup after installing `aube` directly:

```bash
aube exec playwright install chromium
```

## Day-to-day workflow

- Use `npx tsx src/cli/main.ts ...` while developing from the source tree.
- Prefer `--json` when a workflow needs machine-readable output.
- Use an isolated absolute `AGENT_TTY_HOME` for tests and manual dogfooding.
- Keep storage writes, manifests, and protocol updates inside the existing validated helpers and schemas.

## Validation

Run the smallest meaningful checks while iterating, then finish with the full repo bar when the change warrants it:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run build
```

Or use the combined entry point:

```bash
npm run verify
```

If you touch the public bootstrap under `skills/` or the bundled runtime skills under `skill-data/`, also run:

```bash
npm run intent:validate
```

### Flaky integration and e2e tests

Integration and e2e tests drive real PTY hosts and headless-browser renderers, so an individual test can transiently fail under machine load (most often a screenshot render or host RPC hiccup) even when the code is correct. To keep these flakes from causing spurious red:

- `npm run test:integration`, `npm run test:e2e`, and the combined `npm run test` retry a failing test in place (`--retry=2`, up to three attempts). A genuine failure still fails all three attempts.
- `npm run test:unit` deliberately does **not** retry — unit tests must be deterministic, and the dedicated unit CI gate is the authority that catches real unit flakes.
- If an integration/e2e test fails _consistently_ (not just on one attempt), treat it as a real failure and investigate; do not raise the retry count to paper over it.
- When debugging a single browser-backed test locally, run it in isolation (`npm run test:e2e -- <file>`); the full serial suite is the heaviest load and the most flake-prone.

## Documentation and proof expectations

- Keep the root docs split clear: `README.md` for overview and `RELEASE.md` for supported scope.
- Put detailed user-facing instructions in focused docs under `docs/`: `INSTALL.md`, `USAGE.md`, `AGENT-SKILLS.md`, and `TROUBLESHOOTING.md`.
- Update [`design/README.md`](../design/README.md) when the active vs archived design split changes.
- Keep the skill split clear in docs and packaging notes: `skills/` contains the thin public bootstrap, while `skill-data/` contains the canonical runtime skills served by `agent-tty skills get`.
- Update [`dogfood/CATALOG.md`](../dogfood/CATALOG.md) when you add or promote a reviewer-facing proof bundle.
- Prefer public `agent-tty ...` invocations in shipped skill/docs examples; do not commit repo-local `npx tsx src/cli/main.ts ...` substitutions into public-facing examples.
