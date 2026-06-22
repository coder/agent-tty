# Plan 008: the screen-hash agreement test compares two captures of a settled screen, not a changing one

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 5cb9a20..HEAD -- test/integration/screen-hash.test.ts src/cli/commands/snapshot.ts src/cli/commands/wait.ts src/renderer/canonicalScreen.ts src/snapshot/capture.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug (test correctness)
- **Planned at**: commit `5cb9a20`, 2026-06-22

## Why this matters

`test/integration/screen-hash.test.ts` has one test —
**"agrees on screenHash between structured and text snapshots of the same
screen"** — that fails **deterministically** in any environment where CLI
process-spawn latency happens to straddle the session's 1-second
`booting`→`Ready` transition (confirmed failing locally and by a prior audit run
on commit `c11e2e2`; it passes in CI only by timing luck). A test that is red on
some machines and green on others, with no code change between them, trains
maintainers to ignore failures and is latent CI breakage.

The failure is **not** a production bug. The test's own comment and `CONTEXT.md`
say structured and text snapshots of the _same_ screen must produce the same
`screenHash`, and the production code upholds that: `computeScreenHash` derives
the hash from one snapshot's `visibleLines` only, and a single `snapshot` call
hashes exactly one captured screen. The bug is in the **test**: it takes **two
separate `snapshot` CLI invocations** (one structured, one text) with nothing
forcing them to observe the same screen, on a session deliberately built to
change its screen 1 second in — so the two captures can land on different screens
("booting" vs. "booting\nReady"), yielding different (but individually correct)
hashes.

This plan fixes the test to settle the screen before the two captures, so they
observe the same content and the cross-format agreement is tested honestly. **No
production code changes.**

## Current state

### The session and the unsettled `beforeEach`

`test/integration/screen-hash.test.ts:26-30` — the session prints `booting`,
sleeps 1s, prints `Ready`, then idles forever on `cat`:

```ts
const SESSION_COMMAND = [
  '/bin/sh',
  '-c',
  "printf 'booting\\n'; sleep 1; printf 'Ready\\n'; exec cat",
] as const;
```

`test/integration/screen-hash.test.ts:82-87` — `beforeEach` only waits for the
**`booting`** marker, i.e. it returns while the screen still shows just
"booting", a full second before "Ready" appears:

```ts
beforeEach(async () => {
  // oxfmt-ignore
  testHome = await realpath(
    await mkdtemp(join(tmpdir(), 'agent-tty-screen-hash-')),
  );
  sessionId = createSession(testHome, [...SESSION_COMMAND]);
  await waitForOutputMarker(testHome, sessionId, 'booting');
}, HOOK_TIMEOUT_MS);
```

(`waitForOutputMarker`, defined at `:38-76`, waits for a `wait --idle-ms 200`
and then polls the **event log** for the marker text — it does not settle the
_rendered_ screen, and it returns as soon as "booting" is in the log.)

### The failing test — two captures, no settle

`test/integration/screen-hash.test.ts:128-153`:

```ts
it('agrees on screenHash between structured and text snapshots of the same screen', () => {
  const structured = runCli(
    ['snapshot', sessionId, '--format', 'structured', '--json'],
    { AGENT_TTY_HOME: testHome },
    20_000,
  );
  const text = runCli(
    ['snapshot', sessionId, '--format', 'text', '--json'],
    { AGENT_TTY_HOME: testHome },
    20_000,
  );

  expect(structured.status).toBe(0);
  expect(text.status).toBe(0);
  const structuredEnvelope = JSON.parse(
    structured.stdout,
  ) as SuccessEnvelope<StructuredSnapshot>;
  const textEnvelope = JSON.parse(text.stdout) as SuccessEnvelope<TextSnapshot>;

  expect(structuredEnvelope.result.screenHash).toMatch(SHA_256_HEX);
  expect(textEnvelope.result.screenHash).toBe(
    structuredEnvelope.result.screenHash,
  );
});
```

The two `runCli` calls are separate `agent-tty` processes run back-to-back. If
the first captures before the 1s `Ready` print and the second captures after it,
their `visibleLines` differ → their hashes differ → the `toBe` at `:150` fails.

### Why this is a test bug, not a renderer bug (do not "fix" the renderer)

- `src/cli/commands/snapshot.ts` has **no flag to pin a capture to an event-log
  sequence**; every `snapshot` captures the _latest_ screen at call time.
- The same command passes `options.context.rendererDefault` for **both** formats
  (`snapshot.ts:84-103` and `:182-253`) — the format does **not** select a
  different renderer backend, so this is not a cross-backend divergence.
- `src/snapshot/capture.ts:38` computes **one** `screenHash` per capture, and
  `src/renderer/canonicalScreen.ts:39-41` derives it from `visibleLines` text
  only. Structured vs. text of the _same_ captured snapshot are therefore equal
  by construction. The only way two hashes differ is two **different captured
  screens** — i.e. the screen changed between the two CLI calls.

### Reference: how the file already settles screens correctly

Other tests in the same file wait for the rendered `Ready` and/or screen
stability before asserting — mirror their style:

- `:155-159` matched render wait: `wait <id> --text Ready --timeout 15000 --json`.
- `:210-222` offline fallback: `wait <id> --screen-stable-ms 1000 --timeout 5000 --json`.

The `wait` command supports combining `--text` and `--screen-stable-ms` in one
render wait (they are both render-wait conditions; only `--text`/`--regex` are
mutually exclusive, and render flags must not be mixed with the legacy
`--idle-ms`/`--exit` flags — see `src/cli/commands/wait.ts:58-67,176-188`).

## Commands you will need

| Purpose      | Command                                                              | Expected on success                                                                                                              |
| ------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Install deps | `aube install`                                                       | exit 0                                                                                                                           |
| Typecheck    | `npm run typecheck`                                                  | exit 0, no errors                                                                                                                |
| Lint         | `npm run lint`                                                       | exit 0                                                                                                                           |
| Format (fix) | `npm run format`                                                     | exit 0                                                                                                                           |
| The one test | `npx vitest run --maxWorkers=1 test/integration/screen-hash.test.ts` | all pass (incl. the agreement test) — do NOT use `npm run test`/`test:integration` (they add `--retry=2`, which masks flakiness) |

(`aube` is the package manager — do not use `npm install`.)

This test drives a **real PTY host and renderer**. In some sandboxes `create`/
`run` fail with `HOST_UNREACHABLE` and the whole file errors rather than
asserting. If that happens to you, see the first STOP condition — do not paper
over it.

## Scope

**In scope** (the only file you should modify):

- `test/integration/screen-hash.test.ts` — settle the screen inside the
  agreement test before the two captures.

**Out of scope** (do NOT touch — the production code is correct):

- `src/renderer/canonicalScreen.ts`, `src/renderer/libghosttyVt/backend.ts`,
  `src/renderer/ghosttyWeb/backend.ts`, `src/snapshot/capture.ts`,
  `src/cli/commands/snapshot.ts` — the hash is single-sourced and correct; the
  fix is purely in the test.
- The other tests in `screen-hash.test.ts` (`:96-126`, `:155-233`) — they already
  settle correctly; don't change them.
- `CHANGELOG.md` — automation-owned; never edit it in a change.
- Do **not** add a `--at-seq`/sequence-pinning flag to `snapshot` — that is a
  larger feature, out of scope here, and not needed: settling the screen makes
  back-to-back captures observe identical `visibleLines`.

## Git workflow

- Branch: `advisor/008-fix-screen-hash-agreement-test`
- Commit message style: Conventional Commits. Example:
  `test: settle the screen before comparing structured/text screen hashes`.
  (Type `test:` is appropriate — this is a test-only change.)
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Settle the rendered screen before the two captures

In the **"agrees on screenHash…"** test (`:128`), before the `structured` capture,
add a render wait that blocks until `Ready` is on the rendered screen **and** the
screen has been stable for a short window. Because the session runs `exec cat`
after printing `Ready`, no further output arrives, so once stable it stays
identical — guaranteeing both subsequent captures observe the same `visibleLines`.

Insert at the top of the test body (before `const structured = ...`):

```ts
// Settle the rendered screen: wait until `Ready` is visible AND the screen
// has been stable, so the two independent snapshot captures below observe
// the SAME screen. Without this, the structured capture can land before the
// 1s `Ready` print and the text capture after it, yielding two correct-but-
// different hashes (see SESSION_COMMAND).
const settle = runCli(
  [
    'wait',
    sessionId,
    '--text',
    'Ready',
    '--screen-stable-ms',
    '500',
    '--timeout',
    '15000',
    '--json',
  ],
  { AGENT_TTY_HOME: testHome },
  20_000,
);
expect(settle.status).toBe(0);
const settleEnvelope = JSON.parse(
  settle.stdout,
) as SuccessEnvelope<WaitForRenderResult>;
expect(settleEnvelope.ok).toBe(true);
expect(settleEnvelope.result.matched).toBe(true);
expect(settleEnvelope.result.timedOut).toBe(false);
```

Notes for the executor:

- `WaitForRenderResult` and `SuccessEnvelope` are already imported at the top of
  this file (`:7-22`) — no new imports needed. If `WaitForRenderResult` is not in
  the existing import list, add it to the `import type { … } from
'../../src/protocol/messages.js'` block.
- Leave the rest of the test (the two `snapshot` calls and the hash assertions at
  `:149-152`) unchanged. With the screen settled, `:150`'s `toBe` now holds.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Run the test file (raw vitest — no retry masking)

**Verify with raw vitest, not the `npm run` test scripts.** The repo's
`test`/`test:integration` scripts add `--retry=2` (see `package.json`), which
silently re-runs a failing test and would hand you a false green on a fix that is
still flaky. Run the file directly and **3 times** to confirm the fix is stable,
not lucky:

`for i in 1 2 3; do npx vitest run --maxWorkers=1 test/integration/screen-hash.test.ts || { echo "RUN $i FAILED"; break; }; done`

→ **all three** runs pass, including "agrees on screenHash between structured and
text snapshots of the same screen". (`--maxWorkers=1` matches how the repo runs
integration tests — one real PTY host at a time.) If any run fails, the fix is
not yet deterministic: see STOP conditions — do **not** switch to the
`--retry`-wrapped scripts to get green.

### Step 3: Format and lint

Run `npm run format` then `npm run lint` → both exit 0.

`npm run format` is `oxfmt . --write` — it formats the whole tree. It should
rewrite **only** your edited test file (everything else is already formatted on
`main`). If `git status` shows it touched any other file, that file was
mis-formatted before you started: STOP and report it rather than committing
unrelated reformatting (it would break the "only the test file changed" done
criterion).

## Test plan

This plan _is_ a test fix; no new test file. The verification is that the existing
suite — specifically the agreement test — passes deterministically:

- `npx vitest run --maxWorkers=1 test/integration/screen-hash.test.ts` passes
  **3/3 runs** (raw vitest — see Step 2 on why not the `--retry` scripts).
- The other four tests in the file still pass (you changed only the agreement
  test's body: the settle block plus the existing, unchanged assertions).

Keep the change minimal — the Step 1 settle block is the **only** addition. Do
not add further assertions under this plan; a stronger `capturedAtSeq`-equality
check is listed under Maintenance notes as a deliberate, separate follow-up.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0.
- [ ] `npm run lint` exits 0.
- [ ] `npm run format:check` exits 0.
- [ ] `npx vitest run --maxWorkers=1 test/integration/screen-hash.test.ts` passes
      **3 consecutive runs** — raw vitest, **not** the `--retry`-wrapped `npm run`
      scripts — including the "agrees on screenHash…" test.
- [ ] `git diff --stat` shows **only** `test/integration/screen-hash.test.ts`
      changed (no production files).
- [ ] `plans/README.md` status row for 008 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- `create`/`run`/`wait` fail with `HOST_UNREACHABLE` (or the test file errors
  before any assertion) in your environment — you cannot validate the fix here.
  Report that the change is written but unverifiable in this sandbox, and name
  the next best check (run on a real TTY / CI). Do **not** mark done.
- The settle `wait` returns `matched: false` or `timedOut: true` even after the
  full 15s timeout — that would mean `Ready` never renders or never stabilizes,
  which contradicts `SESSION_COMMAND`; report rather than loosening the wait.
- The agreement test still fails after Step 1 with **structured == text in
  visibleLines but different hashes** — that would indicate a genuine production
  hash bug (contradicting this plan's analysis); STOP and report, do not edit
  renderer/snapshot code under this plan.
- The "Current state" excerpts don't match the live file (drift since `5cb9a20`).

## Maintenance notes

- A reviewer should confirm the change is **test-only** and that the fix settles
  the _rendered_ screen (a render `wait` with `--screen-stable-ms`), not just the
  event log (the old `waitForOutputMarker` helper polls the log and does not prove
  the rendered screen stopped changing).
- Root cause to remember: `snapshot` always captures the _latest_ screen and has
  no sequence-pinning flag, so any test comparing two independent captures must
  first settle the screen. If a future test compares captures across formats or
  renderers, apply the same settle-first pattern.
- Deferred (and why): adding a `snapshot --at-seq <n>` flag would let two captures
  target the exact same sequence and make such tests robust without a settle wait.
  That is a real feature idea but out of scope for a test fix; note it for the
  maintainer rather than building it here.
- Optional future strengthening (intentionally **not** done here, to keep this
  change minimal): once the screen is settled, the two captures observe the same
  event sequence, so
  `structuredEnvelope.result.capturedAtSeq === textEnvelope.result.capturedAtSeq`
  holds deterministically and could be asserted as an invariant stronger than hash
  equality. Both snapshot result variants carry `capturedAtSeq`
  (`src/snapshot/capture.ts:42,46`), so it would typecheck.
