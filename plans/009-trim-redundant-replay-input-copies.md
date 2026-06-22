# Plan 009: stop re-copying and re-validating the whole event log on every snapshot / wait

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 5cb9a20..HEAD -- src/host/hostMain.ts src/host/replay.ts src/renderer/libghosttyVt/backend.ts test/unit/host/replay.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.
>
> **Safety-invariant drift check (also run first)**: this optimization is only
> safe because of invariants in four files it does **not** modify. Run
> `git diff --stat 5cb9a20..HEAD -- src/host/eventLog.ts src/renderer/replayEvents.ts src/storage/eventLogCodec.ts src/renderer/ghosttyWeb/backend.ts`
> If any of these changed, re-confirm the facts in "Why dropping these is safe"
> still hold — `EventLog.append` still schema-validates and assigns contiguous
> seqs without mutating records in place (`eventLog.ts`); `iterateInRangeReplayEvents`
> still enforces seq ordering during replay (`replayEvents.ts`); and the
> ghostty-web screenshot fallback still consumes its input read-only
> (`ghosttyWeb/backend.ts`). On any mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW–MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `5cb9a20`, 2026-06-22

## Why this matters

Every `snapshot`, `wait` poll, and `screenshot` on a live session rebuilds the
renderer's replay input from the in-memory event buffer, and that rebuild walks
the **entire** event log up to **three** times:

1. **Spread** — `loadReplayInput` does `const events = [...eventLog.getEvents()]`,
   copying the whole buffer into a new array.
2. **Zod re-parse** — `buildReplayInput` calls `validateEventRecords(events)`,
   which runs `EventRecordSchema.safeParse` on **every** event — even though each
   of those records was already `safeParse`-validated by `EventLog.append` before
   it was buffered.
3. **Deep clone** — the libghostty-vt backend's `replayTo` does
   `this.latestReplayInput = cloneReplayInput(input)`, deep-copying every event
   and its payload on _every_ replay, purely to keep a copy around for the
   occasional screenshot fallback (which reads it read-only).

The event log is capped at 250k events / 50MB. A `wait` polls at ~200ms
intervals, so a wait against a session that has produced a large log re-spreads +
re-Zod-parses + re-clones the full log dozens of times — pure CPU and GC churn
that scales with session length, on the core "drive a TUI and watch the screen"
path the tool exists for. The Zod re-parse (step 2) is the most expensive of the
three.

This plan removes all three redundant passes, replacing them with a single cheap
`Array.slice()` on the live-host path, while keeping full validation on the
offline/disk and export paths (where events are not yet trusted). Behavior is
unchanged; the seq-ordering safety net still runs during replay.

## Current state

### 1. The spread — `src/host/hostMain.ts:188-197`

```ts
const loadReplayInput = (targetSeq?: number) => {
  const events = [...eventLog.getEvents()];
  const replayInput = buildReplayInput(
    sessionId,
    state.snapshot(),
    events,
    targetSeq,
  );
  return replayInput.targetSeq === -1 ? null : replayInput;
};
```

`eventLog.getEvents()` returns `readonly EventRecord[]` (the live internal
buffer). The `[...]` spread exists so the callee can't be handed the mutable
internal array.

### 2. The Zod re-parse — `src/host/replay.ts:14-77` (whole function)

```ts
export function buildReplayInput(
  sessionId: string,
  manifest: SessionRecord,
  events: EventRecord[],
  targetSeq?: number,
): ReplayInput {
  assertNonEmptyString(sessionId, 'sessionId must be a non-empty string');
  // ... manifest validation, initialCols/Rows ...

  const validatedEvents = validateEventRecords(events);

  let lastSeq = -1;
  if (validatedEvents.length > 0) {
    const lastEvent = validatedEvents.at(-1);
    invariant(lastEvent !== undefined, 'last replay event must exist');
    lastSeq = lastEvent.seq;
  }

  const resolvedTargetSeq = targetSeq ?? lastSeq;
  // ... targetSeq invariants (lines 52-68) ...

  return {
    sessionId,
    initialCols,
    initialRows,
    events: validatedEvents,
    targetSeq: resolvedTargetSeq,
  };
}
```

`validateEventRecords` (in `src/storage/eventLogCodec.ts:69-83`) runs
`EventRecordSchema.safeParse` on every event, then `assertContiguousSequence`:

```ts
export function validateEventRecords(
  events: readonly unknown[],
): EventRecord[] {
  const records = events.map((event, index) => {
    const parsedEvent = EventRecordSchema.safeParse(event);
    invariant(
      parsedEvent.success,
      `event log record ${String(index)} must match EventRecordSchema`,
    );
    return parsedEvent.data;
  });
  assertContiguousSequence(records);
  return records;
}
```

It already accepts `readonly unknown[]`, and it returns a **fresh** array
(`events.map(...)`). The three `buildReplayInput` callers are:

- `src/host/hostMain.ts:190` — **live host** (events from `eventLog.getEvents()`,
  already validated on append). **This is the hot path we optimize.**
- `src/replay/offlineReplay.ts:111` — offline replay (events from
  `readEventLogRecords`, read from disk). Keep validating.
- `src/export/webm.ts:142` — webm export (events passed in via options). Keep
  validating.

Why the live-path events are already trusted: `EventLog.append`
(`src/host/eventLog.ts:337-341`) does `EventRecordSchema.safeParse(record)` with
an `invariant` on success **before** pushing into the buffer, and assigns `seq`
sequentially. So `eventLog.getEvents()` only ever contains schema-valid,
contiguously-sequenced records.

### 3. The deep clone — `src/renderer/libghosttyVt/backend.ts`

The clone helper (`:75-86`):

```ts
function cloneReplayInput(input: ReplayInput): ReplayInput {
  return {
    sessionId: input.sessionId,
    initialCols: input.initialCols,
    initialRows: input.initialRows,
    targetSeq: input.targetSeq,
    events: input.events.map((event) => ({
      ...event,
      payload: { ...event.payload },
    })) as ReplayInput['events'],
  };
}
```

Its only call site (`:527`, inside `replayTo`):

```ts
this.lastAppliedSeq = highestProcessedSeq;
this.latestReplayInput = cloneReplayInput(input);
```

`this.latestReplayInput` is consumed only by the screenshot fallback (`:595`):
`await fallback.replayTo(this.latestReplayInput);`. That `fallback` is the
**ghostty-web** backend, and its `replayTo` consumes the input strictly
read-only — it iterates via `iterateInRangeReplayEvents(input, …)`
(`src/renderer/ghosttyWeb/backend.ts:428`) and reads `event.payload`/`event.seq`
without ever reassigning them (its `replayWithTiming` at `:656` is likewise
read-only). This matters specifically for _this_ change: once the clone is
dropped, `latestReplayInput.events` shares object references with the live
`EventLog` buffer (see "Object aliasing" below), so a fallback that mutated an
event in place would corrupt the stored buffer. Verified it does not — if that
ever changes, STOP condition #2 below fires.

### Why dropping these is safe

- `replayTo` reads `input` strictly read-only: it iterates via
  `iterateInRangeReplayEvents(input, this.lastAppliedSeq)`
  (`src/renderer/libghosttyVt/backend.ts:486-489`) and reads `input.initialCols`
  /`initialRows` (`:472-474`). It never mutates `input` or `input.events`.
- `iterateInRangeReplayEvents` (`src/renderer/replayEvents.ts:20-28`) asserts, **on
  every event during replay**, that each `seq` is a non-negative integer and
  **strictly increasing**. Note this enforces _ordering_, not _contiguity_ — it
  does **not** detect seq gaps the way `validateEventRecords` →
  `assertContiguousSequence` does. On the trusted path the no-gaps guarantee comes
  solely from `EventLog.append`, which assigns `seq === eventBuffer.length` and
  rejects anything else (`src/host/eventLog.ts:345-353`). So skipping
  `validateEventRecords` is safe _because append already guarantees contiguity_,
  not because a downstream check re-verifies it.
- **Array aliasing.** On the trusted path `buildReplayInput` produces
  `ReplayInput.events` via `events.slice()` — a **fresh array** — so the live
  buffer growing (append) or shrinking (rollback truncation,
  `src/host/eventLog.ts:391`) never changes an already-built
  `latestReplayInput.events`. At the **array** level this matches the old
  `[...eventLog.getEvents()]` semantics (`getEvents()` returns the buffer _by
  reference_ — `eventLog.ts:395-397` — so a fresh outer array was always
  required). At the **object** level it does _not_: the old path deep-cloned the
  event objects, the new path shares them — see the next bullet.
- **Object aliasing.** `.slice()` is **shallow**, so the event _objects_ inside
  `latestReplayInput.events` are the **same references** held by the live
  `EventLog` buffer (the clone used to deep-copy them; now they are shared). This
  is safe **only because event records are never mutated in place**: `append`
  pushes new objects and `rollbackBufferedEventsFrom` only `splice`s out trailing
  references (`src/host/eventLog.ts:353,391`); nothing reassigns `event.seq` or
  `event.payload`. Every replay consumer — the libghostty-vt `replayTo` edited here and the
  ghostty-web screenshot fallback it delegates to
  (`src/renderer/ghosttyWeb/backend.ts:428,656`, cited above) —
  reads them read-only. If that ever changes this shortcut breaks — see STOP
  conditions and Maintenance notes.

## Commands you will need

| Purpose          | Command                                        | Expected on success |
| ---------------- | ---------------------------------------------- | ------------------- |
| Install deps     | `aube install`                                 | exit 0              |
| Typecheck        | `npm run typecheck`                            | exit 0, no errors   |
| Lint             | `npm run lint`                                 | exit 0              |
| Format (fix)     | `npm run format`                               | exit 0              |
| Format (check)   | `npm run format:check`                         | exit 0              |
| Replay unit test | `npx vitest run test/unit/host/replay.test.ts` | all pass            |
| Unit suite       | `npm run test:unit`                            | all pass            |
| Renderer e2e     | `npm run test:e2e`                             | all pass            |
| Integration set  | `npm run test:integration`                     | all pass            |

(`aube` is the package manager — do not use `npm install`.)

## Scope

**In scope** (the only files you should modify):

- `src/renderer/libghosttyVt/backend.ts` — drop the clone; remove the now-unused
  `cloneReplayInput` helper.
- `src/host/replay.ts` — accept `readonly EventRecord[]`; add a `trustValidated`
  option that skips the redundant Zod re-parse.
- `src/host/hostMain.ts` — pass the buffer directly with `trustValidated: true`.
- A unit test file for `buildReplayInput` (see Test plan) — extend the existing
  one.

**Out of scope** (do NOT touch):

- `src/replay/offlineReplay.ts` and `src/export/webm.ts` — they must keep full
  validation (disk-/caller-sourced events). Leave their `buildReplayInput` calls
  unchanged (default = validate). (`test/unit/export/webm.test.ts:210` asserts
  `toHaveBeenCalledWith(sessionId, manifest, events, undefined)` — exactly four
  args. Vitest matches the recorded call's args exactly, and because `webm.ts`
  still makes that same 4-arg call, the assertion keeps passing; the new optional
  5th parameter is irrelevant to it.)
- `src/storage/eventLogCodec.ts` — `validateEventRecords` stays as-is; it's still
  used by the offline/export paths.
- `src/renderer/ghosttyWeb/backend.ts` — not part of this change. (It has its own
  timed-replay seq-check duplication, noted separately as a low-priority cleanup;
  do **not** fold it in here.)
- The public CLI JSON / protocol schemas / `ReplayInput` shape — unchanged.
- `CHANGELOG.md` — automation-owned; never edit it.

## Git workflow

- Branch: `advisor/009-trim-replay-input-copies`
- Commit message style: Conventional Commits. Example:
  `perf: avoid re-copying and re-validating the event log on the live snapshot path`.
- Commit per step (or per logical unit). Do NOT push or open a PR unless told.

## Steps

Order chosen so the build is green after every step.

### Step 1: Drop the redundant deep clone in the libghostty-vt backend

In `src/renderer/libghosttyVt/backend.ts`:

1. At `:527`, replace `this.latestReplayInput = cloneReplayInput(input);` with:
   ```ts
   this.latestReplayInput = input;
   ```
2. Remove the now-unused `cloneReplayInput` function (`:75-86`). (It has no other
   caller — confirm with `grep -n "cloneReplayInput" src/renderer/libghosttyVt/backend.ts`
   after the edit: **zero** matches.)

**Verify**: `npm run typecheck` → exit 0; `npm run lint` → exit 0 (no
unused-function warning).

### Step 2: Let `buildReplayInput` accept a read-only events array

In `src/host/replay.ts`, change the `events` parameter type from
`events: EventRecord[]` to `events: readonly EventRecord[]`. Nothing else changes
yet. (`validateEventRecords` already takes `readonly unknown[]`, so this
typechecks; the three existing callers pass mutable arrays, which are assignable
to a `readonly` parameter.)

**Verify**: `npm run typecheck` → exit 0.

### Step 3: Add a `trustValidated` option that skips the redundant Zod re-parse

In `src/host/replay.ts`:

1. Add an options parameter to `buildReplayInput`:
   ```ts
   export function buildReplayInput(
     sessionId: string,
     manifest: SessionRecord,
     events: readonly EventRecord[],
     targetSeq?: number,
     options?: { readonly trustValidated?: boolean },
   ): ReplayInput {
   ```
2. Replace `const validatedEvents = validateEventRecords(events);` with:
   ```ts
   // Live-host events come straight from EventLog, which already
   // EventRecordSchema-validated each record and assigned contiguous seqs on
   // append (see eventLog.ts append()). On that trusted path, skip the
   // redundant per-event Zod re-parse and take one cheap shallow copy instead —
   // seq ordering is still enforced downstream by iterateInRangeReplayEvents
   // during replay. Disk-/caller-sourced events (offline replay, webm export)
   // pass no option and remain fully validated here.
   const validatedEvents =
     options?.trustValidated === true
       ? events.slice()
       : validateEventRecords(events);
   ```
   `events.slice()` on a `readonly EventRecord[]` returns a fresh, mutable
   `EventRecord[]` — assignable to `ReplayInput['events']` exactly as the old
   `validateEventRecords(events)` result was. The rest of the function
   (lastSeq/targetSeq invariants, the returned object) is unchanged.

**Verify**: `npm run typecheck` → exit 0. The two other callers
(`offlineReplay.ts:111`, `webm.ts:142`) compile unchanged and keep validating.

### Step 4: Pass the buffer directly on the live-host path

In `src/host/hostMain.ts`, rewrite `loadReplayInput` (`:188-197`) to drop the
spread and trust the events:

```ts
const loadReplayInput = (targetSeq?: number) => {
  const replayInput = buildReplayInput(
    sessionId,
    state.snapshot(),
    eventLog.getEvents(),
    targetSeq,
    { trustValidated: true },
  );
  return replayInput.targetSeq === -1 ? null : replayInput;
};
```

(`eventLog.getEvents()` returns `readonly EventRecord[]`, now accepted by the
Step-2 signature. The `const events = [...]` line is removed.)

**Verify**: `npm run typecheck` → exit 0; `npm run lint` → exit 0.

### Step 5: Format, then run the behavior gates

1. `npm run format` → exit 0.
2. Unit test for `buildReplayInput` (Test plan) → passes.
3. `npm run test:integration` → all pass.
4. `npm run test:e2e` → all pass (this is the real behavior gate: snapshots,
   screenshots, and the libghostty-vt screenshot fallback must produce identical
   output — the clone removal and validation skip are behavior-preserving).

## Test plan

This change is **behavior-preserving**; the goal is to prove no observable
difference. Two layers:

1. **Unit — `buildReplayInput` trusted path.** Add cases to the existing
   `test/unit/host/replay.test.ts` (it already tests `buildReplayInput`). Reuse its
   helpers `createManifest()` and `createEvents()` — `createEvents()` returns two
   contiguous events whose last `seq` is `1`. The file already imports the
   `EventRecord` type. Model the new `it(...)` blocks on the happy-path test at
   `test/unit/host/replay.test.ts:69` and the explicit-target-seq test at `:130`.
   Add:
   - **Parity (happy path).** For the same input, trusted and default calls return
     equal results:
     ```ts
     const base = buildReplayInput(
       'session-01',
       createManifest(),
       createEvents(),
     );
     const trusted = buildReplayInput(
       'session-01',
       createManifest(),
       createEvents(),
       undefined,
       { trustValidated: true },
     );
     expect(trusted).toEqual(base);
     ```
   - **Non-aliasing (proves the `.slice()` copy).** The returned `events` is a
     _distinct_ array from the one passed in, with identical contents:
     ```ts
     const input = createEvents();
     const result = buildReplayInput(
       'session-01',
       createManifest(),
       input,
       undefined,
       { trustValidated: true },
     );
     expect(result.events).not.toBe(input); // fresh array — does not alias the live buffer
     expect(result.events).toEqual(input); // same contents
     ```
   - **`targetSeq` invariants still fire on the trusted path** (they live _after_
     the validation line, so the skip does not affect them). `createEvents()` has
     last `seq` `1`, so an out-of-range target still throws:
     ```ts
     expect(() =>
       buildReplayInput('session-01', createManifest(), createEvents(), 5, {
         trustValidated: true,
       }),
     ).toThrow('targetSeq must not exceed the last event seq');
     ```
   - **Characterization — the trusted path INTENTIONALLY skips contiguity.** This
     is the one observable behavior difference; pin it so it can't regress silently.
     The same non-contiguous input the default path _rejects_ is _accepted_ when
     trusted:
     ```ts
     const nonContiguous: EventRecord[] = [
       {
         seq: 0,
         ts: '2026-03-19T12:00:02.000Z',
         type: 'output',
         payload: { data: 'a' },
       },
       {
         seq: 3,
         ts: '2026-03-19T12:00:03.000Z',
         type: 'output',
         payload: { data: 'b' },
       },
     ];
     expect(() =>
       buildReplayInput('session-01', createManifest(), nonContiguous),
     ).toThrow('event log seq values must increase by 1 without gaps'); // default: validated
     expect(
       buildReplayInput('session-01', createManifest(), nonContiguous, 3, {
         trustValidated: true,
       }).events,
     ).toHaveLength(2); // trusted: accepted as-is
     ```

   **DO NOT** parametrize the existing `rejects out-of-order sequences` test
   (`test/unit/host/replay.test.ts:141`) with `trustValidated: true` expecting it to
   throw. That test exercises contiguity validation — _exactly_ what the trusted
   path skips — so on the trusted path that input does **not** throw (it is accepted;
   see the characterization case above). Only happy-path cases and the
   `sessionId`/manifest/`targetSeq` checks (which run _before_ or _after_ the
   validation line) behave identically on both paths.

2. **Behavior parity — e2e.** `npm run test:e2e` must pass unchanged. The e2e
   suite exercises real snapshots/screenshots through both backends, including the
   libghostty-vt → ghostty-web screenshot fallback that consumes
   `latestReplayInput`. If it passes, the clone removal preserved behavior.

**Verification**: the unit test passes; `npm run test:integration` and
`npm run test:e2e` both exit 0.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0.
- [ ] `npm run lint` exits 0.
- [ ] `npm run format:check` exits 0.
- [ ] `grep -n "cloneReplayInput" src/renderer/libghosttyVt/backend.ts` returns
      **no** matches (helper removed, call site replaced).
- [ ] `grep -n "\[\.\.\.eventLog.getEvents()\]" src/host/hostMain.ts` returns
      **no** matches (spread removed).
- [ ] `grep -n "trustValidated" src/host/replay.ts src/host/hostMain.ts` shows the
      option defined and passed `true` on the live path.
- [ ] New `buildReplayInput` unit cases (parity, non-aliasing `.slice()`, the
      `targetSeq` invariant on the trusted path, and the contiguity-skip
      characterization) exist in `test/unit/host/replay.test.ts` and pass.
- [ ] `npm run test:unit` exits 0 (the **full** unit suite — the
      `buildReplayInput` signature change ripples to its importers, so run more
      than just the one file).
- [ ] `npm run test:integration` exits 0.
- [ ] `npm run test:e2e` exits 0.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row for 009 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- The "Current state" excerpts don't match the live code (drift since `5cb9a20`).
  In particular, if `replayTo` (libghostty-vt) is found to **mutate** `input` or
  `input.events` anywhere, do **not** drop the clone — report.
- You find **any** code path that mutates an event record object in place after it
  is appended to the `EventLog` buffer (e.g. reassigning `event.payload` or
  `event.seq`, or a redaction/scrub pass over `getEvents()` results). The no-clone
  - shallow-`.slice()` design shares those objects between the live buffer and
    `latestReplayInput`, so in-place mutation would corrupt the stored replay input.
    Keep the deep clone and report instead.
- `npm run test:e2e` fails after any step — that signals the clone removal or the
  validation skip changed observable rendering/screenshot behavior. Do **not**
  loosen assertions or re-add partial copies to force a pass; report which test
  failed and how.
- You discover a fourth `buildReplayInput` caller (beyond hostMain / offlineReplay
  / webm) that also feeds untrusted events — re-evaluate whether it needs
  `trustValidated` left at default before proceeding.
- The e2e suite cannot run in your environment (e.g. no Playwright/Chromium or
  `HOST_UNREACHABLE`) — the behavior-parity gate is then unverifiable; report the
  change as written-but-unverified and name the next best check rather than
  marking done.

## Maintenance notes

- A reviewer should focus on **behavior parity**: the change is only correct if
  snapshots/screenshots are byte-identical before and after. The e2e suite (and
  the screen-hash integration tests) are the evidence; scrutinize that they ran.
- The safety argument rests on three facts, any of which a future change could
  break: (a) `EventLog.append` schema-validates **and** assigns contiguous seqs
  (`seq === eventBuffer.length`) before buffering, so `getEvents()` is trusted and
  gap-free; (b) `iterateInRangeReplayEvents` re-checks seq _ordering_ during replay
  — but **not** contiguity, so gap detection is genuinely dropped on the trusted
  path and relies entirely on (a); and (c) event records are immutable once
  appended, so sharing object references between the live buffer and
  `latestReplayInput` is safe. If someone adds a path that pushes
  unvalidated/non-contiguous records into the buffer, mutates event records in
  place (redaction, scrubbing), or makes replay stop using
  `iterateInRangeReplayEvents`, the `trustValidated` + no-clone shortcut must be
  revisited.
- Deferred out of this plan (and why): the ghostty-web backend's `replayWithTiming`
  duplicates the same inline seq-validation that `iterateInRangeReplayEvents`
  centralizes (a small DRY cleanup, no perf or correctness impact) — left for a
  separate change to keep this one focused on the live snapshot/wait hot path.
- An optional further win not taken here: memoizing the built `ReplayInput` keyed
  on `eventLog.getEvents().length` so repeated polls with no new events reuse the
  prior build entirely. It's higher-risk (cache-invalidation around `targetSeq`
  variants) and worth a separate, measured plan if profiling shows the remaining
  `.slice()` is still hot.
