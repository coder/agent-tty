import { describe, expect, it } from 'vitest';

import { SKILL_CONDITIONS } from '../../../evals/lib/matrix.js';
import { enumerateDogfoodWorkItems } from '../../../evals/dogfood/runner.js';

const DOGFOOD_CASE_ID = 'exploratory-qa';

describe('enumerateDogfoodWorkItems', () => {
  it('returns unique dogfood work items with stable keys', () => {
    const items = enumerateDogfoodWorkItems();
    const seenKeys = new Set<string>();

    expect(items.length).toBeGreaterThan(0);

    for (const item of items) {
      expect(item.lane).toBe('dogfood');
      expect(item.caseId.length).toBeGreaterThan(0);
      expect(SKILL_CONDITIONS).toContain(item.condition);
      expect(item.trial).toBe(1);
      expect(item.key.length).toBeGreaterThan(0);
      expect(item.key).toBe(`dogfood:${item.caseId}:${item.condition}:1`);
      expect(seenKeys.has(item.key)).toBe(false);
      seenKeys.add(item.key);
    }

    expect(seenKeys.size).toBe(items.length);
  });

  it('filters dogfood work items by case id', () => {
    const items = enumerateDogfoodWorkItems({ caseFilter: [DOGFOOD_CASE_ID] });

    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.caseId === DOGFOOD_CASE_ID)).toBe(true);
  });

  it('filters dogfood work items by condition', () => {
    const items = enumerateDogfoodWorkItems({
      caseFilter: [DOGFOOD_CASE_ID],
      conditions: ['none'],
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      lane: 'dogfood',
      caseId: DOGFOOD_CASE_ID,
      condition: 'none',
      trial: 1,
      key: 'dogfood:exploratory-qa:none:1',
    });
  });

  it('enumerates multiple dogfood trials per case and condition', () => {
    const items = enumerateDogfoodWorkItems({
      caseFilter: [DOGFOOD_CASE_ID],
      conditions: ['none'],
      totalTrials: 2,
    });

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.trial)).toEqual([1, 2]);
    expect(items.map((item) => item.key)).toEqual([
      'dogfood:exploratory-qa:none:1',
      'dogfood:exploratory-qa:none:2',
    ]);
  });
});
