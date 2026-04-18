import { describe, expect, it } from 'vitest';

import type { EvalWorkItemIdentity } from '../../../../evals/lib/types.js';
import {
  CaseProgressTracker,
  computePlannedCases,
  type CaseProgressDispatcher,
} from '../../../../evals/reporters/runtime.js';
import type {
  CaseFinishEvent,
  CaseStartEvent,
} from '../../../../evals/reporters/types.js';

interface RuntimeItem extends Pick<EvalWorkItemIdentity, 'caseId' | 'condition'> {
  trial: number;
}

interface RuntimeResult {
  ok: boolean;
  score?: number | null;
}

type RecordedCaseEvent =
  | { eventName: 'caseStart'; payload: CaseStartEvent }
  | { eventName: 'caseFinish'; payload: CaseFinishEvent };

function createItem(
  caseId: string,
  condition: EvalWorkItemIdentity['condition'],
  trial: number,
): RuntimeItem {
  return { caseId, condition, trial };
}

function createDispatcher(events: RecordedCaseEvent[]): CaseProgressDispatcher {
  return {
    dispatch(eventName, payload) {
      if (eventName === 'caseStart') {
        events.push({ eventName, payload: payload as CaseStartEvent });
        return;
      }

      events.push({ eventName, payload: payload as CaseFinishEvent });
    },
  };
}

function createNowQueue(...timestamps: string[]): () => string {
  let index = 0;
  return () => {
    const timestamp = timestamps[index];
    if (timestamp === undefined) {
      throw new Error(`Missing timestamp at index ${String(index)}`);
    }
    index += 1;
    return timestamp;
  };
}

function getRequiredItem<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`Missing item at index ${String(index)}`);
  }
  return item;
}

function getRequiredEvent(
  events: readonly RecordedCaseEvent[],
  index: number,
): RecordedCaseEvent {
  const event = events[index];
  if (event === undefined) {
    throw new Error(`Missing event at index ${String(index)}`);
  }
  return event;
}

function getCaseFinishPayload(event: RecordedCaseEvent): CaseFinishEvent {
  expect(event.eventName).toBe('caseFinish');
  if (event.eventName !== 'caseFinish') {
    throw new Error('Expected a caseFinish event');
  }
  return event.payload;
}

describe('computePlannedCases', () => {
  it('counts planned trials per case and condition pair', () => {
    const items: RuntimeItem[] = [
      createItem('alpha', 'none', 1),
      createItem('alpha', 'none', 2),
      createItem('alpha', 'self-load', 1),
      createItem('beta', 'none', 1),
    ];

    const plannedCases = computePlannedCases(items);

    expect(plannedCases.size).toBe(3);
    expect(plannedCases.get('alpha\u0000none')).toEqual({
      caseId: 'alpha',
      condition: 'none',
      plannedTrials: 2,
    });
    expect(plannedCases.get('alpha\u0000self-load')).toEqual({
      caseId: 'alpha',
      condition: 'self-load',
      plannedTrials: 1,
    });
    expect(plannedCases.get('beta\u0000none')).toEqual({
      caseId: 'beta',
      condition: 'none',
      plannedTrials: 1,
    });
  });
});

describe('CaseProgressTracker', () => {
  it('emits caseStart on the first trial start and caseFinish on the last trial finish', async () => {
    const items: RuntimeItem[] = [
      createItem('alpha', 'none', 1),
      createItem('alpha', 'none', 2),
    ];
    const firstItem = getRequiredItem(items, 0);
    const secondItem = getRequiredItem(items, 1);
    const events: RecordedCaseEvent[] = [];
    const tracker = new CaseProgressTracker<RuntimeItem, RuntimeResult>({
      runId: 'run-123',
      lane: 'prompt',
      plannedCases: computePlannedCases(items),
      dispatcher: createDispatcher(events),
      now: createNowQueue(
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:05.000Z',
      ),
    });

    await tracker.onTrialStart(firstItem);
    await tracker.onTrialStart(secondItem);

    expect(events).toEqual([
      {
        eventName: 'caseStart',
        payload: {
          runId: 'run-123',
          lane: 'prompt',
          caseId: 'alpha',
          condition: 'none',
          plannedTrials: 2,
          startedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    ]);

    await tracker.onTrialFinish(secondItem, {
      status: 'fulfilled',
      value: { ok: true, score: 0.25 },
    });
    expect(events).toHaveLength(1);

    await tracker.onTrialFinish(firstItem, {
      status: 'fulfilled',
      value: { ok: true, score: 0.75 },
    });

    expect(events).toEqual([
      {
        eventName: 'caseStart',
        payload: {
          runId: 'run-123',
          lane: 'prompt',
          caseId: 'alpha',
          condition: 'none',
          plannedTrials: 2,
          startedAt: '2026-01-01T00:00:00.000Z',
        },
      },
      {
        eventName: 'caseFinish',
        payload: {
          runId: 'run-123',
          lane: 'prompt',
          caseId: 'alpha',
          condition: 'none',
          startedAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:00:05.000Z',
          durationMs: 5000,
          passed: 2,
          failed: 0,
          errored: 0,
          meanScore: 0.5,
          artifactPath: null,
          reportPath: null,
        },
      },
    ]);
  });

  it('tracks mixed passed, failed, and errored trials', async () => {
    const items: RuntimeItem[] = [
      createItem('alpha', 'none', 1),
      createItem('alpha', 'none', 2),
      createItem('alpha', 'none', 3),
    ];
    const firstItem = getRequiredItem(items, 0);
    const secondItem = getRequiredItem(items, 1);
    const thirdItem = getRequiredItem(items, 2);
    const events: RecordedCaseEvent[] = [];
    const tracker = new CaseProgressTracker<RuntimeItem, RuntimeResult>({
      runId: 'run-456',
      lane: 'execution',
      plannedCases: computePlannedCases(items),
      dispatcher: createDispatcher(events),
      now: createNowQueue(
        '2026-01-02T00:00:00.000Z',
        '2026-01-02T00:00:02.000Z',
      ),
    });

    await tracker.onTrialStart(firstItem);
    await tracker.onTrialStart(secondItem);
    await tracker.onTrialStart(thirdItem);
    await tracker.onTrialFinish(firstItem, {
      status: 'fulfilled',
      value: { ok: true, score: 1 },
    });
    await tracker.onTrialFinish(secondItem, {
      status: 'fulfilled',
      value: { ok: false, score: 0.25 },
    });
    await tracker.onTrialFinish(thirdItem, {
      status: 'rejected',
      reason: new Error('worker crashed'),
    });

    expect(getRequiredEvent(events, 1)).toEqual({
      eventName: 'caseFinish',
      payload: {
        runId: 'run-456',
        lane: 'execution',
        caseId: 'alpha',
        condition: 'none',
        startedAt: '2026-01-02T00:00:00.000Z',
        completedAt: '2026-01-02T00:00:02.000Z',
        durationMs: 2000,
        passed: 1,
        failed: 1,
        errored: 1,
        meanScore: 0.625,
        artifactPath: null,
        reportPath: null,
      },
    });
  });

  it('reports a null meanScore when no numeric scores are present', async () => {
    const items: RuntimeItem[] = [
      createItem('beta', 'self-load', 1),
      createItem('beta', 'self-load', 2),
    ];
    const firstItem = getRequiredItem(items, 0);
    const secondItem = getRequiredItem(items, 1);
    const events: RecordedCaseEvent[] = [];
    const tracker = new CaseProgressTracker<RuntimeItem, RuntimeResult>({
      runId: 'run-789',
      lane: 'dogfood',
      plannedCases: computePlannedCases(items),
      dispatcher: createDispatcher(events),
      now: createNowQueue(
        '2026-01-03T00:00:00.000Z',
        '2026-01-03T00:00:01.000Z',
      ),
    });

    await tracker.onTrialStart(firstItem);
    await tracker.onTrialStart(secondItem);
    await tracker.onTrialFinish(firstItem, {
      status: 'fulfilled',
      value: { ok: false, score: null },
    });
    await tracker.onTrialFinish(secondItem, {
      status: 'rejected',
      reason: new Error('missing output'),
    });

    const finishEvent = getCaseFinishPayload(getRequiredEvent(events, 1));
    expect(finishEvent.runId).toBe('run-789');
    expect(finishEvent.lane).toBe('dogfood');
    expect(finishEvent.caseId).toBe('beta');
    expect(finishEvent.condition).toBe('self-load');
    expect(finishEvent.passed).toBe(0);
    expect(finishEvent.failed).toBe(1);
    expect(finishEvent.errored).toBe(1);
    expect(finishEvent.meanScore).toBeNull();
  });

  it('emits exactly one start and finish pair per case and condition even when settlements are out of order', async () => {
    const items: RuntimeItem[] = [
      createItem('alpha', 'none', 1),
      createItem('alpha', 'none', 2),
      createItem('alpha', 'self-load', 1),
      createItem('beta', 'none', 1),
    ];
    const alphaNoneFirst = getRequiredItem(items, 0);
    const alphaNoneSecond = getRequiredItem(items, 1);
    const alphaSelfLoad = getRequiredItem(items, 2);
    const betaNone = getRequiredItem(items, 3);
    const events: RecordedCaseEvent[] = [];
    const tracker = new CaseProgressTracker<RuntimeItem, RuntimeResult>({
      runId: 'run-999',
      lane: 'prompt',
      plannedCases: computePlannedCases(items),
      dispatcher: createDispatcher(events),
      now: createNowQueue(
        '2026-01-04T00:00:00.000Z',
        '2026-01-04T00:00:01.000Z',
        '2026-01-04T00:00:02.000Z',
        '2026-01-04T00:00:03.000Z',
        '2026-01-04T00:00:04.000Z',
        '2026-01-04T00:00:05.000Z',
      ),
    });

    await tracker.onTrialStart(alphaNoneFirst);
    await tracker.onTrialStart(alphaSelfLoad);
    await tracker.onTrialStart(betaNone);
    await tracker.onTrialStart(alphaNoneSecond);

    await tracker.onTrialFinish(betaNone, {
      status: 'fulfilled',
      value: { ok: true, score: 1 },
    });
    await tracker.onTrialFinish(alphaNoneSecond, {
      status: 'fulfilled',
      value: { ok: false, score: 0.2 },
    });
    await tracker.onTrialFinish(alphaSelfLoad, {
      status: 'fulfilled',
      value: { ok: true, score: 0.8 },
    });
    await tracker.onTrialFinish(alphaNoneFirst, {
      status: 'fulfilled',
      value: { ok: true, score: 0.6 },
    });

    const caseStartEvents = events.filter(
      (event): event is Extract<RecordedCaseEvent, { eventName: 'caseStart' }> =>
        event.eventName === 'caseStart',
    );
    const caseFinishEvents = events.filter(
      (event): event is Extract<RecordedCaseEvent, { eventName: 'caseFinish' }> =>
        event.eventName === 'caseFinish',
    );
    const countByKey = (
      caseEvents: Array<{
        payload: {
          caseId: string;
          condition: string;
        };
      }>,
    ): Map<string, number> => {
      const counts = new Map<string, number>();
      for (const event of caseEvents) {
        const key = `${event.payload.caseId}\u0000${event.payload.condition}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return counts;
    };

    expect(events).toHaveLength(6);
    expect(countByKey(caseStartEvents)).toEqual(
      new Map<string, number>([
        ['alpha\u0000none', 1],
        ['alpha\u0000self-load', 1],
        ['beta\u0000none', 1],
      ]),
    );
    expect(countByKey(caseFinishEvents)).toEqual(
      new Map<string, number>([
        ['alpha\u0000none', 1],
        ['alpha\u0000self-load', 1],
        ['beta\u0000none', 1],
      ]),
    );
    expect(caseFinishEvents.map((event) => event.payload.caseId)).toEqual([
      'beta',
      'alpha',
      'alpha',
    ]);
    expect(caseFinishEvents.map((event) => event.payload.condition)).toEqual([
      'none',
      'self-load',
      'none',
    ]);
  });
});
