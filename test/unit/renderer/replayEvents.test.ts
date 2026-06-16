import { describe, expect, it } from 'vitest';

import { iterateInRangeReplayEvents } from '../../../src/renderer/replayEvents.js';
import type { ReplayInput } from '../../../src/renderer/types.js';

type ReplayEvent = ReplayInput['events'][number];

const TS = '2026-06-16T00:00:00.000Z';

// Build an `output` replay event at the given seq. `output` is the simplest
// event shape and is all these tests need — the helper only inspects `seq`.
function outputEvent(seq: number, data = `data-${String(seq)}`): ReplayEvent {
  return { seq, ts: TS, type: 'output', payload: { data } };
}

// Construct a ReplayInput directly (not via the schema) so the tests can feed
// the helper deliberately malformed event streams — out-of-order or negative
// seqs the schema would reject — to prove the helper enforces the invariants
// itself at runtime.
function replayInput(
  events: readonly ReplayEvent[],
  targetSeq: number,
): ReplayInput {
  return {
    sessionId: 'session-1',
    initialCols: 80,
    initialRows: 24,
    events: [...events],
    targetSeq,
  };
}

function seqs(input: ReplayInput, lastAppliedSeq: number): number[] {
  return [...iterateInRangeReplayEvents(input, lastAppliedSeq)].map(
    (event) => event.seq,
  );
}

describe('iterateInRangeReplayEvents', () => {
  it('yields all events in order when every event is in range', () => {
    const events = [outputEvent(0), outputEvent(1), outputEvent(2)];
    const input = replayInput(events, 2);

    const yielded = [...iterateInRangeReplayEvents(input, -1)];

    expect(yielded).toEqual(events);
    expect(yielded.map((event) => event.seq)).toEqual([0, 1, 2]);
  });

  it('skips events with seq <= lastAppliedSeq (not yielded)', () => {
    const input = replayInput(
      [outputEvent(0), outputEvent(1), outputEvent(2), outputEvent(3)],
      3,
    );

    expect(seqs(input, 1)).toEqual([2, 3]);
  });

  it('stops at the first event with seq > targetSeq (it and the rest are not yielded)', () => {
    const input = replayInput(
      [outputEvent(0), outputEvent(1), outputEvent(2), outputEvent(3)],
      1,
    );

    // 2 and 3 are beyond targetSeq=1, so iteration stops at 2.
    expect(seqs(input, -1)).toEqual([0, 1]);
  });

  it('combines skip and stop bounds into the half-open range (lastAppliedSeq, targetSeq]', () => {
    const input = replayInput(
      [
        outputEvent(0),
        outputEvent(1),
        outputEvent(2),
        outputEvent(3),
        outputEvent(4),
      ],
      3,
    );

    expect(seqs(input, 1)).toEqual([2, 3]);
  });

  it('throws the strictly-increasing invariant on out-of-order seqs', () => {
    const input = replayInput(
      [outputEvent(0), outputEvent(2), outputEvent(1)],
      5,
    );

    expect(() => [...iterateInRangeReplayEvents(input, -1)]).toThrow(
      'replay events must be ordered by strictly increasing seq values',
    );
  });

  it('throws the non-negative-integer invariant on a negative seq', () => {
    const input = replayInput([outputEvent(-1)], 5);

    expect(() => [...iterateInRangeReplayEvents(input, -1)]).toThrow(
      'replay event seq must be a non-negative integer',
    );
  });

  it('throws the non-negative-integer invariant on a non-integer seq', () => {
    const input = replayInput([outputEvent(1.5)], 5);

    expect(() => [...iterateInRangeReplayEvents(input, -1)]).toThrow(
      'replay event seq must be a non-negative integer',
    );
  });

  it('enforces strictly-increasing even when the offending event would be skipped', () => {
    // lastAppliedSeq is high enough that seq 5 and the repeated 5 are both in
    // the skip range, but the helper checks ordering BEFORE the skip, so the
    // repeated seq still throws.
    const input = replayInput([outputEvent(5), outputEvent(5)], 10);

    expect(() => [...iterateInRangeReplayEvents(input, 7)]).toThrow(
      'replay events must be ordered by strictly increasing seq values',
    );
  });

  it('stops at the targetSeq boundary lazily and does not inspect events past it', () => {
    // The duplicate (non-increasing) seq sits past targetSeq. The helper is a
    // lazy generator: it validates each event as it reaches it, then returns at
    // the first event beyond targetSeq. So it yields [0], stops at the first 5,
    // and never reaches the second 5 to flag the ordering problem.
    const input = replayInput(
      [outputEvent(0), outputEvent(5), outputEvent(5)],
      1,
    );

    expect(seqs(input, -1)).toEqual([0]);
  });

  it('yields nothing when the event list is empty', () => {
    expect(seqs(replayInput([], 5), -1)).toEqual([]);
  });
});
