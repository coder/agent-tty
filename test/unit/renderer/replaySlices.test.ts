import { describe, expect, it } from 'vitest';

import {
  FIRST_SLICE_EVENTS,
  countEventsThrough,
  nextSliceSize,
  replayInSlices,
} from '../../../src/renderer/replaySlices.js';
import { iterateInRangeReplayEvents } from '../../../src/renderer/replayEvents.js';
import type { ReplayInput, ReplayState } from '../../../src/renderer/types.js';

function makeInput(eventCount: number, targetSeq?: number): ReplayInput {
  return {
    sessionId: 'session-01',
    initialCols: 80,
    initialRows: 24,
    events: Array.from({ length: eventCount }, (_, seq) => ({
      seq,
      ts: '2026-03-20T12:00:00.000Z',
      type: 'output' as const,
      payload: { data: 'x' },
    })),
    targetSeq: targetSeq ?? eventCount - 1,
  };
}

interface Call {
  readonly input: ReplayInput;
  readonly appliedSeqs: readonly number[];
}

// A backend with the rules of the real ones: it holds a position, skips the
// events that it holds, ends at the last event that it replays, and cannot go
// back. Each event takes `costPerEvent` ms of the clock that the test passes
// to `replayInSlices`.
function makeBackend(
  options: { startSeq?: number; costPerEvent?: number } = {},
) {
  let lastAppliedSeq = options.startSeq ?? -1;
  let clock = 0;
  const calls: Call[] = [];
  return {
    calls,
    now: () => clock,
    get lastAppliedSeq() {
      return lastAppliedSeq;
    },
    replayTo(input: ReplayInput): Promise<ReplayState> {
      if (input.targetSeq < lastAppliedSeq) {
        throw new Error(
          `cannot rewind from seq ${String(lastAppliedSeq)} to ${String(input.targetSeq)}`,
        );
      }
      const appliedSeqs: number[] = [];
      let highestProcessedSeq = lastAppliedSeq;
      for (const event of iterateInRangeReplayEvents(input, lastAppliedSeq)) {
        appliedSeqs.push(event.seq);
        highestProcessedSeq = event.seq;
      }
      if (highestProcessedSeq < 0) {
        highestProcessedSeq = input.targetSeq;
      }
      lastAppliedSeq = highestProcessedSeq;
      clock += appliedSeqs.length * (options.costPerEvent ?? 0);
      calls.push({ input, appliedSeqs });
      return Promise.resolve({
        lastSeq: lastAppliedSeq,
        cols: 80,
        rows: 24,
        cursorRow: 0,
        cursorCol: 0,
      });
    },
  };
}

function allApplied(calls: readonly Call[]): number[] {
  return calls.flatMap((call) => [...call.appliedSeqs]);
}

describe('countEventsThrough', () => {
  it('counts the events with a seq of at most the given seq', () => {
    const events = [{ seq: 0 }, { seq: 1 }, { seq: 4 }, { seq: 9 }];

    expect(countEventsThrough(events, -1)).toBe(0);
    expect(countEventsThrough(events, 0)).toBe(1);
    expect(countEventsThrough(events, 3)).toBe(2);
    expect(countEventsThrough(events, 4)).toBe(3);
    expect(countEventsThrough(events, 100)).toBe(4);
    expect(countEventsThrough([], 5)).toBe(0);
  });
});

describe('nextSliceSize', () => {
  it('aims at the target time with the measured speed', () => {
    expect(nextSliceSize(100, 250)).toBe(200);
    expect(nextSliceSize(100, 1000)).toBe(50);
    expect(nextSliceSize(100, 500)).toBe(100);
  });

  it('grows or shrinks by at most four times', () => {
    expect(nextSliceSize(32, 1)).toBe(128);
    expect(nextSliceSize(32, 0)).toBe(128);
    expect(nextSliceSize(32, 60_000)).toBe(8);
    expect(nextSliceSize(1, 60_000)).toBe(1);
  });
});

describe('replayInSlices', () => {
  it('replays every event once, in order, and ends at the target', async () => {
    const input = makeInput(1_000);
    const backend = makeBackend({ costPerEvent: 5 });
    const states: ReplayState[] = [];

    await replayInSlices(
      backend,
      input,
      -1,
      (state) => states.push(state),
      backend.now,
    );

    expect(allApplied(backend.calls)).toEqual(input.events.map((e) => e.seq));
    expect(backend.lastAppliedSeq).toBe(999);
    expect(backend.calls.length).toBeGreaterThan(2);
    // Each call reports one state, and the states move forward.
    expect(states).toHaveLength(backend.calls.length);
    const reached = states.map((state) => state.lastSeq);
    expect(reached).toEqual(reached.toSorted((a, b) => a - b));
  });

  it('makes the last call with the whole input, which a backend keeps', async () => {
    const input = makeInput(500);
    const backend = makeBackend({ costPerEvent: 5 });

    await replayInSlices(backend, input, -1, () => undefined, backend.now);

    expect(backend.calls.length).toBeGreaterThan(1);
    expect(backend.calls.at(-1)?.input).toBe(input);
    for (const call of backend.calls.slice(0, -1)) {
      expect(call.input.events.length).toBeLessThan(input.events.length);
      expect(call.input.targetSeq).toBe(input.targetSeq);
    }
  });

  it('keeps the first slice small and sizes the next from its time', async () => {
    const input = makeInput(2_000);
    // 15.625 ms for each event, so that the first slice of 32 events takes
    // 500 ms and the next has the same size.
    const slow = makeBackend({ costPerEvent: 15.625 });
    await replayInSlices(slow, input, -1, () => undefined, slow.now);
    expect(slow.calls[0]?.appliedSeqs).toHaveLength(FIRST_SLICE_EVENTS);
    expect(slow.calls[1]?.appliedSeqs).toHaveLength(FIRST_SLICE_EVENTS);

    // A backend that takes no time makes each slice four times larger.
    const fast = makeBackend();
    await replayInSlices(fast, input, -1, () => undefined, fast.now);
    expect(fast.calls.map((call) => call.appliedSeqs.length)).toEqual([
      32, 128, 512, 1_328,
    ]);
  });

  it('replays a backlog of at most one slice in one call, with the input as it is', async () => {
    const input = makeInput(FIRST_SLICE_EVENTS);
    const backend = makeBackend();

    await replayInSlices(backend, input, -1, () => undefined, backend.now);

    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]?.input).toBe(input);
  });

  it('takes the position of a backend that is ahead of the caller', async () => {
    const input = makeInput(1_000);
    const backend = makeBackend({ startSeq: 600, costPerEvent: 5 });

    // The caller thinks that the backend has nothing. A slice with a target
    // below the backend would fail to rewind it.
    await replayInSlices(backend, input, -1, () => undefined, backend.now);

    expect(allApplied(backend.calls)).toEqual(
      input.events.slice(601).map((event) => event.seq),
    );
    expect(backend.lastAppliedSeq).toBe(999);
    // The first slice finds the backend at 600, and the next goes on from it.
    expect(backend.calls[0]?.appliedSeqs).toEqual([]);
    expect(backend.calls[1]?.appliedSeqs[0]).toBe(601);
  });

  it('replays only the events after the position that the caller gives', async () => {
    const input = makeInput(1_000);
    const backend = makeBackend({ startSeq: 399, costPerEvent: 5 });

    await replayInSlices(backend, input, 399, () => undefined, backend.now);

    expect(backend.calls[0]?.appliedSeqs[0]).toBe(400);
    expect(allApplied(backend.calls)).toHaveLength(600);
  });

  it('does not replay events past the target', async () => {
    const input = makeInput(1_000, 449);
    const backend = makeBackend({ costPerEvent: 5 });

    await replayInSlices(backend, input, -1, () => undefined, backend.now);

    expect(allApplied(backend.calls)).toEqual(
      input.events.slice(0, 450).map((event) => event.seq),
    );
    expect(backend.lastAppliedSeq).toBe(449);
  });

  it('stops at a slice that fails and leaves the earlier slices replayed', async () => {
    const input = makeInput(500);
    const backend = makeBackend({ costPerEvent: 5 });
    const original = backend.replayTo.bind(backend);
    let calls = 0;
    backend.replayTo = (replayInput) => {
      calls += 1;
      if (calls === 3) {
        return Promise.reject(new Error('page crashed'));
      }
      return original(replayInput);
    };
    const reported: number[] = [];

    await expect(
      replayInSlices(
        backend,
        input,
        -1,
        (state) => reported.push(state.lastSeq),
        backend.now,
      ),
    ).rejects.toThrow('page crashed');

    // Two slices finished and were reported before the failure.
    expect(reported).toHaveLength(2);
    expect(backend.lastAppliedSeq).toBe(reported.at(-1));
  });
});
