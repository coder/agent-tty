import { describe, expect, it, vi } from 'vitest';

import { RunCompletionCoordinator } from '../../../src/host/runCompletionCoordinator.js';
import type { RunCompletionEventAppender } from '../../../src/host/runCompletionCoordinator.js';

interface OutputEvent {
  type: 'output';
  data: string;
}

interface RunCompleteEvent {
  type: 'run_complete';
  marker: string;
  inputRunSeq?: number;
  seq: number;
}

type AppendedEvent = OutputEvent | RunCompleteEvent;

function createFakeAppender(
  options: {
    failOutput?: () => boolean;
    failRunComplete?: () => boolean;
  } = {},
): {
  appender: RunCompletionEventAppender;
  events: AppendedEvent[];
} {
  const events: AppendedEvent[] = [];
  let nextSeq = 100;

  return {
    events,
    appender: {
      appendOutput: (data: string): Promise<void> => {
        if (options.failOutput?.() === true) {
          return Promise.reject(new Error('output append failed'));
        }
        events.push({ type: 'output', data });
        return Promise.resolve();
      },
      appendRunComplete: (payload): Promise<number> => {
        if (options.failRunComplete?.() === true) {
          return Promise.reject(new Error('run_complete append failed'));
        }
        const seq = nextSeq;
        nextSeq += 1;
        events.push({ type: 'run_complete', ...payload, seq });
        return Promise.resolve(seq);
      },
    },
  };
}

describe('RunCompletionCoordinator', () => {
  it('appends output around a run_complete event and resolves the waiter', async () => {
    const { appender, events } = createFakeAppender();
    const coordinator = new RunCompletionCoordinator(appender);
    const prepared = coordinator.prepareWaitedRun();
    const completion = coordinator.registerWaitedRun({
      marker: prepared.marker,
      inputRunSeq: 7,
    });
    const waitPromise = completion.wait(1_000);

    await coordinator.ingestPtyData(`before${completion.sentinel}after`);

    await expect(waitPromise).resolves.toEqual({ kind: 'completed', seq: 100 });
    expect(events).toEqual([
      { type: 'output', data: 'before' },
      {
        type: 'run_complete',
        marker: prepared.marker,
        inputRunSeq: 7,
        seq: 100,
      },
      { type: 'output', data: 'after' },
    ]);
  });

  it('strips echoed postamble bytes before appending visible output', async () => {
    const { appender, events } = createFakeAppender();
    const coordinator = new RunCompletionCoordinator(appender);
    const prepared = coordinator.prepareWaitedRun();
    const completion = coordinator.registerWaitedRun({
      marker: prepared.marker,
      inputRunSeq: 8,
    });
    const waitPromise = completion.wait(1_000);
    const echoedPostamble = completion.postamble.replace(/\n$/u, '\r\n');

    await coordinator.ingestPtyData(
      `prompt${echoedPostamble}visible${completion.sentinel}`,
    );

    await expect(waitPromise).resolves.toEqual({ kind: 'completed', seq: 100 });
    expect(events).toEqual([
      { type: 'output', data: 'promptvisible' },
      {
        type: 'run_complete',
        marker: prepared.marker,
        inputRunSeq: 8,
        seq: 100,
      },
    ]);
  });

  it('completes multiple active waited runs out of order', async () => {
    const { appender, events } = createFakeAppender();
    const coordinator = new RunCompletionCoordinator(appender);
    const firstPrepared = coordinator.prepareWaitedRun();
    const firstCompletion = coordinator.registerWaitedRun({
      marker: firstPrepared.marker,
      inputRunSeq: 10,
    });
    const secondPrepared = coordinator.prepareWaitedRun();
    const secondCompletion = coordinator.registerWaitedRun({
      marker: secondPrepared.marker,
      inputRunSeq: 11,
    });
    const firstWait = firstCompletion.wait(1_000);
    const secondWait = secondCompletion.wait(1_000);

    await coordinator.ingestPtyData(secondCompletion.sentinel);
    await coordinator.ingestPtyData(firstCompletion.sentinel);

    await expect(secondWait).resolves.toEqual({ kind: 'completed', seq: 100 });
    await expect(firstWait).resolves.toEqual({ kind: 'completed', seq: 101 });
    expect(events).toEqual([
      {
        type: 'run_complete',
        marker: secondPrepared.marker,
        inputRunSeq: 11,
        seq: 100,
      },
      {
        type: 'run_complete',
        marker: firstPrepared.marker,
        inputRunSeq: 10,
        seq: 101,
      },
    ]);
  });

  it('keeps completion bytes hidden and appends run_complete after a waiter times out', async () => {
    vi.useFakeTimers();
    try {
      const { appender, events } = createFakeAppender();
      const coordinator = new RunCompletionCoordinator(appender);
      const prepared = coordinator.prepareWaitedRun();
      const completion = coordinator.registerWaitedRun({
        marker: prepared.marker,
        inputRunSeq: 12,
      });
      const waitPromise = completion.wait(5);

      await vi.advanceTimersByTimeAsync(5);

      await expect(waitPromise).resolves.toEqual({ kind: 'timeout' });
      await coordinator.ingestPtyData(`before${completion.sentinel}after`);

      expect(events).toEqual([
        { type: 'output', data: 'before' },
        {
          type: 'run_complete',
          marker: prepared.marker,
          inputRunSeq: 12,
          seq: 100,
        },
        { type: 'output', data: 'after' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts an active wait and clears its timeout while preserving hidden completion bytes', async () => {
    vi.useFakeTimers();
    try {
      const { appender, events } = createFakeAppender();
      const coordinator = new RunCompletionCoordinator(appender);
      const prepared = coordinator.prepareWaitedRun();
      const completion = coordinator.registerWaitedRun({
        marker: prepared.marker,
        inputRunSeq: 13,
      });
      const controller = new AbortController();
      const abortReason = new Error('caller disconnected');
      const waitPromise = completion.wait(1_000, { signal: controller.signal });

      controller.abort(abortReason);

      await expect(waitPromise).rejects.toThrow('caller disconnected');
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(1_000);
      await coordinator.ingestPtyData(`before${completion.sentinel}after`);

      expect(events).toEqual([
        { type: 'output', data: 'before' },
        {
          type: 'run_complete',
          marker: prepared.marker,
          inputRunSeq: 13,
          seq: 100,
        },
        { type: 'output', data: 'after' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails ingestion loudly when a timed-out completion later cannot append run_complete', async () => {
    vi.useFakeTimers();
    try {
      let failRunComplete = false;
      const { appender } = createFakeAppender({
        failRunComplete: () => failRunComplete,
      });
      const coordinator = new RunCompletionCoordinator(appender);
      const prepared = coordinator.prepareWaitedRun();
      const completion = coordinator.registerWaitedRun({
        marker: prepared.marker,
        inputRunSeq: 13,
      });
      const waitPromise = completion.wait(5);

      await vi.advanceTimersByTimeAsync(5);
      await expect(waitPromise).resolves.toEqual({ kind: 'timeout' });

      failRunComplete = true;
      await expect(
        coordinator.ingestPtyData(completion.sentinel),
      ).rejects.toThrow('run_complete append failed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves pending waiters as exited without appending run_complete', async () => {
    const { appender, events } = createFakeAppender();
    const coordinator = new RunCompletionCoordinator(appender);
    const prepared = coordinator.prepareWaitedRun();
    const completion = coordinator.registerWaitedRun({
      marker: prepared.marker,
      inputRunSeq: 14,
    });
    const waitPromise = completion.wait(1_000);

    await coordinator.flushPtyDataOnExit();
    coordinator.resetForExit();

    await expect(waitPromise).resolves.toEqual({ kind: 'exited' });
    expect(events).toEqual([]);
  });

  it('keeps exit resolution stable when the original timeout would have fired later', async () => {
    vi.useFakeTimers();
    try {
      const { appender, events } = createFakeAppender();
      const coordinator = new RunCompletionCoordinator(appender);
      const prepared = coordinator.prepareWaitedRun();
      const completion = coordinator.registerWaitedRun({
        marker: prepared.marker,
        inputRunSeq: 15,
      });
      const waitPromise = completion.wait(100);

      coordinator.resetForExit();

      await expect(waitPromise).resolves.toEqual({ kind: 'exited' });
      await vi.advanceTimersByTimeAsync(100);
      expect(events).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects the active waiter when run_complete append fails', async () => {
    const { appender } = createFakeAppender({
      failRunComplete: () => true,
    });
    const coordinator = new RunCompletionCoordinator(appender);
    const prepared = coordinator.prepareWaitedRun();
    const completion = coordinator.registerWaitedRun({
      marker: prepared.marker,
      inputRunSeq: 16,
    });
    const waitPromise = completion.wait(1_000);

    await expect(
      coordinator.ingestPtyData(completion.sentinel),
    ).rejects.toThrow('run_complete append failed');
    await expect(waitPromise).rejects.toThrow('run_complete append failed');
  });

  it('rejects the active waiter when trailing postamble echo output append fails', async () => {
    let failOutput = false;
    const { appender } = createFakeAppender({
      failOutput: () => failOutput,
    });
    const coordinator = new RunCompletionCoordinator(appender);
    const prepared = coordinator.prepareWaitedRun();
    const completion = coordinator.registerWaitedRun({
      marker: prepared.marker,
      inputRunSeq: 17,
    });
    const waitPromise = completion.wait(1_000);

    await coordinator.ingestPtyData(completion.postamble.slice(0, 8));

    failOutput = true;
    const waitExpectation = expect(waitPromise).rejects.toThrow(
      'output append failed',
    );
    await expect(
      coordinator.ingestPtyData(completion.sentinel),
    ).rejects.toThrow('output append failed');
    await waitExpectation;
  });

  it('does not reject the waiter when ordinary output append fails before completion', async () => {
    let failOutput = true;
    const { appender } = createFakeAppender({
      failOutput: () => failOutput,
    });
    const coordinator = new RunCompletionCoordinator(appender);
    const prepared = coordinator.prepareWaitedRun();
    const completion = coordinator.registerWaitedRun({
      marker: prepared.marker,
      inputRunSeq: 18,
    });
    const waitPromise = completion.wait(1_000);

    await expect(coordinator.ingestPtyData('visible')).rejects.toThrow(
      'output append failed',
    );

    failOutput = false;
    await coordinator.ingestPtyData(completion.sentinel);
    await expect(waitPromise).resolves.toEqual({ kind: 'completed', seq: 100 });
  });

  it('flushes pending partial postamble echo bytes as output on exit', async () => {
    const { appender, events } = createFakeAppender();
    const coordinator = new RunCompletionCoordinator(appender);
    const prepared = coordinator.prepareWaitedRun();
    const completion = coordinator.registerWaitedRun({
      marker: prepared.marker,
      inputRunSeq: 19,
    });
    const partialPostamble = completion.postamble.slice(0, 8);

    await coordinator.ingestPtyData(partialPostamble);
    expect(events).toEqual([]);

    await coordinator.flushPtyDataOnExit();

    expect(events).toEqual([{ type: 'output', data: partialPostamble }]);
  });

  it('flushes pending non-completed sentinel bytes as output on exit', async () => {
    const { appender, events } = createFakeAppender();
    const coordinator = new RunCompletionCoordinator(appender);
    const prepared = coordinator.prepareWaitedRun();
    const completion = coordinator.registerWaitedRun({
      marker: prepared.marker,
      inputRunSeq: 19,
    });
    const partialSentinel = completion.sentinel.slice(0, 4);

    await coordinator.ingestPtyData(partialSentinel);
    await coordinator.flushPtyDataOnExit();

    expect(events).toEqual([{ type: 'output', data: partialSentinel }]);
  });
});
