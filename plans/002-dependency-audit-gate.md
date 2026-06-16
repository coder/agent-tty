# Plan 002: CI fails on high-severity dependency advisories, and the current ones are cleared

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c11e2e2..HEAD -- mise.toml .github/workflows/ci.yml package.json aube-lock.yaml`
> If any in-scope file changed since this plan was written, re-run
> `aube audit` (Step 1) and compare against the advisory list below before
> proceeding; on a large mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none
- **Category**: security / dx
- **Planned at**: commit `c11e2e2`, 2026-06-16

## Why this matters

This repo has no dependency-advisory gate: `mise.toml` has no `audit` task and
`.github/workflows/ci.yml` never audits. As of this writing, `aube audit`
reports **7 advisories (3 high, 3 moderate, 1 low)** that went unnoticed for
exactly that reason. None is a realistic exploit of the shipped CLI — they sit
in transitive build/tooling and non-attacker-facing runtime paths (e.g.
Playwright's own CDP WebSocket, build tools) — but they are trivial to clear and
should not be invisible. The durable win here is the **gate**: once CI runs
`aube audit --audit-level high`, any _future_ high/critical advisory in the
dependency tree fails the build instead of silently shipping.

## Current state

The advisories, from running `aube audit` at the repo root (you will re-run this
in Step 1 to get the live list):

| Severity | Package            | Vulnerable range | Advisory                                                         |
| -------- | ------------------ | ---------------- | ---------------------------------------------------------------- |
| high     | esbuild            | >=0.17.0 <0.28.1 | GHSA-gv7w-rqvm-qjhr (binary-integrity / NPM_CONFIG_REGISTRY RCE) |
| high     | vite               | >=8.0.0 <=8.0.15 | GHSA-fx2h-pf6j-xcff (`server.fs.deny` bypass, Windows)           |
| high     | ws                 | >=8.0.0 <8.21.0  | GHSA-96hv-2xvq-fx4p (memory-exhaustion DoS)                      |
| moderate | vite/launch-editor | >=8.0.0 <=8.0.15 | GHSA-v6wh-96g9-6wx3 (NTLMv2 hash disclosure, Windows)            |
| moderate | ws                 | >=8.0.0 <8.20.1  | GHSA-58qx-3vcg-4xpx (uninitialized memory disclosure)            |
| low      | esbuild            | >=0.27.3 <0.28.1 | GHSA-g7r4-m6w7-qqqr (dev-server arbitrary file read, Windows)    |

Installed versions (from `aube-lock.yaml`): `esbuild@0.27.7`, `vite@8.0.11`,
`ws@8.20.0`, `brace-expansion@5.0.5` (the brace-expansion moderate ReDoS,
GHSA-jxxr-4gwj-5jf2, also appears in the full audit). All are **transitive** —
none is listed directly in `package.json` `dependencies`/`devDependencies`.

**`mise.toml`** defines tasks as `[tasks.<name>]` with a `run = "..."`. The
aggregate CI task is:

```toml
[tasks.ci]
description = "Run CI checks"
run = "mise run format-check && mise run workflow-lint && mise run lint && mise run typecheck && mise run test && mise run build && mise run install-smoke"
```

There is **no** `[tasks.audit]`.

**`.github/workflows/ci.yml`** — the `linux-static` job runs a sequence of
`mise run …` steps (format-check, workflow-lint, lint, typecheck,
validate-bundles, build, install-smoke). It must stay hand-curated (per
`AGENTS.md`: "Keep `.github/workflows/ci.yml` hand-curated").

### The audit tooling (verified)

`aube audit` supports:

- `--audit-level <low|moderate|high|critical>` — only fail/print at or above a
  severity (default `low`).
- `--fix=update` — refresh the lockfile to patched versions allowed by existing
  version ranges (no `package.json` changes).
- `--fix=override` — write `package.json` overrides forcing patched versions.
- `--dev` — audit only `devDependencies`.

`aube audit` mutates `aube-lock.yaml` / `package.json` only when `--fix` is
passed; a bare `aube audit` is read-only.

## Commands you will need

| Purpose           | Command                         | Expected on success             |
| ----------------- | ------------------------------- | ------------------------------- |
| Audit (read-only) | `aube audit`                    | prints advisories               |
| Audit, high+ only | `aube audit --audit-level high` | "0 vulnerabilities" at high+    |
| Fix in-range      | `aube audit --fix=update`       | lockfile updated                |
| Fix via overrides | `aube audit --fix=override`     | package.json + lockfile updated |
| Install           | `aube install`                  | exit 0                          |
| Typecheck         | `npm run typecheck`             | exit 0                          |
| Build             | `npm run build`                 | exit 0                          |
| Unit tests        | `npm run test:unit`             | all pass                        |
| Lint workflows    | `mise run workflow-lint`        | exit 0                          |
| Run a mise task   | `mise run audit`                | (after Step 3)                  |

## Scope

**In scope**:

- `package.json` — only if `--fix=override` adds an `overrides`/`pnpm.overrides`
  block to clear advisories.
- `aube-lock.yaml` — regenerated by `aube audit --fix` / `aube install`.
- `mise.toml` — add `[tasks.audit]` and reference it from `[tasks.ci]`.
- `.github/workflows/ci.yml` — add one audit step to the `linux-static` job.

**Out of scope**:

- Bumping the _direct_ dependency majors (`playwright`, `ink`, `vitest`,
  `ghostty-web`) to chase a transitive — overrides are the surgical fix. If only
  a direct-major bump can clear a high advisory, that is a STOP condition.
- `CHANGELOG.md` — automation-owned (Communique/release-please); never edit it.
- Any `src/` code change. This plan is dependency + CI config only.
- The macOS CI job (`quality-gates-macos`) — it intentionally omits release-only
  tooling; do not add the audit step there.

## Git workflow

- Branch: `advisor/002-dependency-audit-gate`
- Conventional Commits. Example: `ci: gate CI on high-severity dependency advisories`.
  If overrides are written, a second commit like
  `chore(deps): override ws/vite/esbuild to patched versions` is fine.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Capture the current advisory baseline

Run `aube audit` and save the output. Confirm it roughly matches the table
above (versions/advisories may have shifted slightly since planning — that's
fine; work from the live list). Then run `aube audit --audit-level high` and
note exactly which **high** advisories are reported — those are the ones the
gate (Step 3) will require to be clear.

**Verify**: `aube audit` prints a non-empty advisory list including at least one
`high`.

### Step 2: Clear the advisories

1. Run `aube audit --fix=update` (patches reachable within existing ranges).
2. Re-run `aube audit --audit-level high`. If high advisories remain, run
   `aube audit --fix=override` to force the patched versions (this writes an
   overrides block to `package.json`).
3. Run `aube install` to ensure the lockfile is consistent.
4. Re-run `aube audit --audit-level high`.

**Verify**: `aube audit --audit-level high` reports **0 high (and 0 critical)
vulnerabilities**. (Moderate/low may remain — see Maintenance notes.)

### Step 3: Confirm nothing broke

The overrides force newer transitive versions; confirm the toolchain still works:

- `npm run typecheck` → exit 0.
- `npm run build` → exit 0.
- `npm run test:unit` → all pass.

If feasible in this environment, also run `npm run test:e2e` (it exercises the
ghostty-web/Playwright path that pulls vite/esbuild/ws). If e2e can't run here,
note that in your report.

**Verify**: typecheck, build, and unit tests all green.

### Step 4: Add the `audit` mise task

In `mise.toml`, add a task (place it near `[tasks.lint]`):

```toml
[tasks.audit]
description = "Fail on high-severity dependency advisories"
run = "aube audit --audit-level high"
```

Then add `mise run audit` to the `[tasks.ci]` chain — put it right after
`mise run lint`:

```toml
[tasks.ci]
description = "Run CI checks"
run = "mise run format-check && mise run workflow-lint && mise run lint && mise run audit && mise run typecheck && mise run test && mise run build && mise run install-smoke"
```

**Verify**: `mise run audit` → exit 0 (matches Step 2's clean high-level audit).

### Step 5: Wire the audit into CI

In `.github/workflows/ci.yml`, in the **`linux-static`** job, add a step after
the existing "Lint" step (`run: mise run lint`):

```yaml
- name: Audit dependencies
  run: mise run audit
```

Keep the file hand-curated (don't regenerate it). Do not touch any other job.

**Verify**: `mise run workflow-lint` → exit 0 (actionlint + zizmor accept the
new step).

## Test plan

This change is config/dependency only; the "tests" are the audit and build
gates themselves:

- `aube audit --audit-level high` → 0 high/critical.
- `mise run audit` → exit 0.
- `npm run typecheck && npm run build && npm run test:unit` → all green
  (proves the forced transitive versions are compatible).
- `mise run workflow-lint` → exit 0 (proves the CI edit is valid).

No new unit test file is required.

## Done criteria

ALL must hold:

- [ ] `aube audit --audit-level high` reports 0 high and 0 critical advisories.
- [ ] `grep -n "tasks.audit" mise.toml` and `grep -n "mise run audit" mise.toml`
      both match (task defined and in the `ci` chain).
- [ ] `grep -n "Audit dependencies" .github/workflows/ci.yml` matches, under the
      `linux-static` job.
- [ ] `mise run workflow-lint` exits 0.
- [ ] `npm run typecheck`, `npm run build`, `npm run test:unit` all exit 0.
- [ ] No `src/` files modified; no `CHANGELOG.md` change (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back (do not improvise) if:

- Clearing a **high** advisory is impossible via `--fix=update` / `--fix=override`
  and would require a major bump of a direct dependency (`playwright`, `ink`,
  `vitest`, `ghostty-web`) — report the residual advisory and its reachability;
  the maintainer decides whether to gate at `critical` instead or accept the risk.
- After overrides, `npm run build` or `npm run test:unit` fails and a quick,
  in-range version adjustment doesn't fix it (a forced version is incompatible).
- `aube audit` is unavailable in your environment (e.g. `aube` not installed) —
  do not substitute `npm audit` (the repo has no `package-lock.json`; `npm audit`
  errors with ENOLOCK here). Report instead.
- The live advisory set is wildly different from the table above (e.g. a new
  critical in a direct dependency) — surface it rather than silently fixing.

## Maintenance notes

- The gate is set at `high` deliberately: it blocks the genuinely actionable
  advisories without making CI hostage to every low-signal transitive moderate.
  If the team wants moderates gated too, change `--audit-level high` to
  `moderate` once the current moderates (brace-expansion ReDoS, ws uninitialized
  memory) are also cleared.
- `--fix=override` pins transitive versions in `package.json`. When the upstream
  direct deps catch up to patched transitives, those overrides can be removed —
  a reviewer should periodically check whether the overrides block is still
  needed (`aube audit` after deleting it).
- A reviewer should confirm the audit step landed only in `linux-static`, not in
  `quality-gates-macos` (which intentionally installs a reduced toolset).
- Reachability context for the PR description: these advisories are in
  build/tooling and non-attacker-facing runtime paths; the value is the gate and
  hygiene, not an active-exploit fix. State that honestly.
