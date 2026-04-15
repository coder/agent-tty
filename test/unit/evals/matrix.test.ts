import { describe, expect, it } from 'vitest';

import {
  SKILL_CONDITIONS,
  buildConditionMatrix,
  computeComparisonMetrics,
  groupResultsByCase,
  groupResultsByCondition,
  groupResultsByProvider,
} from '../../../evals/lib/matrix.js';
import type {
  ComparisonMetrics,
  EvalResult,
  ExecutionEvalCase,
  PromptEvalCase,
  SkillCondition,
} from '../../../evals/lib/types.js';

function createEvalResult(overrides: Partial<EvalResult> = {}): EvalResult {
  return {
    runId: 'run-1',
    providerId: 'test-provider',
    lane: 'prompt',
    caseId: 'case-1',
    category: 'trigger',
    condition: 'none',
    expectedSkill: 'agent-tty',
    trial: 1,
    ok: true,
    score: { total: 0.8, maxPossible: 1, items: [] },
    workflowChecks: [],
    antiPatternFindings: [],
    normalizedOutput: {
      finalText: '',
      messages: [],
      referencedSkills: [],
      toolCalls: [],
    },
    startedAt: '2025-01-01T00:00:00.000Z',
    completedAt: '2025-01-01T00:00:01.000Z',
    durationMs: 1000,
    ...overrides,
  };
}

function createPromptCase(
  overrides: Partial<PromptEvalCase> = {},
): PromptEvalCase {
  return {
    id: 'prompt-case-1',
    lane: 'prompt',
    category: 'trigger',
    prompt: 'Test prompt',
    expectedSkill: 'agent-tty',
    expectedPatterns: [],
    forbiddenPatterns: [],
    rubric: [],
    workflowChecks: [],
    antiPatterns: [],
    budgets: { timeoutMs: 5000 },
    ...overrides,
  };
}

function createExecutionCase(
  overrides: Partial<ExecutionEvalCase> = {},
): ExecutionEvalCase {
  return {
    id: 'exec-case-1',
    lane: 'execution',
    category: 'session',
    prompt: 'Test execution',
    expectedSkill: 'agent-tty',
    conditions: [],
    setup: [],
    verifiers: [],
    workflowChecks: [],
    antiPatterns: [],
    artifactRequirements: [],
    budgets: { timeoutMs: 10000 },
    ...overrides,
  };
}

function createComparisonResults(
  conditionScores: Partial<Record<SkillCondition, readonly number[]>>,
  overrides: Partial<EvalResult> = {},
): EvalResult[] {
  const results: EvalResult[] = [];
  let trial = 1;

  for (const condition of SKILL_CONDITIONS) {
    const scores = conditionScores[condition];
    if (scores === undefined) {
      continue;
    }

    for (const total of scores) {
      results.push(
        createEvalResult({
          ...overrides,
          trial: trial++,
          condition,
          score: { total, maxPossible: 1, items: [] },
        }),
      );
    }
  }

  return results;
}

function expectSingleComparison(
  results: readonly EvalResult[],
): ComparisonMetrics {
  const comparisons = computeComparisonMetrics(results);

  expect(comparisons).toHaveLength(1);

  const [comparison] = comparisons;
  expect(comparison).toBeDefined();
  if (comparison === undefined) {
    throw new Error('Expected one comparison result');
  }

  return comparison;
}

describe('SKILL_CONDITIONS', () => {
  it('exports the expected frozen array', () => {
    expect(SKILL_CONDITIONS).toEqual([
      'none',
      'self-load',
      'preloaded',
      'stale',
    ]);
    expect(Object.isFrozen(SKILL_CONDITIONS)).toBe(true);
  });
});

describe('buildConditionMatrix', () => {
  it('creates four entries for a single prompt case and provider', () => {
    const promptCase = createPromptCase();

    const matrix = buildConditionMatrix([promptCase], ['provider-a']);

    expect(matrix).toEqual(
      SKILL_CONDITIONS.map((condition) => ({
        providerId: 'provider-a',
        lane: 'prompt',
        caseId: promptCase.id,
        category: promptCase.category,
        condition,
        expectedSkill: promptCase.expectedSkill,
      })),
    );
  });

  it('creates a full provider cross-product for prompt cases', () => {
    const matrix = buildConditionMatrix(
      [createPromptCase()],
      ['provider-a', 'provider-b'],
    );

    expect(matrix).toHaveLength(8);
    expect(
      matrix
        .filter((entry) => entry.providerId === 'provider-a')
        .map((entry) => entry.condition),
    ).toEqual(SKILL_CONDITIONS);
    expect(
      matrix
        .filter((entry) => entry.providerId === 'provider-b')
        .map((entry) => entry.condition),
    ).toEqual(SKILL_CONDITIONS);
  });

  it('uses only explicit execution conditions', () => {
    const executionCase = createExecutionCase({
      conditions: ['none', 'preloaded'],
    });

    const matrix = buildConditionMatrix([executionCase], ['provider-a']);

    expect(matrix.map((entry) => entry.condition)).toEqual([
      'none',
      'preloaded',
    ]);
  });

  it('falls back to all conditions when execution conditions are empty', () => {
    const executionCase = createExecutionCase({ conditions: [] });

    const matrix = buildConditionMatrix([executionCase], ['provider-a']);

    expect(matrix.map((entry) => entry.condition)).toEqual(SKILL_CONDITIONS);
  });

  it('preserves execution entry fields including fixture and target', () => {
    const executionCase = createExecutionCase({
      id: 'exec-case-2',
      category: 'artifact',
      conditions: ['self-load'],
      fixture: 'fixtures/color-grid',
      target: 'artifacts/output.json',
    });

    const matrix = buildConditionMatrix([executionCase], ['provider-a']);

    expect(matrix).toEqual([
      {
        providerId: 'provider-a',
        lane: 'execution',
        caseId: 'exec-case-2',
        category: 'artifact',
        condition: 'self-load',
        expectedSkill: 'agent-tty',
        fixture: 'fixtures/color-grid',
        target: 'artifacts/output.json',
      },
    ]);
  });

  it('throws when cases is empty', () => {
    expect(() => buildConditionMatrix([], ['provider-a'])).toThrow(
      'cases must not be empty',
    );
  });

  it('throws when providers contain duplicates', () => {
    expect(() =>
      buildConditionMatrix([createPromptCase()], ['provider-a', 'provider-a']),
    ).toThrow('providers must not contain duplicates');
  });
});

describe('groupResultsByCase', () => {
  it('groups results by caseId', () => {
    const results = [
      createEvalResult({ caseId: 'case-1', condition: 'none', trial: 1 }),
      createEvalResult({ caseId: 'case-1', condition: 'self-load', trial: 2 }),
    ];

    const grouped = groupResultsByCase(results);

    expect(grouped.size).toBe(1);
    expect(grouped.get('case-1')).toEqual(results);
  });

  it('creates separate buckets for multiple cases', () => {
    const first = createEvalResult({ caseId: 'case-1', trial: 1 });
    const second = createEvalResult({ caseId: 'case-2', trial: 2 });
    const third = createEvalResult({
      caseId: 'case-1',
      condition: 'self-load',
      trial: 3,
    });

    const grouped = groupResultsByCase([first, second, third]);

    expect(Array.from(grouped.keys())).toEqual(['case-1', 'case-2']);
    expect(grouped.get('case-1')).toEqual([first, third]);
    expect(grouped.get('case-2')).toEqual([second]);
  });
});

describe('groupResultsByCondition', () => {
  it('pre-initializes every condition bucket', () => {
    const grouped = groupResultsByCondition([]);

    expect(Array.from(grouped.keys())).toEqual(SKILL_CONDITIONS);
    for (const condition of SKILL_CONDITIONS) {
      expect(grouped.get(condition)).toEqual([]);
    }
  });

  it('places results into the matching condition buckets', () => {
    const noneOne = createEvalResult({ condition: 'none', trial: 1 });
    const noneTwo = createEvalResult({
      condition: 'none',
      caseId: 'case-2',
      trial: 2,
    });
    const preloaded = createEvalResult({ condition: 'preloaded', trial: 3 });

    const grouped = groupResultsByCondition([noneOne, preloaded, noneTwo]);

    expect(grouped.get('none')).toEqual([noneOne, noneTwo]);
    expect(grouped.get('self-load')).toEqual([]);
    expect(grouped.get('preloaded')).toEqual([preloaded]);
    expect(grouped.get('stale')).toEqual([]);
  });
});

describe('groupResultsByProvider', () => {
  it('groups results by providerId', () => {
    const first = createEvalResult({ providerId: 'provider-a', trial: 1 });
    const second = createEvalResult({ providerId: 'provider-b', trial: 2 });
    const third = createEvalResult({
      providerId: 'provider-a',
      condition: 'self-load',
      trial: 3,
    });

    const grouped = groupResultsByProvider([first, second, third]);

    expect(Array.from(grouped.keys())).toEqual(['provider-a', 'provider-b']);
    expect(grouped.get('provider-a')).toEqual([first, third]);
    expect(grouped.get('provider-b')).toEqual([second]);
  });
});

describe('computeComparisonMetrics', () => {
  it('computes realizedSkillLift as self-load mean minus none mean', () => {
    const comparison = expectSingleComparison(
      createComparisonResults({
        none: [0.2, 0.4],
        'self-load': [0.6, 0.8],
        preloaded: [0.9, 0.9],
        stale: [0.1, 0.1],
      }),
    );

    expect(comparison.realizedSkillLift).toBeCloseTo(0.4);
    expect(comparison.groupKey).toBe(
      JSON.stringify(['test-provider', 'prompt', 'case-1']),
    );
    expect(comparison.caseIds).toEqual(['case-1']);
    expect(comparison.totalCompared).toBe(1);
  });

  it('computes oracleSkillLift as preloaded mean minus none mean', () => {
    const comparison = expectSingleComparison(
      createComparisonResults({
        none: [0.25, 0.35],
        'self-load': [0.25, 0.35],
        preloaded: [0.75, 0.85],
        stale: [0.2, 0.2],
      }),
    );

    expect(comparison.oracleSkillLift).toBeCloseTo(0.5);
  });

  it('computes staleSkillHarm as none mean minus stale mean', () => {
    const comparison = expectSingleComparison(
      createComparisonResults({
        none: [0.7, 0.9],
        'self-load': [0.8, 0.8],
        preloaded: [0.95, 0.95],
        stale: [0.2, 0.4],
      }),
    );

    expect(comparison.staleSkillHarm).toBeCloseTo(0.5);
  });

  it('sets regressionRate to 1 when self-load underperforms none', () => {
    const comparison = expectSingleComparison(
      createComparisonResults({
        none: [0.9],
        'self-load': [0.4],
        preloaded: [1],
        stale: [0.2],
      }),
    );

    expect(comparison.regressionRate).toBe(1);
    expect(comparison.unlockRate).toBe(0);
  });

  it('sets unlockRate to 1 when self-load outperforms none', () => {
    const comparison = expectSingleComparison(
      createComparisonResults({
        none: [0.4],
        'self-load': [0.9],
        preloaded: [1],
        stale: [0.1],
      }),
    );

    expect(comparison.unlockRate).toBe(1);
    expect(comparison.regressionRate).toBe(0);
  });

  it('computes routingGap as oracle lift minus realized lift when both lifts exist', () => {
    const comparison = expectSingleComparison(
      createComparisonResults({
        none: [0.2],
        'self-load': [0.5],
        preloaded: [0.9],
        stale: [0.1],
      }),
    );

    expect(comparison.routingGap).toBeCloseTo(0.4);
  });

  it('clamps routingEfficiency to the unit interval', () => {
    const comparison = expectSingleComparison(
      createComparisonResults({
        none: [0.2],
        'self-load': [0.9],
        preloaded: [0.6],
        stale: [0.1],
      }),
    );

    expect(comparison.routingEfficiency).toBe(1);
  });

  it('reports missing conditions for absent buckets', () => {
    const comparison = expectSingleComparison(
      createComparisonResults({
        none: [0.5],
        'self-load': [0.7],
      }),
    );

    expect(comparison.missingConditions).toEqual(['preloaded', 'stale']);
    expect(comparison.oracleSkillLift).toBe(0);
    expect(comparison.staleSkillHarm).toBe(0);
  });

  it('returns separate metrics for distinct provider and case groups', () => {
    const results = [
      ...createComparisonResults({
        none: [0.2],
        'self-load': [0.4],
        preloaded: [0.6],
        stale: [0.1],
      }),
      ...createComparisonResults(
        {
          none: [0.5],
          'self-load': [0.8],
          preloaded: [0.9],
          stale: [0.3],
        },
        {
          providerId: 'provider-b',
          caseId: 'case-2',
        },
      ),
    ];

    const comparisons = computeComparisonMetrics(results);

    expect(comparisons).toHaveLength(2);
    expect(comparisons.map((comparison) => comparison.groupKey)).toEqual([
      JSON.stringify(['test-provider', 'prompt', 'case-1']),
      JSON.stringify(['provider-b', 'prompt', 'case-2']),
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(computeComparisonMetrics([])).toEqual([]);
  });
});
