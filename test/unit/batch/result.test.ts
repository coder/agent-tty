import { describe, expect, it } from 'vitest';

import type { BatchStep } from '../../../src/batch/plan.js';
import type { BatchStepRecord } from '../../../src/batch/result.js';

import { parseBatchPlan } from '../../../src/batch/plan.js';
import {
  BatchResultSchema,
  buildPartialBatchResult,
  unreachedStepRecord,
} from '../../../src/batch/result.js';

const PLAN = parseBatchPlan(
  JSON.stringify([
    { type: 'hello' },
    { sendKeys: ['Enter'] },
    { wait: { text: 'done' } },
    { run: 'echo hi', noWait: true },
  ]),
);

function stepAt(index: number): BatchStep {
  const step = PLAN.steps[index];
  if (step === undefined) {
    throw new Error(`no plan step at index ${String(index)}`);
  }
  return step;
}

function completed(index: number, kind: 'type' | 'sendKeys'): BatchStepRecord {
  return { index, durationMs: 3, kind, status: 'completed', seq: index + 1 };
}

describe('unreachedStepRecord', () => {
  it('shapes a not-run record per step kind without seq or duration', () => {
    expect(unreachedStepRecord(stepAt(0), 0, 'not-run')).toEqual({
      index: 0,
      durationMs: 0,
      kind: 'type',
      status: 'not-run',
    });
    expect(unreachedStepRecord(stepAt(3), 3, 'not-run')).toEqual({
      index: 3,
      durationMs: 0,
      kind: 'run',
      status: 'not-run',
      noWait: true,
    });
  });

  it('shapes an interrupted record with the requested status', () => {
    expect(unreachedStepRecord(stepAt(2), 2, 'interrupted')).toEqual({
      index: 2,
      durationMs: 0,
      kind: 'wait',
      status: 'interrupted',
    });
  });
});

describe('buildPartialBatchResult', () => {
  it('marks the first unreached step interrupted and the rest not-run', () => {
    const recorded = [completed(0, 'type'), completed(1, 'sendKeys')];
    const partial = buildPartialBatchResult(PLAN, recorded);

    expect(partial.steps.map((step) => step.status)).toEqual([
      'completed',
      'completed',
      'interrupted',
      'not-run',
    ]);
    expect(partial.steps.map((step) => step.kind)).toEqual([
      'type',
      'sendKeys',
      'wait',
      'run',
    ]);
  });

  it('recomputes completedCount and failedIndices from the synthesized steps', () => {
    const recorded: BatchStepRecord[] = [
      completed(0, 'type'),
      {
        index: 1,
        durationMs: 5,
        kind: 'sendKeys',
        status: 'failed',
        error: { code: 'HOST_UNREACHABLE', message: 'gone' },
      },
    ];
    const partial = buildPartialBatchResult(PLAN, recorded);

    expect(partial.completedCount).toBe(1);
    expect(partial.failedIndices).toEqual([1]);
    // The interrupted and not-run steps contribute to neither count.
    expect(partial.steps).toHaveLength(4);
  });

  it('produces a schema-valid envelope (interrupted is an accepted status)', () => {
    const partial = buildPartialBatchResult(PLAN, [completed(0, 'type')]);
    expect(() => BatchResultSchema.parse(partial)).not.toThrow();
  });

  it('returns the recorded steps unchanged when the whole plan finalized', () => {
    const recorded: BatchStepRecord[] = [
      completed(0, 'type'),
      completed(1, 'sendKeys'),
      {
        index: 2,
        durationMs: 10,
        kind: 'wait',
        status: 'completed',
        matched: true,
      },
      {
        index: 3,
        durationMs: 1,
        kind: 'run',
        status: 'completed',
        noWait: true,
        seq: 5,
        runOutcome: 'started',
      },
    ];
    const partial = buildPartialBatchResult(PLAN, recorded);

    expect(partial.steps).toHaveLength(4);
    expect(partial.steps.every((step) => step.status === 'completed')).toBe(
      true,
    );
    expect(partial.completedCount).toBe(4);
    expect(partial.failedIndices).toEqual([]);
  });
});
