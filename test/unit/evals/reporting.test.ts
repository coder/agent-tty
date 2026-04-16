import { describe, expect, it } from 'vitest';

import {
  generateJsonReport,
  generateMarkdownReport,
} from '../../../evals/lib/reporting.js';
import {
  computeConfidenceInterval,
  computeMean,
  computePassRate,
  computeStdDev,
} from '../../../evals/lib/statistics.js';
import type { EvalResult, RunMetadata } from '../../../evals/lib/types.js';

function createRunMetadata(overrides: Partial<RunMetadata> = {}): RunMetadata {
  return {
    runId: 'report-run',
    createdAt: '2026-01-01T00:00:00.000Z',
    repoRoot: '/tmp/report-repo',
    providers:
      overrides.providers === undefined ? ['stub'] : [...overrides.providers],
    models: overrides.models === undefined ? [] : [...overrides.models],
    lanes:
      overrides.lanes === undefined
        ? ['prompt', 'execution']
        : [...overrides.lanes],
    conditions:
      overrides.conditions === undefined
        ? ['none', 'self-load']
        : [...overrides.conditions],
    totalTrials: overrides.totalTrials ?? 3,
    notes: overrides.notes === undefined ? [] : [...overrides.notes],
    ...(overrides.runId === undefined ? {} : { runId: overrides.runId }),
    ...(overrides.createdAt === undefined
      ? {}
      : { createdAt: overrides.createdAt }),
    ...(overrides.repoRoot === undefined
      ? {}
      : { repoRoot: overrides.repoRoot }),
  };
}

function createEvalResult(overrides: Partial<EvalResult> = {}): EvalResult {
  return {
    runId: 'report-run',
    providerId: 'stub',
    lane: 'prompt',
    caseId: 'case-1',
    category: 'trigger',
    condition: 'none',
    expectedSkill: 'agent-tty',
    trial: 1,
    ok: true,
    score: { total: 10, maxPossible: 10, items: [] },
    workflowChecks: [],
    antiPatternFindings: [],
    normalizedOutput: {
      finalText: '',
      messages: [],
      referencedSkills: [],
      toolCalls: [],
    },
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    ...overrides,
  };
}

function createMultiTrialResults(): EvalResult[] {
  return [
    createEvalResult({
      lane: 'prompt',
      caseId: 'case-1',
      condition: 'none',
      trial: 1,
      ok: true,
      score: { total: 10, maxPossible: 10, items: [] },
    }),
    createEvalResult({
      lane: 'prompt',
      caseId: 'case-1',
      condition: 'none',
      trial: 2,
      ok: false,
      score: { total: 5, maxPossible: 10, items: [] },
    }),
    createEvalResult({
      lane: 'prompt',
      caseId: 'case-1',
      condition: 'none',
      trial: 3,
      ok: false,
      score: { total: 0, maxPossible: 10, items: [] },
    }),
    createEvalResult({
      lane: 'execution',
      caseId: 'case-2',
      category: 'session',
      condition: 'self-load',
      trial: 1,
      ok: false,
      score: { total: 2, maxPossible: 10, items: [] },
    }),
    createEvalResult({
      lane: 'execution',
      caseId: 'case-2',
      category: 'session',
      condition: 'self-load',
      trial: 2,
      ok: true,
      score: { total: 4, maxPossible: 10, items: [] },
    }),
    createEvalResult({
      lane: 'execution',
      caseId: 'case-2',
      category: 'session',
      condition: 'self-load',
      trial: 3,
      ok: true,
      score: { total: 6, maxPossible: 10, items: [] },
    }),
  ];
}

function createSingleTrialResults(): EvalResult[] {
  return [
    createEvalResult({
      lane: 'prompt',
      caseId: 'case-1',
      condition: 'none',
      trial: 1,
      ok: true,
      score: { total: 10, maxPossible: 10, items: [] },
    }),
    createEvalResult({
      lane: 'execution',
      caseId: 'case-2',
      category: 'session',
      condition: 'self-load',
      trial: 1,
      ok: false,
      score: { total: 2, maxPossible: 10, items: [] },
    }),
  ];
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatScore(value: number): string {
  return value.toFixed(3);
}

function formatConfidenceInterval(
  interval: { lower: number; upper: number },
  formatter: (value: number) => string,
): string {
  return `[${formatter(interval.lower)}, ${formatter(interval.upper)}]`;
}

describe('generateJsonReport trial aggregation', () => {
  it('includes aggregated data only when totalTrials is greater than one', () => {
    const report = generateJsonReport(
      createMultiTrialResults(),
      createRunMetadata({ totalTrials: 3 }),
    );

    expect(report.aggregated).toBeDefined();
    expect(report.aggregated).toHaveLength(2);
  });

  it('omits aggregated data when totalTrials equals one', () => {
    const report = generateJsonReport(
      createSingleTrialResults(),
      createRunMetadata({ totalTrials: 1 }),
    );

    expect(report.aggregated).toBeUndefined();
  });

  it('computes aggregated pass rate, score, and confidence intervals', () => {
    const results = createMultiTrialResults();
    const report = generateJsonReport(results, createRunMetadata({ totalTrials: 3 }));

    expect(report.aggregated).toBeDefined();
    const aggregated = report.aggregated ?? [];

    expect(aggregated).toHaveLength(2);
    expect(aggregated[0]).toMatchObject({
      lane: 'prompt',
      caseId: 'case-1',
      condition: 'none',
      trials: 3,
    });
    expect(aggregated[1]).toMatchObject({
      lane: 'execution',
      caseId: 'case-2',
      condition: 'self-load',
      trials: 3,
    });

    const promptScores = [1, 0.5, 0];
    const promptPassRate = computePassRate([{ ok: true }, { ok: false }, { ok: false }]);
    const promptScoreCI = computeConfidenceInterval(promptScores);
    const promptMean = computeMean(promptScores);
    const promptStdDev = computeStdDev(promptScores, promptMean);
    const promptAggregation = aggregated[0];

    expect(promptAggregation).toBeDefined();
    expect(promptAggregation?.passRate).toBeCloseTo(promptPassRate.rate);
    expect(promptAggregation?.passRateCI.lower).toBeCloseTo(promptPassRate.ci.lower);
    expect(promptAggregation?.passRateCI.upper).toBeCloseTo(promptPassRate.ci.upper);
    expect(promptAggregation?.meanScore).toBeCloseTo(promptMean);
    expect(promptAggregation?.stdDev).toBeCloseTo(promptStdDev);
    expect(promptAggregation?.scoreCI.lower).toBeCloseTo(promptScoreCI.ci.lower);
    expect(promptAggregation?.scoreCI.upper).toBeCloseTo(promptScoreCI.ci.upper);
    expect(promptAggregation?.minScore).toBe(0);
    expect(promptAggregation?.maxScore).toBe(1);

    const executionScores = [0.2, 0.4, 0.6];
    const executionPassRate = computePassRate([
      { ok: false },
      { ok: true },
      { ok: true },
    ]);
    const executionScoreCI = computeConfidenceInterval(executionScores);
    const executionMean = computeMean(executionScores);
    const executionStdDev = computeStdDev(executionScores, executionMean);
    const executionAggregation = aggregated[1];

    expect(executionAggregation).toBeDefined();
    expect(executionAggregation?.passRate).toBeCloseTo(executionPassRate.rate);
    expect(executionAggregation?.passRateCI.lower).toBeCloseTo(
      executionPassRate.ci.lower,
    );
    expect(executionAggregation?.passRateCI.upper).toBeCloseTo(
      executionPassRate.ci.upper,
    );
    expect(executionAggregation?.meanScore).toBeCloseTo(executionMean);
    expect(executionAggregation?.stdDev).toBeCloseTo(executionStdDev);
    expect(executionAggregation?.scoreCI.lower).toBeCloseTo(
      executionScoreCI.ci.lower,
    );
    expect(executionAggregation?.scoreCI.upper).toBeCloseTo(
      executionScoreCI.ci.upper,
    );
    expect(executionAggregation?.minScore).toBeCloseTo(0.2);
    expect(executionAggregation?.maxScore).toBeCloseTo(0.6);
  });
});

describe('generateMarkdownReport trial aggregation', () => {
  it('includes a Trial Aggregation table for multi-trial runs', () => {
    const markdown = generateMarkdownReport(
      createMultiTrialResults(),
      createRunMetadata({ totalTrials: 3 }),
    );

    const promptPassRate = computePassRate([{ ok: true }, { ok: false }, { ok: false }]);
    const promptScoreCI = computeConfidenceInterval([1, 0.5, 0]);
    const executionPassRate = computePassRate([
      { ok: false },
      { ok: true },
      { ok: true },
    ]);
    const executionScoreCI = computeConfidenceInterval([0.2, 0.4, 0.6]);

    expect(markdown).toContain('## Trial Aggregation');
    expect(markdown).toContain(
      '| Lane | Case | Condition | Trials | Pass Rate | Pass Rate CI | Mean Score | Std Dev | Score CI | Min | Max |',
    );
    expect(markdown).toContain(
      `| \`prompt\` | \`case-1\` | \`none\` | 3 | 33.3% | ${formatConfidenceInterval(promptPassRate.ci, formatPercent)} | 0.500 | 0.500 | ${formatConfidenceInterval(promptScoreCI.ci, formatScore)} | 0.000 | 1.000 |`,
    );
    expect(markdown).toContain(
      `| \`execution\` | \`case-2\` | \`self-load\` | 3 | 66.7% | ${formatConfidenceInterval(executionPassRate.ci, formatPercent)} | 0.400 | 0.200 | ${formatConfidenceInterval(executionScoreCI.ci, formatScore)} | 0.200 | 0.600 |`,
    );
  });

  it('omits the Trial Aggregation section for single-trial runs', () => {
    const markdown = generateMarkdownReport(
      createSingleTrialResults(),
      createRunMetadata({ totalTrials: 1 }),
    );

    expect(markdown).not.toContain('## Trial Aggregation');
  });
});
