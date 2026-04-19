import { describe, expect, it } from 'vitest';

import {
  aggregateTokenRecords,
  type RawTokenRecord,
} from '../../../evals/lib/tokenAggregation.js';

function createRawTokenRecord(
  overrides: Partial<RawTokenRecord> = {},
): RawTokenRecord {
  return {
    provider: 'fixture',
    model: 'fixture-model',
    lane: 'prompt',
    caseId: 'case-1',
    condition: 'none',
    caseFingerprint: 'a'.repeat(64),
    usage: {
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
      cachedTokens: 10,
    },
    ...overrides,
  };
}

describe('aggregateTokenRecords', () => {
  it('returns undefined for an empty record list', () => {
    expect(aggregateTokenRecords([], ['prompt', 'execution'])).toBeUndefined();
  });

  it('aggregates a single token record into grand totals, lanes, and cases', () => {
    expect(
      aggregateTokenRecords([createRawTokenRecord()], ['prompt', 'execution']),
    ).toEqual({
      grandTotal: {
        inputTokens: 80,
        outputTokens: 20,
        totalTokens: 100,
        cachedTokens: 10,
        trials: 1,
      },
      perLane: [
        {
          lane: 'prompt',
          inputTokens: 80,
          outputTokens: 20,
          totalTokens: 100,
          cachedTokens: 10,
          trials: 1,
        },
      ],
      perCase: [
        {
          lane: 'prompt',
          caseId: 'case-1',
          condition: 'none',
          inputTokens: 80,
          outputTokens: 20,
          totalTokens: 100,
          cachedTokens: 10,
          trials: 1,
        },
      ],
    });
  });

  it('sums multiple trials for the same case and condition', () => {
    const report = aggregateTokenRecords(
      [
        createRawTokenRecord(),
        createRawTokenRecord({
          usage: {
            inputTokens: 60,
            outputTokens: 30,
            totalTokens: 90,
            cachedTokens: 5,
          },
        }),
      ],
      ['prompt'],
    );

    expect(report).toEqual({
      grandTotal: {
        inputTokens: 140,
        outputTokens: 50,
        totalTokens: 190,
        cachedTokens: 15,
        trials: 2,
      },
      perLane: [
        {
          lane: 'prompt',
          inputTokens: 140,
          outputTokens: 50,
          totalTokens: 190,
          cachedTokens: 15,
          trials: 2,
        },
      ],
      perCase: [
        {
          lane: 'prompt',
          caseId: 'case-1',
          condition: 'none',
          inputTokens: 140,
          outputTokens: 50,
          totalTokens: 190,
          cachedTokens: 15,
          trials: 2,
        },
      ],
    });
  });

  it('groups lanes using the provided lane order and sorts cases deterministically', () => {
    const report = aggregateTokenRecords(
      [
        createRawTokenRecord({
          lane: 'execution',
          caseId: 'case-b',
          condition: 'preloaded',
          usage: {
            inputTokens: 30,
            outputTokens: 10,
            totalTokens: 40,
            cachedTokens: 4,
          },
        }),
        createRawTokenRecord({
          lane: 'prompt',
          caseId: 'case-c',
          condition: 'none',
          usage: {
            inputTokens: 20,
            outputTokens: 5,
            totalTokens: 25,
            cachedTokens: 2,
          },
        }),
        createRawTokenRecord({
          lane: 'execution',
          caseId: 'case-a',
          condition: 'none',
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            cachedTokens: 1,
          },
        }),
      ],
      ['execution', 'prompt', 'dogfood'],
    );

    expect(report?.perLane.map((entry) => entry.lane)).toEqual([
      'execution',
      'prompt',
    ]);
    expect(
      report?.perCase.map((entry) => [
        entry.lane,
        entry.caseId,
        entry.condition,
      ]),
    ).toEqual([
      ['execution', 'case-a', 'none'],
      ['execution', 'case-b', 'preloaded'],
      ['prompt', 'case-c', 'none'],
    ]);
  });

  it('omits cachedTokens for aggregate levels that mix cached and uncached records', () => {
    const report = aggregateTokenRecords(
      [
        createRawTokenRecord({
          lane: 'prompt',
          caseId: 'case-1',
          usage: {
            inputTokens: 80,
            outputTokens: 20,
            totalTokens: 100,
            cachedTokens: 10,
          },
        }),
        createRawTokenRecord({
          lane: 'prompt',
          caseId: 'case-2',
          usage: {
            inputTokens: 40,
            outputTokens: 10,
            totalTokens: 50,
          },
        }),
        createRawTokenRecord({
          lane: 'execution',
          caseId: 'case-3',
          usage: {
            inputTokens: 20,
            outputTokens: 5,
            totalTokens: 25,
            cachedTokens: 3,
          },
        }),
      ],
      ['prompt', 'execution'],
    );

    expect(report?.grandTotal).toEqual({
      inputTokens: 140,
      outputTokens: 35,
      totalTokens: 175,
      trials: 3,
    });
    expect(report?.perLane).toEqual([
      {
        lane: 'prompt',
        inputTokens: 120,
        outputTokens: 30,
        totalTokens: 150,
        trials: 2,
      },
      {
        lane: 'execution',
        inputTokens: 20,
        outputTokens: 5,
        totalTokens: 25,
        cachedTokens: 3,
        trials: 1,
      },
    ]);
    expect(report?.perCase).toEqual([
      {
        lane: 'prompt',
        caseId: 'case-1',
        condition: 'none',
        inputTokens: 80,
        outputTokens: 20,
        totalTokens: 100,
        cachedTokens: 10,
        trials: 1,
      },
      {
        lane: 'prompt',
        caseId: 'case-2',
        condition: 'none',
        inputTokens: 40,
        outputTokens: 10,
        totalTokens: 50,
        trials: 1,
      },
      {
        lane: 'execution',
        caseId: 'case-3',
        condition: 'none',
        inputTokens: 20,
        outputTokens: 5,
        totalTokens: 25,
        cachedTokens: 3,
        trials: 1,
      },
    ]);
  });
});
