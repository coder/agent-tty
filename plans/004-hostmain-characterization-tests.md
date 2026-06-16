# Plan 004: hostMain's pure decision helpers and the idle-timeout path are covered by tests

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c11e2e2..HEAD -- src/host/hostMain.ts test/unit/host/hostMain.test.ts`
> If `src/host/hostMain.ts` changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `c11e2e2`, 2026-06-16

## Why this matters

`src/host/hostMain.ts` (1094 lines) is the per-session orchestration core — it
owns the PTY, event log, renderer polling, RPC dispatch, idle timeout, and
shutdown. Its entire unit test today is **9 lines** asserting one exported
constant (`test/unit/host/hostMain.test.ts`). The happy path is exercised
indirectly by integration/e2e tests (which run the real CLI), but the file's
**decision helpers** — exit-signal normalization, the commandability predicate
that gates every input/control RPC, and renderer-name resolution with its
env/default fallback — have no targeted tests, and one observable orchestration
branch (idle-timeout auto-exit) has no dedicated coverage. These are exactly the
small, branch-y functions where a regression slips through "the integration
test still passed". Characterizing them now pins the current behavior and makes
later refactors safe.

## Current state

`src/host/hostMain.ts` is one large `runHost(sessionId)` function with inner
closures, plus a handful of **module-level pure helpers** near the top. Only
`MAX_CONSECUTIVE_POLL_FAILURES` is currently exported:

```ts
// src/host/hostMain.ts
export const MAX_CONSECUTIVE_POLL_FAILURES = 10; // line 77

function normalizeExitSignal(signal: number | null): string | null {
  // line 87
  invariant(
    signal === null || (Number.isInteger(signal) && signal >= 0),
    'PTY exit signal must be a non-negative integer or null',
  );
  return signal === null || signal === 0 ? null : String(signal);
}

function isSessionCommandable(state: SessionState): boolean {
  // line 96
  return isCommandableSessionStatus(state.snapshot().status);
}

function assertSessionCommandable(state: SessionState): void {
  // line 100
  if (!isSessionCommandable(state)) {
    throw makeCliError(ERROR_CODES.SESSION_NOT_RUNNING, {
      message: 'Session is not running.',
    });
  }
}

function resolveHostRendererName(input: string | undefined): RendererName {
  // line 116
  const rawRenderer =
    input ??
    process.env[HOST_RENDERER_ENV_KEY] ??
    process.env.AGENT_TTY_RENDERER ??
    DEFAULT_RENDERER_NAME;
  try {
    return resolveRendererName(rawRenderer);
  } catch (error) {
    throw makeCliError(ERROR_CODES.INVALID_INPUT, {
      message: 'Renderer must be one of: ghostty-web, libghostty-vt.',
      details: { renderer: rawRenderer },
      cause: error,
    });
  }
}
```

Relevant imports already in `hostMain.ts`:

- `SessionState` from `./sessionState.js` (line 15)
- `isCommandableSessionStatus` from `../protocol/sessionStatusPolicy.js` (line 20)
  — a pure predicate: `isCommandableSessionStatus(status: SessionStatus): boolean`
  (`src/protocol/sessionStatusPolicy.ts:111`). Commandable statuses are the
  `running`-family per `CONTEXT.md` ("A `running` Session is Commandable"; an
  `exiting`/`destroying`/terminal Session is not).
- `resolveRendererName`, `DEFAULT_RENDERER_NAME`, `RendererName` (lines 42-44),
  `HOST_RENDERER_ENV_KEY` (line 40), `ERROR_CODES`/`makeCliError` (line 19).

### Conventions to follow

- Tests use **vitest** (`describe`/`it`/`expect`). See the existing host tests
  in `test/unit/host/` for structure — `runCompletionCoordinator.test.ts` and
  `eventLog.test.ts` are substantial, idiomatic examples.
- To build a `SessionState` test double for the commandability tests, **model on
  `test/unit/commands/gc.test.ts`**, which already constructs `SessionState`
  instances — reuse that exact construction shape rather than inventing one.
- Asserting a thrown `CliError`: check the `.code` against `ERROR_CODES` (e.g.
  `ERROR_CODES.SESSION_NOT_RUNNING`, `ERROR_CODES.INVALID_INPUT`). Look at an
  existing test that asserts on a thrown `CliError` for the pattern.
- When a test mutates `process.env`, save and restore it (`beforeEach`/
  `afterEach`) so it doesn't leak into other tests.
- Strict TS, NodeNext ESM, `.js` import extensions, `import type` for types.
- Exporting an internal helper purely for testing is an accepted pattern here —
  `MAX_CONSECUTIVE_POLL_FAILURES` is already exported for exactly that reason.

## Commands you will need

| Purpose               | Command                                          | Expected |
| --------------------- | ------------------------------------------------ | -------- |
| Typecheck             | `npm run typecheck`                              | exit 0   |
| Lint                  | `npm run lint`                                   | exit 0   |
| Run the new unit test | `npx vitest run test/unit/host/hostMain.test.ts` | all pass |
| Unit suite            | `npm run test:unit`                              | all pass |
| Integration suite     | `npm run test:integration`                       | all pass |

## Scope

**In scope**:

- `src/host/hostMain.ts` — add `export` to the four pure helpers only
  (`normalizeExitSignal`, `isSessionCommandable`, `assertSessionCommandable`,
  `resolveHostRendererName`). No logic changes.
- `test/unit/host/hostMain.test.ts` — expand with the new unit tests.
- `test/integration/` — one new test for the idle-timeout path (Step 3), or a
  case added to `test/integration/lifecycle.test.ts`.

**Out of scope**:

- Any behavior change in `hostMain.ts`. This plan only **adds `export`** and
  **adds tests**. If you find yourself changing logic, stop.
- Refactoring `runHost` or extracting the inner closures (that is plan 006's
  territory, and not required here).
- `CHANGELOG.md` (automation-owned).
- The protocol schemas / CLI envelopes.

## Git workflow

- Branch: `advisor/004-hostmain-characterization-tests`
- Conventional Commits. Example: `test: characterize hostMain decision helpers and idle-timeout exit`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Export the four pure helpers

In `src/host/hostMain.ts`, add the `export` keyword to `normalizeExitSignal`
(line 87), `isSessionCommandable` (96), `assertSessionCommandable` (100), and
`resolveHostRendererName` (116). Change nothing else.

**Verify**: `npm run typecheck` → exit 0. `npm run lint` → exit 0.

### Step 2: Unit-test the helpers

Rewrite `test/unit/host/hostMain.test.ts` to keep the existing
`MAX_CONSECUTIVE_POLL_FAILURES` assertion and add `describe` blocks:

- **`normalizeExitSignal`**:
  - `null` → `null`
  - `0` → `null`
  - `9` → `'9'`, `15` → `'15'`
  - a negative or non-integer signal → throws (invariant). Assert it throws.
- **`isSessionCommandable` / `assertSessionCommandable`** (build `SessionState`
  per `test/unit/commands/gc.test.ts`):
  - a `running` SessionState → `isSessionCommandable` is `true`;
    `assertSessionCommandable` does not throw.
  - a terminal/`exited` (and an `exiting`) SessionState → `isSessionCommandable`
    is `false`; `assertSessionCommandable` throws a `CliError` with code
    `ERROR_CODES.SESSION_NOT_RUNNING` and message `'Session is not running.'`.
- **`resolveHostRendererName`** (save/restore `process.env` around each case):
  - explicit input `'libghostty-vt'` → resolves to that name.
  - input `undefined` with `HOST_RENDERER_ENV_KEY` set → resolves from the env var.
  - input `undefined`, no env → resolves to `DEFAULT_RENDERER_NAME`.
  - an invalid name (e.g. `'nope'`) → throws a `CliError` with code
    `ERROR_CODES.INVALID_INPUT`.

**Verify**: `npx vitest run test/unit/host/hostMain.test.ts` → all pass
(the original constant test plus the new ones).

### Step 3: Integration-test the idle-timeout exit branch

`create` exposes `--idle-timeout-ms <ms>` (`src/cli/main.ts:326`). Add a test
(model on `test/integration/lifecycle.test.ts`, which already drives `create`/
`inspect`/`destroy` against an isolated absolute `AGENT_TTY_HOME`):

- Create a session with a small idle timeout (pick a value comfortably above the
  internal idle-check cadence — note `IDLE_CHECK_CAP_MS = 5_000` in
  `hostMain.ts`, so the poll cadence is bounded at 5s; choose a timeout and a
  wait that are robust to that, e.g. a timeout of a few hundred ms and then poll
  `inspect` until the status is terminal, with a generous overall deadline).
- Assert the session reaches a terminal status (`exited`) via `inspect --json`
  without any further input.
- Use the same isolated-home setup/teardown as the neighboring tests; never
  touch the real `~/.agent-tty`.

If the idle-timeout behavior is not cleanly observable via `inspect` within a
reasonable, non-flaky wait, **stop and report** (see STOP conditions) rather
than adding a sleep-and-hope test — the unit tests in Step 2 are the required
core; this integration test is the bonus branch.

**Verify**: `npx vitest run test/integration/<your-file>.test.ts` → passes.
Run it a second time to confirm it is not flaky.

### Step 4: Full static + suites

`npm run lint`, `npm run typecheck`, `npm run test:unit`, then
`npm run test:integration` → all green.

## Test plan

- New unit cases (Step 2): `normalizeExitSignal` (4+ cases incl. throw),
  commandability predicate + assertion (running / exiting / terminal),
  renderer-name resolution (explicit / env / default / invalid-throws).
- New integration case (Step 3): idle-timeout auto-exit observed via `inspect`.
- Structural patterns: unit → model on `test/unit/host/runCompletionCoordinator.test.ts`
  and `test/unit/commands/gc.test.ts` (for `SessionState`); integration → model
  on `test/integration/lifecycle.test.ts`.
- Verification: `npm run test:unit` and `npm run test:integration` both pass,
  including the new cases.

## Done criteria

ALL must hold:

- [ ] `grep -nE "^export function (normalizeExitSignal|isSessionCommandable|assertSessionCommandable|resolveHostRendererName)" src/host/hostMain.ts` → 4 matches.
- [ ] `npx vitest run test/unit/host/hostMain.test.ts` passes with the new cases
      (and still asserts `MAX_CONSECUTIVE_POLL_FAILURES === 10`).
- [ ] `npm run test:unit` and `npm run test:integration` exit 0.
- [ ] `npm run typecheck` and `npm run lint` exit 0.
- [ ] `git diff src/host/hostMain.ts` shows **only** added `export` keywords (no
      logic change).
- [ ] No `CHANGELOG.md` change; no files outside scope modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back if:

- The four helpers are no longer at the cited lines / no longer match the
  excerpts (drift).
- Building a `SessionState` for the commandability tests requires more than the
  shape used in `test/unit/commands/gc.test.ts` (e.g. a live PTY) — report and
  scope those two cases out rather than constructing a heavy fake.
- The idle-timeout integration test (Step 3) can only be made to pass with a
  fixed `sleep` and is flaky on a second run — drop Step 3, keep Steps 1–2, and
  report that Step 3 needs a deterministic hook.
- Asserting a thrown `CliError`'s `.code` doesn't work as described (the error
  shape differs) — report the actual shape.

## Maintenance notes

- These are characterization tests: they pin **current** behavior. If a future
  change intentionally alters, say, commandability rules, the test should be
  updated deliberately in the same change — a failure here on an unrelated PR is
  a real regression signal.
- The deeper orchestration branches inside `runHost` (renderer-poll-failure
  recovery, shutdown reconciliation, concurrent-wait handling) remain
  unit-untestable without extracting them from the closure. That extraction is
  deliberately **not** in this plan; it's a candidate follow-up that would pair
  well with plan 006's refactoring approach.
