# Plan 005: Both renderer backends iterate replay events through one shared, tested helper

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c11e2e2..HEAD -- src/renderer/ghosttyWeb/backend.ts src/renderer/libghosttyVt/backend.ts`
> If either backend changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `c11e2e2`, 2026-06-16

## Why this matters

The two renderer backends — `ghosttyWeb` (visual/Playwright) and `libghosttyVt`
(native semantic) — each re-implement the **same** replay-event iteration:
validate each event's sequence is a non-negative integer, enforce strictly
increasing order, skip events already applied (`seq <= lastAppliedSeq`), stop at
the target (`seq > targetSeq`), then dispatch on event type. This logic is
correctness-critical: per the architecture's tiered-truth model, both backends
must converge on the **same** visible screen content and Screen Hash for the
same event log. The two copies have **already drifted** — different assertion
messages, and `ghosttyWeb` flushes its output batch before breaking while
`libghosttyVt` just breaks — which is exactly how a subtle divergence creeps in.
Extracting the shared iteration into one tested helper removes the duplication
and gives the seq/ordering invariants a single home.

## Current state

Both `replayTo` methods contain a near-identical loop. The shared part is the
**per-event validation + filtering scaffolding**; each backend keeps its own
_feed_ strategy (ghosttyWeb batches output and awaits async bridge calls;
libghosttyVt feeds synchronously).

**`src/renderer/ghosttyWeb/backend.ts:1602-1664`** (async, batched output;
note the flush at 1618 before the targetSeq break and the unconditional flush at
1664 after the loop):

```ts
for (const event of input.events) {
  assertNonNegativeInteger(
    event.seq,
    'replay event seq must be a non-negative integer',
  );
  invariant(
    event.seq > previousEventSeq,
    'replay events must be ordered by strictly increasing seq values',
  );
  previousEventSeq = event.seq;

  if (event.seq <= this.lastAppliedSeq) {
    continue;
  }
  if (event.seq > input.targetSeq) {
    await flushOutputBatch();
    break;
  }

  switch (event.type) {
    case 'output': {
      pendingOutputChunks.push(event.payload.data);
      break;
    }
    case 'resize': {
      await flushOutputBatch();
      /* assert + resizeBridge + set cols/rows */ break;
    }
    case 'marker': {
      await flushOutputBatch();
      break;
    }
    case 'input_text':
    case 'input_paste':
    case 'input_keys':
    case 'input_run':
    case 'run_complete':
    case 'signal':
    case 'exit': {
      await flushOutputBatch();
      break;
    }
    default: {
      unreachable(event, 'unsupported replay event type');
    }
  }
  highestProcessedSeq = event.seq;
}

await flushOutputBatch(); // line 1664 — flushes any pending output after the loop
```

**`src/renderer/libghosttyVt/backend.ts:486-535`** (synchronous feed):

```ts
for (const event of input.events) {
  assertNonNegativeInteger(event.seq, 'replay event seq must be non-negative');
  invariant(
    event.seq > previousEventSeq,
    'replay events must be ordered by strictly increasing seq values',
  );
  previousEventSeq = event.seq;

  if (event.seq <= this.lastAppliedSeq) {
    continue;
  }
  if (event.seq > input.targetSeq) {
    break;
  }

  switch (event.type) {
    case 'output':
      terminal.feed(event.payload.data);
      break;
    case 'resize':
      /* assert + terminal.resize + set cols/rows */ break;
    case 'marker':
    case 'input_text':
    case 'input_paste':
    case 'input_keys':
    case 'input_run':
    case 'run_complete':
    case 'signal':
    case 'exit':
      break;
    default:
      unreachable(event, 'unsupported replay event type');
  }
  highestProcessedSeq = event.seq;
}
```

Both surround the loop with: `let previousEventSeq = -1; let highestProcessedSeq
= this.lastAppliedSeq;` before, and after the loop the
`if (highestProcessedSeq < 0) { highestProcessedSeq = input.targetSeq; }` +
`this.lastAppliedSeq = highestProcessedSeq;` sequence.

**Critical detail — `previousEventSeq` is updated BEFORE the skip/stop checks**
in both, so the strictly-increasing invariant covers _every_ event, including
skipped ones. The shared helper must preserve that exact order.

### Types and conventions

- `ReplayInput` is exported from `src/renderer/types.ts`. The event element type
  is `ReplayInput['events'][number]` — use that indexed type so you don't depend
  on the exact exported name.
- `invariant` is in `src/util/assert.ts`. `unreachable(value, message)` (same
  module) is used for the exhaustive `default` — leave each backend's `default:
unreachable(...)` in place; it belongs with the type switch, not the iterator.
- Strict TS, NodeNext ESM, `.js` import extensions, `import type` for types.
- 2-space indent, single quotes, trailing commas (oxfmt enforces).

### Design constraint (honor this)

From `design/ARCHITECTURE.md` (tiered-truth model): semantic-renderer truth and
reference-visual truth must agree on visible content. The `CONTEXT.md` Screen
Hash term states the Screen Hash is computed from the same canonical visible
text the stability check and text waits use, "so the three never disagree." Any
change to replay iteration must keep both backends producing identical visible
content for the same events — that is what `test/integration/screen-hash.test.ts`
guards.

## Commands you will need

| Purpose             | Command                                                           | Expected |
| ------------------- | ----------------------------------------------------------------- | -------- |
| Typecheck           | `npm run typecheck`                                               | exit 0   |
| Lint                | `npm run lint`                                                    | exit 0   |
| Replay unit tests   | `npx vitest run test/unit/host/replay.test.ts test/unit/renderer` | all pass |
| New helper test     | `npx vitest run test/unit/renderer/replayEvents.test.ts`          | all pass |
| Screen-hash conv.   | `npx vitest run test/integration/screen-hash.test.ts`             | all pass |
| e2e (cross-backend) | `npm run test:e2e`                                                | all pass |

## Scope

**In scope**:

- `src/renderer/replayEvents.ts` (create) — the shared iterator helper.
- `src/renderer/ghosttyWeb/backend.ts` — use the helper in `replayTo`.
- `src/renderer/libghosttyVt/backend.ts` — use the helper in `replayTo`.
- `test/unit/renderer/replayEvents.test.ts` (create) — unit-test the helper.

**Out of scope** (do NOT change behavior here):

- The output-feed strategy in either backend (ghosttyWeb's batching +
  `flushOutputBatch`; libghosttyVt's synchronous `terminal.feed`). Keep every
  existing `await flushOutputBatch()` call site in ghosttyWeb intact.
- The `highestProcessedSeq` tracking and the `< 0 → targetSeq` fallback and
  `this.lastAppliedSeq = …` assignment — leave these in each backend unchanged.
- The pre-loop input validation (`assertPositiveInteger` on initial dims,
  `targetSeq` checks, the no-rewind invariant with its backend-specific message).
- `replayWithTiming` (ghosttyWeb) — only `replayTo` is in scope.
- `CHANGELOG.md` (automation-owned).

## Git workflow

- Branch: `advisor/005-dedupe-replay-event-iteration`
- Conventional Commits. Example: `refactor: share replay-event iteration across renderer backends`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Create the shared iterator

Create `src/renderer/replayEvents.ts`:

```ts
import type { ReplayInput } from './types.js';
import { invariant } from '../util/assert.js';

type ReplayEvent = ReplayInput['events'][number];

/**
 * Yield the replay events that fall in the half-open range
 * (lastAppliedSeq, targetSeq], in order. Enforces the seq invariants shared by
 * every renderer backend: each event seq is a non-negative integer, seqs are
 * strictly increasing across ALL events (including skipped ones), events at or
 * below lastAppliedSeq are skipped, and iteration stops at the first event
 * beyond targetSeq. Callers dispatch on event.type and own how output is fed.
 */
export function* iterateInRangeReplayEvents(
  input: ReplayInput,
  lastAppliedSeq: number,
): Generator<ReplayEvent> {
  let previousEventSeq = -1;
  for (const event of input.events) {
    invariant(
      Number.isInteger(event.seq) && event.seq >= 0,
      'replay event seq must be a non-negative integer',
    );
    invariant(
      event.seq > previousEventSeq,
      'replay events must be ordered by strictly increasing seq values',
    );
    previousEventSeq = event.seq;

    if (event.seq <= lastAppliedSeq) {
      continue;
    }
    if (event.seq > input.targetSeq) {
      return;
    }
    yield event;
  }
}
```

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Use the helper in `libghosttyVt` (the simpler, synchronous backend first)

In `src/renderer/libghosttyVt/backend.ts` `replayTo`, replace the
`for (const event of input.events) { …validation…; if skip; if break; switch }`
loop with:

```ts
for (const event of iterateInRangeReplayEvents(input, this.lastAppliedSeq)) {
  switch (event.type) {
    case 'output':
      terminal.feed(event.payload.data);
      break;
    case 'resize':
      assertPositiveInteger(
        event.payload.cols,
        'resize event cols must be positive',
      );
      assertPositiveInteger(
        event.payload.rows,
        'resize event rows must be positive',
      );
      terminal.resize(event.payload.cols, event.payload.rows);
      this.currentCols = event.payload.cols;
      this.currentRows = event.payload.rows;
      break;
    case 'marker':
    case 'input_text':
    case 'input_paste':
    case 'input_keys':
    case 'input_run':
    case 'run_complete':
    case 'signal':
    case 'exit':
      break;
    default:
      unreachable(event, 'unsupported replay event type');
  }
  highestProcessedSeq = event.seq;
}
```

Keep `let previousEventSeq = -1;` removed only if it is now unused (the helper
owns it) — delete the now-dead `previousEventSeq` declaration and assignment.
Keep `highestProcessedSeq` and everything after the loop unchanged. Add the
import: `import { iterateInRangeReplayEvents } from '../replayEvents.js';`.

**Verify**: `npm run typecheck` → exit 0;
`npx vitest run test/unit/host/replay.test.ts test/unit/renderer` → all pass.

### Step 3: Use the helper in `ghosttyWeb` (preserve every flush)

In `src/renderer/ghosttyWeb/backend.ts` `replayTo`, replace the loop the same
way, **keeping all `await flushOutputBatch()` calls inside the switch and the
one after the loop (current line 1664)**. The targetSeq break previously flushed
then broke (line 1618); the helper now stops iteration at that boundary and the
post-loop `await flushOutputBatch()` (1664) flushes any pending output — net
behavior identical. Result:

```ts
for (const event of iterateInRangeReplayEvents(input, this.lastAppliedSeq)) {
  switch (event.type) {
    case 'output': {
      pendingOutputChunks.push(event.payload.data);
      break;
    }
    case 'resize': {
      await flushOutputBatch();
      assertPositiveInteger(
        event.payload.cols,
        'resize event cols must be a positive integer',
      );
      assertPositiveInteger(
        event.payload.rows,
        'resize event rows must be a positive integer',
      );
      await this.resizeBridge(page, event.payload.cols, event.payload.rows);
      this.currentCols = event.payload.cols;
      this.currentRows = event.payload.rows;
      break;
    }
    case 'marker': {
      await flushOutputBatch();
      break;
    }
    case 'input_text':
    case 'input_paste':
    case 'input_keys':
    case 'input_run':
    case 'run_complete':
    case 'signal':
    case 'exit': {
      await flushOutputBatch();
      break;
    }
    default: {
      unreachable(event, 'unsupported replay event type');
    }
  }
  highestProcessedSeq = event.seq;
}

await flushOutputBatch();
```

Delete the now-dead `previousEventSeq` declaration. Add the import:
`import { iterateInRangeReplayEvents } from '../replayEvents.js';`. Leave
`highestProcessedSeq`, the `< 0 → targetSeq` fallback, snapshot read, and return
unchanged.

**Verify**: `npm run typecheck` → exit 0.

### Step 4: Cross-backend behavior gates

Run the convergence and visual suites — these are the real safety net:

- `npx vitest run test/integration/screen-hash.test.ts` → all pass (both
  backends still produce the same canonical visible text / Screen Hash).
- `npm run test:e2e` → all pass (rendered output, screenshots, casts unchanged).
  If e2e cannot run in this environment, say so explicitly in your report.

**Verify**: screen-hash convergence and e2e both green.

## Test plan

- New unit test `test/unit/renderer/replayEvents.test.ts` for
  `iterateInRangeReplayEvents`, covering:
  - all events in range → yields all, in order.
  - events with `seq <= lastAppliedSeq` → skipped (not yielded).
  - an event with `seq > targetSeq` → iteration stops there (it and everything
    after are not yielded).
  - out-of-order seq (e.g. `[0,2,1]`) → throws the strictly-increasing invariant.
  - a negative / non-integer seq → throws the non-negative-integer invariant.
  - the strictly-increasing check fires even when the offending event would be
    skipped (e.g. lastAppliedSeq high, but a later event repeats an earlier seq).
- Regression coverage is the existing `test/unit/host/replay.test.ts`,
  `test/unit/renderer/*`, `test/integration/screen-hash.test.ts`, and e2e — they
  must stay green with no edits.

## Done criteria

ALL must hold:

- [ ] `src/renderer/replayEvents.ts` exists and exports `iterateInRangeReplayEvents`.
- [ ] Both backends' `replayTo` import and use it;
      `grep -n "iterateInRangeReplayEvents" src/renderer/ghosttyWeb/backend.ts src/renderer/libghosttyVt/backend.ts` → 2+ matches.
- [ ] `grep -n "previousEventSeq" src/renderer/ghosttyWeb/backend.ts src/renderer/libghosttyVt/backend.ts` → no matches (dead declarations removed).
- [ ] `npm run typecheck` and `npm run lint` exit 0.
- [ ] `npx vitest run test/unit/renderer/replayEvents.test.ts` passes (new cases).
- [ ] `npx vitest run test/unit/host/replay.test.ts test/unit/renderer` passes.
- [ ] `npx vitest run test/integration/screen-hash.test.ts` passes.
- [ ] `npm run test:e2e` passes (or its inability to run here is reported).
- [ ] No `CHANGELOG.md` change; no out-of-scope files modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back (do not improvise) if:

- Either backend's loop no longer matches the "Current state" excerpts (drift).
- `test/integration/screen-hash.test.ts` fails after the change — that means the
  backends diverged; do NOT adjust the test to pass. Report the diff.
- Removing a flush or reordering one in ghosttyWeb seems necessary to make the
  helper fit — it isn't; keep every flush. If you can't preserve them, stop.
- e2e output (screenshots/casts) changes — that's a behavior regression, not a
  refactor; report it.

## Maintenance notes

- The helper is the single home for replay seq/ordering invariants. Future event
  types must be added to each backend's `switch` (the exhaustive `default:
unreachable` will flag a missing case at type-check time) — the iterator does
  not need changes for new event types.
- A reviewer should confirm: (1) `previousEventSeq` updates before the skip in
  the helper (covers skipped events); (2) ghosttyWeb still flushes after the loop;
  (3) `lastAppliedSeq`/`highestProcessedSeq` math is untouched in both backends.
- Deferred: the pre-loop input validation and the `highestProcessedSeq` fallback
  are also duplicated but were intentionally left in place to bound this change's
  risk; consolidating them is a possible follow-up once this lands cleanly.
