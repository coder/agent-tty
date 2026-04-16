import { describe, expect, it } from 'vitest';

import {
  assertUniqueWorkItems,
  buildWorkItemKey,
} from '../../../evals/lib/types.js';
import type { EvalWorkItemIdentity } from '../../../evals/lib/types.js';

function createWorkItemIdentity(
  overrides: Partial<EvalWorkItemIdentity> = {},
): EvalWorkItemIdentity {
  return {
    lane: 'prompt',
    caseId: 'case-1',
    condition: 'none',
    trial: 1,
    ...overrides,
  };
}

describe('buildWorkItemKey', () => {
  it('produces the expected stable string format', () => {
    const identity = createWorkItemIdentity({
      lane: 'dogfood',
      caseId: 'bug-repro-7',
      condition: 'preloaded',
      trial: 3,
    });

    expect(buildWorkItemKey(identity)).toBe('dogfood:bug-repro-7:preloaded:3');
  });
});

describe('assertUniqueWorkItems', () => {
  it('passes for distinct items', () => {
    const items = [
      createWorkItemIdentity(),
      createWorkItemIdentity({ condition: 'self-load' }),
      createWorkItemIdentity({ lane: 'execution', caseId: 'case-2' }),
    ];

    expect(() => assertUniqueWorkItems(items)).not.toThrow();
  });

  it('treats different trials for the same case and condition as distinct', () => {
    const items = [
      createWorkItemIdentity(),
      createWorkItemIdentity({ trial: 2 }),
    ];

    expect(() => assertUniqueWorkItems(items)).not.toThrow();
  });

  it('throws for duplicate items', () => {
    const duplicate = createWorkItemIdentity({
      lane: 'execution',
      caseId: 'case-7',
      condition: 'stale',
      trial: 1,
    });

    expect(() => assertUniqueWorkItems([duplicate, { ...duplicate }])).toThrow(
      'Duplicate work item identity: execution:case-7:stale:1',
    );
  });
});
