import { describe, expect, it } from 'vitest';

import { compareSnapshotRecords } from '../../../../evals/snapshots/compare.js';
import type { SnapshotComparableRecord } from '../../../../evals/snapshots/compare.js';

function createComparableRecord(
  overrides: Partial<SnapshotComparableRecord> = {},
): SnapshotComparableRecord {
  return {
    provider: 'openai',
    model: 'gpt-4.1',
    lane: 'prompt',
    caseId: 'case-1',
    condition: 'preloaded',
    caseFingerprint: 'a'.repeat(64),
    totalTokens: 100,
    ...overrides,
  };
}

describe('compareSnapshotRecords', () => {
  it('treats values at or below the threshold boundary as unchanged and sorts cases deterministically', () => {
    const report = compareSnapshotRecords({
      regressionThresholdPercent: 10,
      currentRecords: [
        createComparableRecord({ caseId: 'case-c', totalTokens: 111 }),
        createComparableRecord({ caseId: 'case-a', totalTokens: 110 }),
        createComparableRecord({ caseId: 'case-b', totalTokens: 109 }),
      ],
      snapshotRecords: [
        createComparableRecord({ caseId: 'case-b', totalTokens: 100 }),
        createComparableRecord({ caseId: 'case-c', totalTokens: 100 }),
        createComparableRecord({ caseId: 'case-a', totalTokens: 100 }),
      ],
    });

    expect(report.cases.map((entry) => entry.caseId)).toEqual([
      'case-a',
      'case-b',
      'case-c',
    ]);
    expect(report.cases.map((entry) => entry.outcome)).toEqual([
      'unchanged',
      'unchanged',
      'regressed',
    ]);
    expect(report.summary).toEqual({
      total: 3,
      new: 0,
      orphaned: 0,
      unchanged: 2,
      improved: 0,
      regressed: 1,
    });
  });

  it('classifies new, orphaned, equal, and improved cases', () => {
    const report = compareSnapshotRecords({
      regressionThresholdPercent: 10,
      currentRecords: [
        createComparableRecord({ caseId: 'equal', totalTokens: 100 }),
        createComparableRecord({ caseId: 'improved', totalTokens: 80 }),
        createComparableRecord({ caseId: 'new', totalTokens: 90 }),
      ],
      snapshotRecords: [
        createComparableRecord({ caseId: 'equal', totalTokens: 100 }),
        createComparableRecord({ caseId: 'improved', totalTokens: 100 }),
        createComparableRecord({ caseId: 'orphaned', totalTokens: 130 }),
      ],
    });

    expect(
      Object.fromEntries(
        report.cases.map((entry) => [entry.caseId, entry.outcome]),
      ),
    ).toEqual({
      equal: 'unchanged',
      improved: 'improved',
      new: 'new',
      orphaned: 'orphaned',
    });
    expect(report.summary).toEqual({
      total: 4,
      new: 1,
      orphaned: 1,
      unchanged: 1,
      improved: 1,
      regressed: 0,
    });
  });

  it('omits deltaPercent for zero-token baselines while still flagging regressions', () => {
    const report = compareSnapshotRecords({
      regressionThresholdPercent: 10,
      currentRecords: [
        createComparableRecord({ caseId: 'zero-baseline', totalTokens: 1 }),
      ],
      snapshotRecords: [
        createComparableRecord({ caseId: 'zero-baseline', totalTokens: 0 }),
      ],
    });

    expect(report.cases).toEqual([
      expect.objectContaining({
        caseId: 'zero-baseline',
        outcome: 'regressed',
        currentTotalTokens: 1,
        snapshotTotalTokens: 0,
      }),
    ]);
    expect(report.cases[0]).not.toHaveProperty('deltaPercent');
  });
});
