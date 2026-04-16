import { describe, expect, it } from 'vitest';

import { SKILL_CONDITIONS } from '../../../evals/lib/matrix.js';
import { enumerateExecutionWorkItems } from '../../../evals/execution/runner.js';

const EXECUTION_CASE_ID = 'hello-prompt';

describe('enumerateExecutionWorkItems', () => {
  it('returns unique execution work items with stable keys', () => {
    const items = enumerateExecutionWorkItems();
    const seenKeys = new Set<string>();

    expect(items.length).toBeGreaterThan(0);

    for (const item of items) {
      expect(item.lane).toBe('execution');
      expect(item.caseId.length).toBeGreaterThan(0);
      expect(SKILL_CONDITIONS).toContain(item.condition);
      expect(item.trial).toBe(1);
      expect(item.key.length).toBeGreaterThan(0);
      expect(item.key).toBe(`execution:${item.caseId}:${item.condition}:1`);
      expect(seenKeys.has(item.key)).toBe(false);
      seenKeys.add(item.key);
    }

    expect(seenKeys.size).toBe(items.length);
  });

  it('filters execution work items by case id', () => {
    const items = enumerateExecutionWorkItems({
      caseFilter: [EXECUTION_CASE_ID],
    });

    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.caseId === EXECUTION_CASE_ID)).toBe(true);
  });

  it('filters execution work items by condition', () => {
    const items = enumerateExecutionWorkItems({
      caseFilter: [EXECUTION_CASE_ID],
      conditions: ['none'],
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      lane: 'execution',
      caseId: EXECUTION_CASE_ID,
      condition: 'none',
      trial: 1,
      key: 'execution:hello-prompt:none:1',
    });
  });

  it('enumerates multiple execution trials per case and condition', () => {
    const items = enumerateExecutionWorkItems({
      caseFilter: [EXECUTION_CASE_ID],
      conditions: ['none'],
      totalTrials: 3,
    });

    expect(items).toHaveLength(3);
    expect(items.map((item) => item.trial)).toEqual([1, 2, 3]);
    expect(items.map((item) => item.key)).toEqual([
      'execution:hello-prompt:none:1',
      'execution:hello-prompt:none:2',
      'execution:hello-prompt:none:3',
    ]);
  });
});
