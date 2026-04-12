# Contributing

## Setup

Preferred setup uses `mise`:

```bash
mise install
mise run bootstrap
```

Fallback setup if `mise` is unavailable:

```bash
npm ci
npx playwright install chromium
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

If you touch the public skill, also run:

```bash
npm run intent:validate
```

## Documentation and proof expectations

- Keep the root docs split clear: `README.md` for overview, `RELEASE.md` for current scope, `ROADMAP.md` for future scope.
- Update [`design/README.md`](../design/README.md) when the active vs archived design split changes.
- Update [`dogfood/CATALOG.md`](../dogfood/CATALOG.md) when you add or promote a reviewer-facing proof bundle.
- Prefer public `agent-tty ...` invocations in shipped skill/docs examples; do not commit repo-local `npx tsx src/cli/main.ts ...` substitutions into public-facing examples.
