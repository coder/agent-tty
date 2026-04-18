import { describe, expect, it } from 'vitest';

import { computeComparisonMetrics } from '../../../evals/lib/matrix.js';
import {
  generateJsonReport,
  generateMarkdownReport,
} from '../../../evals/lib/reporting.js';
import { JsonReportSchema } from '../../../evals/lib/schemas.js';
import {
  computeConfidenceInterval,
  computeMean,
  computePassRate,
  computeStdDev,
} from '../../../evals/lib/statistics.js';
import type {
  EvalResult,
  RunMetadata,
  TokenReportSummary,
} from '../../../evals/lib/types.js';

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

function createSnapshotCheckReport(): NonNullable<
  TokenReportSummary['snapshotCheck']
> {
  return {
    regressionThresholdPercent: 10,
    cases: [
      {
        provider: 'stub',
        model: 'stub-model',
        lane: 'prompt',
        caseId: 'case-1',
        condition: 'none',
        caseFingerprint: 'a'.repeat(64),
        totalTokens: 130,
        outcome: 'regressed',
        currentTotalTokens: 130,
        snapshotTotalTokens: 100,
        deltaTokens: 30,
        deltaPercent: 30,
      },
    ],
    summary: {
      total: 1,
      new: 0,
      orphaned: 0,
      unchanged: 0,
      improved: 0,
      regressed: 1,
    },
  };
}

function createTokenReportSummary(
  overrides: Omit<Partial<TokenReportSummary>, 'grandTotal'> & {
    grandTotal?: Partial<TokenReportSummary['grandTotal']>;
  } = {},
): TokenReportSummary {
  const base: TokenReportSummary = {
    grandTotal: {
      inputTokens: 120,
      outputTokens: 45,
      totalTokens: 165,
      cachedTokens: 15,
      trials: 3,
    },
    perLane: [
      {
        lane: 'prompt',
        inputTokens: 80,
        outputTokens: 25,
        totalTokens: 105,
        cachedTokens: 10,
        trials: 2,
      },
      {
        lane: 'execution',
        inputTokens: 40,
        outputTokens: 20,
        totalTokens: 60,
        cachedTokens: 5,
        trials: 1,
      },
    ],
    perCase: [
      {
        lane: 'prompt',
        caseId: 'case-1',
        condition: 'none',
        inputTokens: 80,
        outputTokens: 25,
        totalTokens: 105,
        cachedTokens: 10,
        trials: 2,
      },
      {
        lane: 'execution',
        caseId: 'case-2',
        condition: 'self-load',
        inputTokens: 40,
        outputTokens: 20,
        totalTokens: 60,
        cachedTokens: 5,
        trials: 1,
      },
    ],
  };

  return {
    ...base,
    ...overrides,
    grandTotal: {
      ...base.grandTotal,
      ...overrides.grandTotal,
    },
    perLane: overrides.perLane ?? base.perLane,
    perCase: overrides.perCase ?? base.perCase,
  };
}

const LEGACY_EXPECTED_JSON = `{
  "metadata": {
    "runId": "report-run",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "repoRoot": "/tmp/report-repo",
    "providers": [
      "stub"
    ],
    "models": [],
    "lanes": [
      "prompt",
      "execution"
    ],
    "conditions": [
      "none",
      "self-load"
    ],
    "totalTrials": 1,
    "notes": []
  },
  "aggregate": {
    "totalCases": 2,
    "passed": 1,
    "failed": 1,
    "passRate": 0.5,
    "averageScore": 0.6,
    "workflowComplianceRate": 0,
    "antiPatternIncidenceRate": 0
  },
  "comparisons": [],
  "results": [
    {
      "runId": "report-run",
      "providerId": "stub",
      "lane": "prompt",
      "caseId": "case-1",
      "category": "trigger",
      "condition": "none",
      "expectedSkill": "agent-tty",
      "trial": 1,
      "ok": true,
      "score": {
        "total": 10,
        "maxPossible": 10,
        "items": []
      },
      "workflowChecks": [],
      "antiPatternFindings": [],
      "normalizedOutput": {
        "finalText": "",
        "messages": [],
        "referencedSkills": [],
        "toolCalls": []
      },
      "startedAt": "2026-01-01T00:00:00.000Z",
      "completedAt": "2026-01-01T00:00:01.000Z",
      "durationMs": 1000
    },
    {
      "runId": "report-run",
      "providerId": "stub",
      "lane": "execution",
      "caseId": "case-2",
      "category": "session",
      "condition": "self-load",
      "expectedSkill": "agent-tty",
      "trial": 1,
      "ok": false,
      "score": {
        "total": 2,
        "maxPossible": 10,
        "items": []
      },
      "workflowChecks": [],
      "antiPatternFindings": [],
      "normalizedOutput": {
        "finalText": "",
        "messages": [],
        "referencedSkills": [],
        "toolCalls": []
      },
      "startedAt": "2026-01-01T00:00:00.000Z",
      "completedAt": "2026-01-01T00:00:01.000Z",
      "durationMs": 1000
    }
  ],
  "aggregateMetrics": {
    "totalCases": 2,
    "passed": 1,
    "failed": 1,
    "passRate": 0.5,
    "averageScore": 0.6,
    "medianScore": 0.6,
    "minScore": 0.2,
    "maxScore": 1,
    "workflowComplianceRate": 0,
    "antiPatternIncidenceRate": 0
  },
  "laneSummaries": {
    "prompt": {
      "totalCases": 1,
      "passed": 1,
      "failed": 0,
      "passRate": 1,
      "averageScore": 1,
      "medianScore": 1,
      "minScore": 1,
      "maxScore": 1,
      "workflowComplianceRate": 0,
      "antiPatternIncidenceRate": 0
    },
    "execution": {
      "totalCases": 1,
      "passed": 0,
      "failed": 1,
      "passRate": 0,
      "averageScore": 0.2,
      "medianScore": 0.2,
      "minScore": 0.2,
      "maxScore": 0.2,
      "workflowComplianceRate": 0,
      "antiPatternIncidenceRate": 0
    }
  },
  "providerComparisons": [],
  "resultRefs": [
    "case-1",
    "case-2"
  ]
}
`;

const LEGACY_EXPECTED_MARKDOWN = `# Eval Report

## Executive summary

- Run ID: \`report-run\`
- Created: \`2026-01-01T00:00:00.000Z\`
- Repo root: \`/tmp/report-repo\`
- Providers: \`stub\`
- Models: —
- Lanes: \`prompt\`, \`execution\`
- Conditions: \`none\`, \`self-load\`
- Trials: 1
- Total / Passed / Failed: 2 / 1 / 1
- Pass rate / Mean score: 50.0% / 0.600

| Total | Passed | Failed | Pass Rate | Mean | Median | Min | Max |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2 | 1 | 1 | 50.0% | 0.600 | 0.600 | 0.200 | 1.000 |

## Lane breakdown

| Lane | Total | Passed | Failed | Pass Rate | Mean |
| :--- | ---: | ---: | ---: | ---: | ---: |
| \`prompt\` | 1 | 1 | 0 | 100.0% | 1.000 |
| \`execution\` | 1 | 0 | 1 | 0.0% | 0.200 |

## Failed cases

| Case | Lane | Provider | Condition | Score | Error |
| :--- | :--- | :--- | :--- | ---: | :--- |
| \`case-2\` | \`execution\` | \`stub\` | \`self-load\` | 0.200 | — |

## Anti-pattern summary

- None.
`;

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
    const report = generateJsonReport(
      results,
      createRunMetadata({ totalTrials: 3 }),
    );

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
    const promptPassRate = computePassRate([
      { ok: true },
      { ok: false },
      { ok: false },
    ]);
    const promptScoreCI = computeConfidenceInterval(promptScores);
    const promptMean = computeMean(promptScores);
    const promptStdDev = computeStdDev(promptScores, promptMean);
    const promptAggregation = aggregated[0];

    expect(promptAggregation).toBeDefined();
    expect(promptAggregation?.passRate).toBeCloseTo(promptPassRate.rate);
    expect(promptAggregation?.passRateCI.lower).toBeCloseTo(
      promptPassRate.ci.lower,
    );
    expect(promptAggregation?.passRateCI.upper).toBeCloseTo(
      promptPassRate.ci.upper,
    );
    expect(promptAggregation?.meanScore).toBeCloseTo(promptMean);
    expect(promptAggregation?.stdDev).toBeCloseTo(promptStdDev);
    expect(promptAggregation?.scoreCI.lower).toBeCloseTo(
      promptScoreCI.ci.lower,
    );
    expect(promptAggregation?.scoreCI.upper).toBeCloseTo(
      promptScoreCI.ci.upper,
    );
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

    const promptPassRate = computePassRate([
      { ok: true },
      { ok: false },
      { ok: false },
    ]);
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

describe('eval reporting tokenReport', () => {
  it('includes tokenReport in JSON and markdown without snapshotCheck', () => {
    const results = createSingleTrialResults();
    const metadata = createRunMetadata({ totalTrials: 1 });
    const tokenReport = createTokenReportSummary();

    const report = generateJsonReport(results, metadata, [], undefined, tokenReport);
    const markdown = generateMarkdownReport(
      results,
      metadata,
      [],
      undefined,
      tokenReport,
    );

    expect(report.tokenReport).toEqual(tokenReport);
    expect(markdown).toContain('## Token usage');
    expect(markdown).toContain('| Lane | Input | Output | Total | Cached | Trials |');
    expect(markdown).toContain('| `prompt` | 80 | 25 | 105 | 10 | 2 |');
    expect(markdown).toContain(
      '| `execution` | `case-2` | `self-load` | 40 | 20 | 60 | 5 | 1 |',
    );
    expect(markdown).not.toContain('### Snapshot check');
  });

  it('renders snapshotCheck details inside the appended token usage section', () => {
    const results = createSingleTrialResults();
    const metadata = createRunMetadata({ totalTrials: 1 });
    const tokenReport = createTokenReportSummary({
      snapshotCheck: createSnapshotCheckReport(),
    });

    const report = generateJsonReport(results, metadata, [], undefined, tokenReport);
    const markdown = generateMarkdownReport(
      results,
      metadata,
      [],
      undefined,
      tokenReport,
    );

    expect(report.tokenReport?.snapshotCheck).toEqual(tokenReport.snapshotCheck);
    expect(markdown).toContain('### Snapshot check');
    expect(markdown).toContain(
      '- Warning: 1 regressed snapshot case(s) exceeded the threshold.',
    );
    expect(markdown).toContain(
      '| `stub` | `stub-model` | `prompt` | `case-1` | `none` | `regressed` | 130 | 100 | 30 | 30.0% |',
    );
    expect(markdown.indexOf('## Token usage')).toBeGreaterThan(
      markdown.indexOf('## Anti-pattern summary'),
    );
  });

  it('keeps legacy JSON and Markdown byte-identical when no tokenReport is supplied', () => {
    const results = createSingleTrialResults();
    const metadata = createRunMetadata({ totalTrials: 1 });

    const json = `${JSON.stringify(generateJsonReport(results, metadata), null, 2)}\n`;
    const markdown = generateMarkdownReport(results, metadata);

    expect(json).toBe(LEGACY_EXPECTED_JSON);
    expect(markdown).toBe(LEGACY_EXPECTED_MARKDOWN);
  });

  it('omits tokenReport and the markdown section when grandTotal.trials is zero', () => {
    const results = createSingleTrialResults();
    const metadata = createRunMetadata({ totalTrials: 1 });
    const tokenReport = createTokenReportSummary({
      grandTotal: { trials: 0 },
      perLane: [],
      perCase: [],
    });

    const json = `${JSON.stringify(generateJsonReport(results, metadata, [], undefined, tokenReport), null, 2)}\n`;
    const markdown = generateMarkdownReport(
      results,
      metadata,
      [],
      undefined,
      tokenReport,
    );

    expect(json).toBe(LEGACY_EXPECTED_JSON);
    expect(markdown).toBe(LEGACY_EXPECTED_MARKDOWN);
  });

  it('rejects invalid tokenReport payloads with unknown keys and non-integer counts', () => {
    const results = createSingleTrialResults();
    const metadata = createRunMetadata({ totalTrials: 1 });
    const tokenReport = createTokenReportSummary();

    expect(() =>
      generateJsonReport(results, metadata, [], undefined, {
        ...tokenReport,
        perLane: [
          {
            ...tokenReport.perLane[0],
            unexpected: 1,
          },
        ],
      } as unknown as TokenReportSummary),
    ).toThrow(/Unrecognized key/);

    expect(() =>
      generateJsonReport(results, metadata, [], undefined, {
        ...tokenReport,
        grandTotal: {
          ...tokenReport.grandTotal,
          totalTokens: 165.5,
        },
      } as unknown as TokenReportSummary),
    ).toThrow(/totalTokens/);
  });
});

describe('eval reporting condition comparison summary', () => {
  function createConditionComparisonMetadata(): RunMetadata {
    return {
      runId: 'run-1',
      createdAt: '2025-01-01T00:00:00.000Z',
      repoRoot: '/repo',
      outputBaseDir: '/tmp/evals/out',
      providers: ['stub'],
      models: ['stub'],
      lanes: ['execution'],
      conditions: ['none', 'preloaded'],
      totalTrials: 1,
      notes: [],
    };
  }

  function createConditionComparisonResults(): EvalResult[] {
    return [
      createEvalResult({
        runId: 'run-1',
        lane: 'execution',
        category: 'session',
        caseId: 'case-1',
        condition: 'none',
        ok: false,
        score: { total: 0.2, maxPossible: 1, items: [] },
        startedAt: '2025-01-01T00:00:00.000Z',
        completedAt: '2025-01-01T00:00:01.000Z',
      }),
      createEvalResult({
        runId: 'run-1',
        lane: 'execution',
        category: 'session',
        caseId: 'case-1',
        condition: 'preloaded',
        trial: 2,
        score: { total: 0.8, maxPossible: 1, items: [] },
        startedAt: '2025-01-01T00:00:00.000Z',
        completedAt: '2025-01-01T00:00:01.000Z',
      }),
      createEvalResult({
        runId: 'run-1',
        lane: 'execution',
        category: 'session',
        caseId: 'case-2',
        condition: 'none',
        trial: 3,
        ok: false,
        score: { total: 0.4, maxPossible: 1, items: [] },
        startedAt: '2025-01-01T00:00:00.000Z',
        completedAt: '2025-01-01T00:00:01.000Z',
      }),
      createEvalResult({
        runId: 'run-1',
        lane: 'execution',
        category: 'session',
        caseId: 'case-2',
        condition: 'preloaded',
        trial: 4,
        score: { total: 1, maxPossible: 1, items: [] },
        startedAt: '2025-01-01T00:00:00.000Z',
        completedAt: '2025-01-01T00:00:01.000Z',
      }),
    ];
  }

  it('adds a structured condition comparison summary to the JSON report', () => {
    const results = createConditionComparisonResults();
    const metadata = createConditionComparisonMetadata();
    const comparisons = computeComparisonMetrics(results);

    const report = generateJsonReport(results, metadata, comparisons);

    expect(report.metadata.outputBaseDir).toBe('/tmp/evals/out');
    expect(report.conditionComparisonSummary).toBeDefined();
    const summary = report.conditionComparisonSummary;
    if (summary === undefined) {
      throw new Error('Expected conditionComparisonSummary to be defined');
    }

    expect(summary.comparedConditions).toEqual(['none', 'preloaded']);
    expect(summary.comparedGroups).toBe(2);
    expect(summary.comparedCases).toBe(2);
    expect(
      summary.conditionBreakdown.map((row) => [
        row.condition,
        row.totalCases,
        row.passed,
        row.failed,
      ]),
    ).toEqual([
      ['none', 2, 0, 2],
      ['preloaded', 2, 2, 0],
    ]);
    expect(summary.conditionBreakdown[0]?.averageScore).toBeCloseTo(0.3);
    expect(summary.conditionBreakdown[1]?.averageScore).toBeCloseTo(0.9);
    expect(summary.keyDeltas.realizedSkillLift).toBeCloseTo(0);
    expect(summary.keyDeltas.oracleSkillLift).toBeCloseTo(0.6);

    expect(() =>
      JsonReportSchema.parse({
        metadata: report.metadata,
        aggregate: report.aggregate,
        conditionComparisonSummary: report.conditionComparisonSummary,
        comparisons: report.comparisons,
        results: report.results,
        ...(report.providerComparison === undefined
          ? {}
          : { providerComparison: report.providerComparison }),
      }),
    ).not.toThrow();
  });

  it('promotes the condition comparison summary near the top of the markdown report', () => {
    const results = createConditionComparisonResults().slice(0, 2);
    const metadata = createConditionComparisonMetadata();
    const comparisons = computeComparisonMetrics(results);

    const markdown = generateMarkdownReport(results, metadata, comparisons);

    expect(markdown).toContain('- Output directory: `/tmp/evals/out`');
    expect(markdown).toContain('## Condition comparison');
    expect(markdown).toContain('- Compared conditions: `none`, `preloaded`');
    expect(markdown).toContain('| `none` | 1 | 0 | 1 | 0.0% | 0.200 |');
    expect(markdown).toContain('| `preloaded` | 1 | 1 | 0 | 100.0% | 0.800 |');
    expect(markdown).toContain('| Realized skill lift | 0.0% |');
    expect(markdown).toContain('| Oracle skill lift | 60.0% |');
    expect(markdown.indexOf('## Condition comparison')).toBeLessThan(
      markdown.indexOf('## Lane breakdown'),
    );
  });
});
