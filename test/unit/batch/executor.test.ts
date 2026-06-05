import { describe, expect, it, vi } from 'vitest';

import type { BatchPlan } from '../../../src/batch/plan.js';
import type { StepDriver } from '../../../src/batch/stepDriver.js';
import type {
  RunResult,
  WaitForRenderResult,
} from '../../../src/protocol/messages.js';

import { executeBatch } from '../../../src/batch/executor.js';
import { parseBatchPlan } from '../../../src/batch/plan.js';
import { makeCliError } from '../../../src/protocol/errors.js';

type DriverCall =
  | { verb: 'type'; text: string }
  | { verb: 'paste'; text: string }
  | { verb: 'sendKeys'; keys: string[] }
  | { verb: 'run'; command: string; noWait: boolean }
  | { verb: 'wait'; afterSeq: number | undefined };

interface FakeDriverOptions {
  /** Seq returned by each input verb (type/paste/sendKeys), in order. */
  inputSeqs?: number[];
  /** RunResult returned by each run call, in order. */
  runResults?: RunResult[];
  /** WaitForRenderResult returned by each wait call, in order. */
  waitResults?: WaitForRenderResult[];
}

interface FakeDriver {
  driver: StepDriver;
  calls: DriverCall[];
}

const MATCHED_WAIT: WaitForRenderResult = {
  matched: true,
  timedOut: false,
  capturedAtSeq: 99,
};

function plan(steps: unknown[]): BatchPlan {
  return parseBatchPlan(JSON.stringify(steps));
}

function createFakeDriver(options: FakeDriverOptions = {}): FakeDriver {
  const calls: DriverCall[] = [];
  const inputSeqs = [...(options.inputSeqs ?? [])];
  const runResults = [...(options.runResults ?? [])];
  const waitResults = [...(options.waitResults ?? [])];
  let inputCounter = 0;

  const nextInputSeq = (): number => {
    if (inputSeqs.length > 0) {
      const seq = inputSeqs.shift();
      if (seq === undefined) {
        throw new Error('inputSeqs exhausted');
      }
      return seq;
    }
    inputCounter += 1;
    return inputCounter;
  };

  const driver: StepDriver = {
    type: vi.fn((text: string): Promise<number> => {
      calls.push({ verb: 'type', text });
      return Promise.resolve(nextInputSeq());
    }),
    paste: vi.fn((text: string): Promise<number> => {
      calls.push({ verb: 'paste', text });
      return Promise.resolve(nextInputSeq());
    }),
    sendKeys: vi.fn((keys: string[]): Promise<number> => {
      calls.push({ verb: 'sendKeys', keys });
      return Promise.resolve(nextInputSeq());
    }),
    run: vi.fn((command: string, noWait: boolean): Promise<RunResult> => {
      calls.push({ verb: 'run', command, noWait });
      const result = runResults.shift();
      if (result === undefined) {
        return Promise.resolve({ accepted: true, seq: nextInputSeq() });
      }
      return Promise.resolve(result);
    }),
    wait: vi.fn(
      (
        _condition,
        afterSeq: number | undefined,
      ): Promise<WaitForRenderResult> => {
        calls.push({ verb: 'wait', afterSeq });
        return Promise.resolve(waitResults.shift() ?? MATCHED_WAIT);
      },
    ),
  };

  return { driver, calls };
}

describe('executeBatch', () => {
  it('runs every step in plan order and accumulates completedCount', async () => {
    const { driver, calls } = createFakeDriver();
    const result = await executeBatch({
      plan: plan([
        { type: 'hello' },
        { sendKeys: ['Enter'] },
        { wait: { text: 'done' } },
      ]),
      driver,
      keepGoing: false,
    });

    expect(calls.map((call) => call.verb)).toEqual([
      'type',
      'sendKeys',
      'wait',
    ]);
    expect(result.completedCount).toBe(3);
    expect(result.failedIndices).toEqual([]);
    expect(result.steps.map((step) => step.status)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
  });

  it('threads the prior input step seq into the following wait as afterSeq', async () => {
    const { driver, calls } = createFakeDriver({ inputSeqs: [7] });
    await executeBatch({
      plan: plan([{ type: 'hello' }, { wait: { text: 'done' } }]),
      driver,
      keepGoing: false,
    });

    const waitCall = calls.find((call) => call.verb === 'wait');
    expect(waitCall).toEqual({ verb: 'wait', afterSeq: 7 });
  });

  it('records the threaded seq as the wait step waitBaseline', async () => {
    const { driver } = createFakeDriver({ inputSeqs: [42] });
    const result = await executeBatch({
      plan: plan([{ paste: 'x' }, { wait: { text: 'done' } }]),
      driver,
      keepGoing: false,
    });

    const waitStep = result.steps[1];
    expect(waitStep).toMatchObject({
      kind: 'wait',
      waitBaseline: 42,
      matched: true,
    });
  });

  it('passes undefined afterSeq for a leading wait (no prior input step)', async () => {
    const { driver, calls } = createFakeDriver();
    const result = await executeBatch({
      plan: plan([{ wait: { text: 'ready' } }, { type: 'hi' }]),
      driver,
      keepGoing: false,
    });

    expect(calls[0]).toEqual({ verb: 'wait', afterSeq: undefined });
    expect(result.steps[0]).toMatchObject({ kind: 'wait' });
    expect(result.steps[0]).not.toHaveProperty('waitBaseline');
  });

  it('carries the prior input seq unchanged across a wait-after-wait', async () => {
    const { driver, calls } = createFakeDriver({ inputSeqs: [5] });
    await executeBatch({
      plan: plan([
        { type: 'hello' },
        { wait: { text: 'first' } },
        { wait: { text: 'second' } },
      ]),
      driver,
      keepGoing: false,
    });

    const waitCalls = calls.filter((call) => call.verb === 'wait');
    expect(waitCalls).toEqual([
      { verb: 'wait', afterSeq: 5 },
      { verb: 'wait', afterSeq: 5 },
    ]);
  });

  it('uses RunResult.seq as the next wait baseline', async () => {
    const { driver, calls } = createFakeDriver({
      runResults: [{ accepted: true, seq: 13 }],
    });
    await executeBatch({
      plan: plan([
        { run: 'nvim --clean', noWait: true },
        { wait: { screenStableMs: 1000 } },
      ]),
      driver,
      keepGoing: false,
    });

    const waitCall = calls.find((call) => call.verb === 'wait');
    expect(waitCall).toEqual({ verb: 'wait', afterSeq: 13 });
  });

  it('records a run step outcome of started for a noWait run', async () => {
    const { driver } = createFakeDriver({
      runResults: [{ accepted: true, seq: 1 }],
    });
    const result = await executeBatch({
      plan: plan([{ run: 'nvim --clean', noWait: true }]),
      driver,
      keepGoing: false,
    });

    expect(result.steps[0]).toMatchObject({
      kind: 'run',
      status: 'completed',
      seq: 1,
      noWait: true,
      runOutcome: 'started',
    });
  });

  it('records a Waited Run completion outcome', async () => {
    const { driver } = createFakeDriver({
      runResults: [
        {
          accepted: true,
          seq: 4,
          completed: true,
          timedOut: false,
          durationMs: 12,
          marker: '__AT_MARKER_x__',
        },
      ],
    });
    const result = await executeBatch({
      plan: plan([{ run: 'echo hi' }]),
      driver,
      keepGoing: false,
    });

    expect(result.steps[0]).toMatchObject({
      kind: 'run',
      status: 'completed',
      seq: 4,
      noWait: false,
      completed: true,
      timedOut: false,
      runOutcome: 'completed',
    });
  });

  it('does not advance the baseline across a leading run followed by another input then a wait', async () => {
    const { driver, calls } = createFakeDriver({
      runResults: [{ accepted: true, seq: 2 }],
      inputSeqs: [8],
    });
    await executeBatch({
      plan: plan([
        { run: 'echo hi', noWait: true },
        { type: 'more' },
        { wait: { text: 'done' } },
      ]),
      driver,
      keepGoing: false,
    });

    // The wait anchors to the most recent input step (the `type`, seq 8), not
    // the earlier run (seq 2).
    const waitCall = calls.find((call) => call.verb === 'wait');
    expect(waitCall).toEqual({ verb: 'wait', afterSeq: 8 });
  });

  it('invokes onStep once per finalized step record in order', async () => {
    const { driver } = createFakeDriver({ inputSeqs: [1, 2] });
    const seen: number[] = [];
    const result = await executeBatch({
      plan: plan([{ type: 'a' }, { type: 'b' }, { wait: { text: 'x' } }]),
      driver,
      keepGoing: false,
      onStep: (record) => {
        seen.push(record.index);
      },
    });

    expect(seen).toEqual([0, 1, 2]);
    expect(result.steps).toHaveLength(3);
  });

  describe('fail-fast and keep-going', () => {
    it('stops at the first failed wait and marks later steps not-run', async () => {
      const { driver, calls } = createFakeDriver({
        inputSeqs: [1],
        waitResults: [{ matched: false, timedOut: true, capturedAtSeq: 3 }],
      });
      const result = await executeBatch({
        plan: plan([
          { type: 'go' },
          { wait: { text: 'never' } },
          { type: 'after' },
        ]),
        driver,
        keepGoing: false,
      });

      // The `type after` step is never dispatched.
      expect(calls.map((call) => call.verb)).toEqual(['type', 'wait']);
      expect(result.steps.map((step) => step.status)).toEqual([
        'completed',
        'failed',
        'not-run',
      ]);
      expect(result.failedIndices).toEqual([1]);
      expect(result.completedCount).toBe(1);
    });

    it('attempts every step under keepGoing despite a failed wait', async () => {
      const { driver, calls } = createFakeDriver({
        inputSeqs: [1, 2],
        waitResults: [{ matched: false, timedOut: true, capturedAtSeq: 3 }],
      });
      const result = await executeBatch({
        plan: plan([
          { type: 'go' },
          { wait: { text: 'never' } },
          { type: 'after' },
        ]),
        driver,
        keepGoing: true,
      });

      expect(calls.map((call) => call.verb)).toEqual(['type', 'wait', 'type']);
      expect(result.steps.map((step) => step.status)).toEqual([
        'completed',
        'failed',
        'completed',
      ]);
      expect(result.failedIndices).toEqual([1]);
      expect(result.completedCount).toBe(2);
    });

    it('records every trailing step not-run after a fail-fast stop', async () => {
      const { driver } = createFakeDriver({
        waitResults: [{ matched: false, timedOut: true, capturedAtSeq: 2 }],
      });
      const result = await executeBatch({
        plan: plan([
          { wait: { text: 'never' } },
          { type: 'a' },
          { sendKeys: ['Enter'] },
          { wait: { text: 'also-never' } },
        ]),
        driver,
        keepGoing: false,
      });

      expect(result.steps.map((step) => step.status)).toEqual([
        'failed',
        'not-run',
        'not-run',
        'not-run',
      ]);
      expect(result.failedIndices).toEqual([0]);
      expect(result.completedCount).toBe(0);
    });

    it('collects multiple failed indices and zero not-run under keepGoing', async () => {
      const { driver } = createFakeDriver({
        waitResults: [
          { matched: false, timedOut: true, capturedAtSeq: 2 },
          { matched: false, timedOut: true, capturedAtSeq: 4 },
        ],
      });
      const result = await executeBatch({
        plan: plan([
          { wait: { text: 'never-1' } },
          { type: 'between' },
          { wait: { text: 'never-2' } },
        ]),
        driver,
        keepGoing: true,
      });

      expect(result.steps.map((step) => step.status)).toEqual([
        'failed',
        'completed',
        'failed',
      ]);
      expect(result.failedIndices).toEqual([0, 2]);
      expect(result.completedCount).toBe(1);
      expect(result.steps.some((step) => step.status === 'not-run')).toBe(
        false,
      );
    });
  });

  describe('wait timeout classification', () => {
    it('marks a timed-out wait failed with a WAIT_TIMEOUT error', async () => {
      const { driver } = createFakeDriver({
        inputSeqs: [3],
        waitResults: [{ matched: false, timedOut: true, capturedAtSeq: 5 }],
      });
      const result = await executeBatch({
        plan: plan([{ type: 'go' }, { wait: { text: 'never' } }]),
        driver,
        keepGoing: false,
      });

      expect(result.steps[1]).toMatchObject({
        kind: 'wait',
        status: 'failed',
        matched: false,
        timedOut: true,
        capturedAtSeq: 5,
        waitBaseline: 3,
        error: { code: 'WAIT_TIMEOUT' },
      });
    });

    it('treats an unmatched-but-not-timedOut wait as a WAIT_TIMEOUT failure', async () => {
      const { driver } = createFakeDriver({
        waitResults: [{ matched: false, timedOut: false, capturedAtSeq: 1 }],
      });
      const result = await executeBatch({
        plan: plan([{ wait: { text: 'never' } }]),
        driver,
        keepGoing: false,
      });

      expect(result.steps[0]).toMatchObject({
        kind: 'wait',
        status: 'failed',
        error: { code: 'WAIT_TIMEOUT' },
      });
    });
  });

  describe('run completion classification', () => {
    it('fails a Waited Run that timed out with a timedOut runOutcome', async () => {
      const { driver } = createFakeDriver({
        runResults: [
          { accepted: true, seq: 5, completed: false, timedOut: true },
        ],
      });
      const result = await executeBatch({
        plan: plan([{ run: 'sleep 60' }]),
        driver,
        keepGoing: false,
      });

      expect(result.steps[0]).toMatchObject({
        kind: 'run',
        status: 'failed',
        noWait: false,
        completed: false,
        timedOut: true,
        runOutcome: 'timedOut',
      });
      expect(result.failedIndices).toEqual([0]);
      expect(result.completedCount).toBe(0);
    });

    it('fails a Waited Run interrupted by Session exit with a sessionExited runOutcome', async () => {
      const { driver } = createFakeDriver({
        runResults: [{ accepted: true, seq: 6 }],
      });
      const result = await executeBatch({
        plan: plan([{ run: 'echo hi' }]),
        driver,
        keepGoing: false,
      });

      expect(result.steps[0]).toMatchObject({
        kind: 'run',
        status: 'failed',
        noWait: false,
        runOutcome: 'sessionExited',
      });
      const runStep = result.steps[0];
      expect(runStep?.status === 'failed' && runStep.error).toBeTruthy();
    });

    it('completes a no-wait run once accepted regardless of completion', async () => {
      const { driver } = createFakeDriver({
        runResults: [{ accepted: true, seq: 7 }],
      });
      const result = await executeBatch({
        plan: plan([{ run: 'nvim --clean', noWait: true }]),
        driver,
        keepGoing: false,
      });

      expect(result.steps[0]).toMatchObject({
        kind: 'run',
        status: 'completed',
        noWait: true,
        runOutcome: 'started',
      });
    });
  });

  describe('thrown-error handling', () => {
    it('reframes a thrown non-CliError as an INTERNAL_ERROR step failure', async () => {
      const driver: StepDriver = {
        type: () => Promise.reject(new TypeError('boom')),
        paste: () => Promise.resolve(1),
        sendKeys: () => Promise.resolve(1),
        run: () => Promise.resolve({ accepted: true, seq: 1 }),
        wait: () =>
          Promise.resolve({ matched: true, timedOut: false, capturedAtSeq: 1 }),
      };

      const result = await executeBatch({
        plan: plan([{ type: 'hello' }, { type: 'after' }]),
        driver,
        keepGoing: false,
      });

      expect(result.steps[0]).toMatchObject({
        kind: 'type',
        status: 'failed',
        error: { code: 'INTERNAL_ERROR' },
      });
      // Fail-fast still applies; the unexpected error did not escape.
      expect(result.steps[1]).toMatchObject({ status: 'not-run' });
      expect(result.failedIndices).toEqual([0]);
    });

    it('records a thrown CliError from an input step with its own code', async () => {
      const driver: StepDriver = {
        type: () =>
          Promise.reject(
            makeCliError('HOST_UNREACHABLE', { message: 'host gone' }),
          ),
        paste: () => Promise.resolve(1),
        sendKeys: () => Promise.resolve(1),
        run: () => Promise.resolve({ accepted: true, seq: 1 }),
        wait: () =>
          Promise.resolve({ matched: true, timedOut: false, capturedAtSeq: 1 }),
      };

      const result = await executeBatch({
        plan: plan([{ type: 'hello' }]),
        driver,
        keepGoing: false,
      });

      expect(result.steps[0]).toMatchObject({
        kind: 'type',
        status: 'failed',
        error: { code: 'HOST_UNREACHABLE', message: 'host gone' },
      });
    });
  });

  describe('commandability guard around waits', () => {
    it('fails a wait step when the pre-wait commandability check rejects', async () => {
      const { driver, calls } = createFakeDriver({ inputSeqs: [4] });
      const assertCommandable = vi.fn(() =>
        Promise.reject(
          makeCliError('SESSION_NOT_RUNNING', {
            message: 'Session "s" is not running.',
          }),
        ),
      );

      const result = await executeBatch({
        plan: plan([{ type: 'go' }, { wait: { text: 'ready' } }]),
        driver,
        keepGoing: false,
        assertCommandable,
      });

      // The wait never reaches the driver because the guard rejected first.
      expect(calls.map((call) => call.verb)).toEqual(['type']);
      expect(result.steps[1]).toMatchObject({
        kind: 'wait',
        status: 'failed',
        error: { code: 'SESSION_NOT_RUNNING' },
      });
      expect(assertCommandable).toHaveBeenCalledTimes(1);
    });

    it('fails a matched wait when the post-match commandability check rejects', async () => {
      const { driver, calls } = createFakeDriver();
      let callCount = 0;
      const assertCommandable = vi.fn(() => {
        callCount += 1;
        // Pass before the wait, reject after the matched result.
        return callCount === 1
          ? Promise.resolve()
          : Promise.reject(
              makeCliError('SESSION_ALREADY_DESTROYED', {
                message: 'Session "s" is already destroyed.',
              }),
            );
      });

      const result = await executeBatch({
        plan: plan([{ wait: { text: 'ready' } }]),
        driver,
        keepGoing: false,
        assertCommandable,
      });

      // The wait did run, but the post-match guard turned it into a failure.
      expect(calls.map((call) => call.verb)).toEqual(['wait']);
      expect(result.steps[0]).toMatchObject({
        kind: 'wait',
        status: 'failed',
        error: { code: 'SESSION_ALREADY_DESTROYED' },
      });
      expect(assertCommandable).toHaveBeenCalledTimes(2);
    });

    it('lets a wait complete when the commandability guard resolves', async () => {
      const { driver } = createFakeDriver({ inputSeqs: [2] });
      const assertCommandable = vi.fn(() => Promise.resolve());

      const result = await executeBatch({
        plan: plan([{ type: 'go' }, { wait: { text: 'ready' } }]),
        driver,
        keepGoing: false,
        assertCommandable,
      });

      expect(result.steps[1]).toMatchObject({
        kind: 'wait',
        status: 'completed',
        matched: true,
      });
      // Once before the wait, once after the match.
      expect(assertCommandable).toHaveBeenCalledTimes(2);
    });
  });
});
