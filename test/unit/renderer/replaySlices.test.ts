import { describe, expect, it } from 'vitest';

import {
  FIRST_SLICE_EVENTS,
  MAX_SLICE_BYTES,
  MAX_SLICE_FLUSHES,
  TARGET_SLICE_MS,
  countEventsThrough,
  nextSliceSize,
  replayInSlices,
  sliceEnd,
} from '../../../src/renderer/replaySlices.js';
import { iterateInRangeReplayEvents } from '../../../src/renderer/replayEvents.js';
import type {
  ReplayEvent,
  ReplayInput,
  ReplayState,
} from '../../../src/renderer/types.js';

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

// Output events of the given sizes in bytes (ASCII, so one byte for each
// character), one event for each size.
function makeOutputEvents(sizes: readonly number[]): ReplayEvent[] {
  return sizes.map((size, seq) => ({
    seq,
    ts: '2026-03-20T12:00:00.000Z',
    type: 'output' as const,
    payload: { data: 'x'.repeat(size) },
  }));
}

function makeInputOf(events: readonly ReplayEvent[]): ReplayInput {
  return {
    sessionId: 'session-01',
    initialCols: 80,
    initialRows: 24,
    events: [...events],
    targetSeq: events.length - 1,
  };
}

type FlushingType = 'input_text' | 'marker' | 'resize';

// An event of a type that makes a renderer flush its output.
function flushingEvent(type: FlushingType, seq: number): ReplayEvent {
  const ts = '2026-03-20T12:00:00.000Z';
  switch (type) {
    case 'input_text':
      return { seq, ts, type, payload: { data: 'a' } };
    case 'marker':
      return { seq, ts, type, payload: { label: 'm' } };
    case 'resize':
      return { seq, ts, type, payload: { cols: 80, rows: 24 } };
  }
}

// `pairs` tiny outputs, each followed by an event of the given type.
function makeOutputInputPairs(
  type: FlushingType,
  pairs: number,
  firstSeq = 0,
): ReplayEvent[] {
  return Array.from({ length: 2 * pairs }, (_, index) => {
    const seq = firstSeq + index;
    return index % 2 === 0
      ? {
          seq,
          ts: '2026-03-20T12:00:00.000Z',
          type: 'output' as const,
          payload: { data: 'x' },
        }
      : flushingEvent(type, seq);
  });
}

interface Call {
  readonly input: ReplayInput;
  readonly appliedSeqs: readonly number[];
  // The events that the call replays, and the time that it takes.
  readonly applied: readonly ReplayEvent[];
  readonly elapsedMs: number;
}

// A backend with the rules of the real ones: it holds a position, skips the
// events that it holds, ends at the last event that it replays, and cannot go
// back. Each event takes `costPerEvent` ms of the clock that the test passes
// to `replayInSlices`, or `costOf(event)` ms when the test gives that.
function makeBackend(
  options: {
    startSeq?: number;
    costPerEvent?: number;
    costOf?: (event: ReplayEvent) => number;
  } = {},
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
      const applied: ReplayEvent[] = [];
      let highestProcessedSeq = lastAppliedSeq;
      let elapsedMs = 0;
      for (const event of iterateInRangeReplayEvents(input, lastAppliedSeq)) {
        appliedSeqs.push(event.seq);
        applied.push(event);
        highestProcessedSeq = event.seq;
        elapsedMs += options.costOf?.(event) ?? options.costPerEvent ?? 0;
      }
      if (highestProcessedSeq < 0) {
        highestProcessedSeq = input.targetSeq;
      }
      lastAppliedSeq = highestProcessedSeq;
      clock += elapsedMs;
      calls.push({ input, appliedSeqs, applied, elapsedMs });
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

describe('sliceEnd', () => {
  const KIB = 1024;

  it('ends at the event limit, and at the end of the events', () => {
    const events = makeOutputEvents(Array.from({ length: 100 }, () => 1));

    expect(sliceEnd(events, 0, 100, 32)).toBe(32);
    expect(sliceEnd(events, 40, 100, 32)).toBe(72);
    expect(sliceEnd(events, 90, 100, 32)).toBe(100);
    expect(sliceEnd(events, 0, 10, 32)).toBe(10);
    expect(sliceEnd(events, 100, 100, 32)).toBe(100);
  });

  it('ends before the event that would take the slice past the byte limit', () => {
    const events = makeOutputEvents(
      Array.from({ length: 10 }, () => 400 * KIB),
    );

    // Two events are 800 KiB. A third would make 1,200 KiB, past 1 MiB.
    expect(sliceEnd(events, 0, 10, 1_000)).toBe(2);
    expect(sliceEnd(events, 2, 10, 1_000)).toBe(4);
  });

  it('takes events up to exactly the byte limit', () => {
    const events = makeOutputEvents(
      Array.from({ length: 10 }, () => 512 * KIB),
    );

    expect(MAX_SLICE_BYTES).toBe(1024 * KIB);
    expect(sliceEnd(events, 0, 10, 1_000)).toBe(2);
  });

  it('makes a slice of one event of its own when that event is past the byte limit', () => {
    const events = makeOutputEvents([
      2 * MAX_SLICE_BYTES,
      2 * MAX_SLICE_BYTES,
      10,
      10,
    ]);

    expect(sliceEnd(events, 0, 4, 1_000)).toBe(1);
    expect(sliceEnd(events, 1, 4, 1_000)).toBe(2);
    expect(sliceEnd(events, 2, 4, 1_000)).toBe(4);
  });

  it('counts bytes of UTF-8, not characters', () => {
    // Each event has 200,000 characters of 3 bytes, which are 600,000 bytes.
    const events = makeOutputEvents([]);
    for (let seq = 0; seq < 4; seq += 1) {
      events.push({
        seq,
        ts: '2026-03-20T12:00:00.000Z',
        type: 'output',
        payload: { data: '€'.repeat(200_000) },
      });
    }

    expect(sliceEnd(events, 0, 4, 1_000)).toBe(1);
  });
});

describe('sliceEnd with events that follow output', () => {
  it.each<FlushingType>(['input_text', 'marker', 'resize'])(
    'ends before the %s that would flush output for more than the limit',
    (type) => {
      const events = makeOutputInputPairs(type, 100);

      expect(MAX_SLICE_FLUSHES).toBe(16);
      // The events at the odd indexes flush: the 16th is event 31. Event 32
      // is output, and event 33 would be the 17th flush.
      expect(sliceEnd(events, 0, 200, 1_000)).toBe(33);
      // The next slice starts with the event 33, which follows no output of
      // the slice, so it flushes nothing. The flushes are the events 35 to 65,
      // and event 67 would be the 17th.
      expect(sliceEnd(events, 33, 200, 1_000)).toBe(67);
    },
  );

  it('does not count an event that follows no output, or one that follows another such event', () => {
    const lone = Array.from({ length: 1_000 }, (_, seq) =>
      flushingEvent('marker', seq),
    );
    const afterOneOutput = [
      ...makeOutputEvents([1]),
      ...Array.from({ length: 1_000 }, (_, index) =>
        flushingEvent('input_text', index + 1),
      ),
    ];

    expect(sliceEnd(lone, 0, 1_000, 2_000)).toBe(1_000);
    // One flush, at the first input.
    expect(sliceEnd(afterOneOutput, 0, 1_001, 2_000)).toBe(1_001);
  });

  it('always takes the first event of a slice', () => {
    const events = makeOutputInputPairs('marker', 100);

    // Each slice holds the event that it starts with, whatever it is.
    for (let start = 0; start < 200; start += 1) {
      expect(sliceEnd(events, start, 200, 1_000)).toBeGreaterThan(start);
    }
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
  describe('with a limit on the bytes of a slice', () => {
    // Replay at the speed of #358: a tiny event is cheap, and 64 KiB of
    // output takes 12 ms.
    const TINY_MS = 0.02;
    const BIG_EVENT_BYTES = 64 * 1024;
    const BIG_EVENT_MS = 12;

    function costOf(event: ReplayEvent): number {
      return event.type === 'output' && event.payload.data.length > 1_000
        ? BIG_EVENT_MS
        : TINY_MS;
    }

    function bytesOf(events: readonly ReplayEvent[]): number {
      return events.reduce(
        (sum, event) =>
          sum +
          (event.type === 'output' ? Buffer.byteLength(event.payload.data) : 0),
        0,
      );
    }

    it('never makes a call that takes long, after thousands of tiny events and then big ones', async () => {
      const input = makeInputOf(
        makeOutputEvents([
          ...Array.from({ length: 9_000 }, () => 4),
          ...Array.from({ length: 500 }, () => BIG_EVENT_BYTES),
        ]),
      );
      const backend = makeBackend({ costOf });

      await replayInSlices(backend, input, -1, () => undefined, backend.now);

      // The size of a slice has grown to thousands of events by the time of
      // the big ones, and the last call is no exception.
      expect(
        Math.max(...backend.calls.map((call) => call.elapsedMs)),
      ).toBeLessThan(2 * TARGET_SLICE_MS);
      expect(backend.calls.at(-1)?.input).toBe(input);
      expect(allApplied(backend.calls)).toEqual(input.events.map((e) => e.seq));
      for (const call of backend.calls) {
        expect(
          call.applied.length <= 1 || bytesOf(call.applied) <= MAX_SLICE_BYTES,
        ).toBe(true);
      }
    });

    it('replays a backlog of a few events in slices when their output is past the limit', async () => {
      // 20 events are fewer than the first slice of 32 events.
      const input = makeInputOf(
        makeOutputEvents(Array.from({ length: 20 }, () => BIG_EVENT_BYTES)),
      );
      const backend = makeBackend({ costOf });

      await replayInSlices(backend, input, -1, () => undefined, backend.now);

      expect(backend.calls.map((call) => call.applied.length)).toEqual([16, 4]);
      expect(backend.calls.at(-1)?.input).toBe(input);
    });

    it('replays an event that is past the limit by itself, and goes on', async () => {
      const input = makeInputOf(
        makeOutputEvents([
          2 * MAX_SLICE_BYTES,
          10,
          3 * MAX_SLICE_BYTES,
          2 * MAX_SLICE_BYTES,
          10,
        ]),
      );
      const backend = makeBackend();

      await replayInSlices(backend, input, -1, () => undefined, backend.now);

      // A big event leaves no room in its slice, and no slice takes it as its
      // second event, so each event has a call of its own.
      expect(backend.calls.map((call) => call.appliedSeqs)).toEqual([
        [0],
        [1],
        [2],
        [3],
        [4],
      ]);
    });

    it('does not take a slice of big events for the speed of the events that follow', async () => {
      // Big events that cost nothing make 16-event slices. Their time says
      // nothing about 5,000 events that follow, each of which takes 5 ms.
      const input = makeInputOf(
        makeOutputEvents([
          ...Array.from({ length: 500 }, () => BIG_EVENT_BYTES),
          ...Array.from({ length: 5_000 }, () => 4),
        ]),
      );
      const backend = makeBackend({
        costOf: (event) => (event.seq < 500 ? 0 : 5),
      });

      await replayInSlices(backend, input, -1, () => undefined, backend.now);

      expect(
        Math.max(...backend.calls.map((call) => call.elapsedMs)),
      ).toBeLessThan(2 * TARGET_SLICE_MS);
    });
  });

  describe('with a limit on the flushes of a slice', () => {
    // Replay at the speed of #358: a tiny output is cheap, and an event that
    // follows output flushes it and waits for a frame, which takes 34 ms.
    const TINY_MS = 0.005;
    const FLUSH_MS = 34;

    function costOf(event: ReplayEvent): number {
      return event.type === 'output' ? TINY_MS : FLUSH_MS;
    }

    it.each<FlushingType>(['input_text', 'marker', 'resize'])(
      'never makes a call that takes long, after thousands of tiny outputs and then pairs of output and %s',
      async (type) => {
        const tiny = makeOutputEvents(Array.from({ length: 30_000 }, () => 1));
        const input = makeInputOf([
          ...tiny,
          ...makeOutputInputPairs(type, 3_000, tiny.length),
        ]);
        const backend = makeBackend({ costOf });

        await replayInSlices(backend, input, -1, () => undefined, backend.now);

        // Without the limit, the size has grown to tens of thousands of events
        // by the time of the pairs, and one slice takes minutes.
        expect(
          Math.max(...backend.calls.map((call) => call.elapsedMs)),
        ).toBeLessThan(2 * TARGET_SLICE_MS);
        expect(backend.calls.at(-1)?.input).toBe(input);
        expect(allApplied(backend.calls)).toEqual(
          input.events.map((event) => event.seq),
        );
      },
    );

    it('never makes a call that takes long, when the pairs come after thousands of cheap events of other types', async () => {
      // Markers that follow markers flush nothing, so they cost nothing and
      // make the size grow, as tiny outputs do.
      const markers = Array.from({ length: 30_000 }, (_, seq) =>
        flushingEvent('marker', seq),
      );
      const input = makeInputOf([
        ...markers,
        ...makeOutputInputPairs('input_text', 3_000, markers.length),
      ]);
      const backend = makeBackend({
        costOf: (event) => (event.seq < markers.length ? 0 : costOf(event)),
      });

      await replayInSlices(backend, input, -1, () => undefined, backend.now);

      expect(
        Math.max(...backend.calls.map((call) => call.elapsedMs)),
      ).toBeLessThan(2 * TARGET_SLICE_MS);
    });
  });

  describe('with a backend that reports a position that does not fit', () => {
    function makeFakeBackend(lastSeq: number) {
      const calls: ReplayInput[] = [];
      return {
        calls,
        replayTo(input: ReplayInput): Promise<ReplayState> {
          calls.push(input);
          if (calls.length > 20) {
            return Promise.reject(new Error('runaway replay'));
          }
          return Promise.resolve({
            lastSeq,
            cols: 80,
            rows: 24,
            cursorRow: 0,
            cursorCol: 0,
          });
        },
      };
    }

    it('fails when a slice does not end at its last event', async () => {
      const backend = makeFakeBackend(5);

      await expect(
        replayInSlices(backend, makeInput(500), -1, () => undefined),
      ).rejects.toThrow(/a replay slice must end at its last event/);
      expect(backend.calls).toHaveLength(1);
    });

    it('fails when a slice ends past the target', async () => {
      // The target is event 299, and the backend reports event 450.
      const backend = makeFakeBackend(450);

      await expect(
        replayInSlices(backend, makeInput(500, 299), -1, () => undefined),
      ).rejects.toThrow(/a replay slice must end at its last event/);
      expect(backend.calls).toHaveLength(1);
    });
  });
});
