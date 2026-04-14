import { invariant } from '../../src/util/assert.js';
import { AggregateMetricsSchema, JsonReportSchema } from './schemas.js';
import { computeAggregateMetrics } from './scoring.js';
import type {
  AggregateMetrics,
  AntiPatternSeverity,
  ComparisonMetrics,
  EvalLane,
  EvalResult,
  JsonReport,
  MatrixEntry,
  ProviderComparisonReport,
  RunMetadata,
  SkillCondition,
} from './types.js';

const LANE_ORDER: readonly EvalLane[] = ['prompt', 'execution', 'dogfood'];
const CONDITION_ORDER: readonly SkillCondition[] = [
  'none',
  'self-load',
  'preloaded',
  'stale',
];
const MAX_ERROR_LENGTH = 120;

type ComparisonMetricsInput =
  | ComparisonMetrics
  | ComparisonMetrics[]
  | undefined;

type AggregateMetricsWithStats = AggregateMetrics & {
  medianScore: number;
  minScore: number;
  maxScore: number;
};

interface PairwiseProviderComparisonReport {
  providers: string[];
  conditionBreakdowns: Record<string, AggregateMetricsWithStats>;
  comparisonMetrics: ComparisonMetrics[];
}

interface RichJsonReport {
  aggregateMetrics: AggregateMetricsWithStats;
  laneSummaries: Record<string, AggregateMetricsWithStats>;
  providerComparisons: PairwiseProviderComparisonReport[];
  resultRefs: string[];
}

interface AntiPatternSummaryRow {
  ruleId: string;
  count: number;
  affectedCases: number;
  highestSeverity: AntiPatternSeverity;
}

/**
 * Generate a deterministic JSON report from eval results and optional
 * comparison metrics.
 */
export function generateJsonReport(
  results: EvalResult[],
  metadata: RunMetadata,
  comparisonMetrics?: ComparisonMetrics | ComparisonMetrics[],
): JsonReport {
  assertResults(results);
  assertMetadata(metadata);

  const sortedResults = sortResults(results);
  const normalizedComparisons = normalizeComparisonMetrics(comparisonMetrics);
  const aggregateMetrics = buildAggregateMetrics(sortedResults);
  const aggregate = toAggregateMetricsCore(aggregateMetrics);
  const laneSummaries = buildLaneSummaries(sortedResults, metadata.lanes);
  const providerComparisons = buildPairwiseProviderComparisons(
    sortedResults,
    normalizedComparisons,
  );
  const providerComparison = buildProviderComparisonReport(
    sortedResults,
    metadata,
    normalizedComparisons,
  );
  const resultRefs = sortedResults.map((result) => result.caseId);

  const coreReport = {
    metadata,
    aggregate,
    comparisons: normalizedComparisons,
    results: sortedResults,
    ...(providerComparison === undefined ? {} : { providerComparison }),
  } satisfies JsonReport;

  JsonReportSchema.parse(coreReport);

  const report: JsonReport & RichJsonReport = {
    ...coreReport,
    aggregateMetrics,
    laneSummaries,
    providerComparisons,
    resultRefs,
  };

  return report;
}

/**
 * Generate a concise Markdown report with summary tables and key failure
 * highlights.
 */
export function generateMarkdownReport(
  results: EvalResult[],
  metadata: RunMetadata,
  comparisonMetrics?: ComparisonMetrics | ComparisonMetrics[],
): string {
  assertResults(results);
  assertMetadata(metadata);

  const report = generateJsonReport(
    results,
    metadata,
    comparisonMetrics,
  ) as JsonReport & RichJsonReport;
  const providers = collectProviders(report.results, report.metadata.providers);
  const lanes = collectLanes(report.results, report.metadata.lanes);
  const conditions = collectConditions(
    report.results,
    report.metadata.conditions,
  );
  const failedResults = sortFailedResults(
    report.results.filter((result) => !result.ok),
  );
  const antiPatternRows = summarizeAntiPatterns(report.results);
  const completenessRows = buildCompletenessRows(
    report.results,
    report.aggregateMetrics,
  );
  const sections: string[] = [
    '# Eval Report',
    '',
    '## Executive summary',
    '',
    `- Run ID: \`${sanitizeInline(report.metadata.runId)}\``,
    `- Created: \`${sanitizeInline(report.metadata.createdAt)}\``,
    `- Repo root: \`${sanitizeInline(report.metadata.repoRoot)}\``,
    `- Providers: ${formatList(providers.map((providerId) => `\`${providerId}\``))}`,
    `- Models: ${formatList(
      [...report.metadata.models]
        .sort(compareStrings)
        .map((modelId) => `\`${sanitizeInline(modelId)}\``),
    )}`,
    `- Lanes: ${formatList(lanes.map((lane) => `\`${lane}\``))}`,
    `- Conditions: ${formatList(
      conditions.map((condition) => `\`${condition}\``),
    )}`,
    `- Trials: ${String(report.metadata.totalTrials)}`,
    `- Total / Passed / Failed: ${String(report.aggregateMetrics.totalCases)} / ${String(report.aggregateMetrics.passed)} / ${String(report.aggregateMetrics.failed)}`,
    `- Pass rate / Mean score: ${formatPercent(report.aggregateMetrics.passRate)} / ${formatScore(report.aggregateMetrics.averageScore)}`,
  ];

  if (report.metadata.notes.length > 0) {
    sections.push(
      `- Notes: ${report.metadata.notes
        .map((note) => sanitizeInline(note))
        .join('; ')}`,
    );
  }

  sections.push('', formatSummaryTable(report.aggregateMetrics));

  if (lanes.length > 0) {
    sections.push('', '## Lane breakdown', '');
    sections.push(
      buildMarkdownTable(
        ['Lane', 'Total', 'Passed', 'Failed', 'Pass Rate', 'Mean'],
        ['left', 'right', 'right', 'right', 'right', 'right'],
        lanes.map((lane) => {
          const metrics =
            report.laneSummaries[lane] ??
            buildAggregateMetrics([] as EvalResult[]);
          return [
            `\`${lane}\``,
            String(metrics.totalCases),
            String(metrics.passed),
            String(metrics.failed),
            formatPercent(metrics.passRate),
            formatScore(metrics.averageScore),
          ];
        }),
      ),
    );
  }

  if (providers.length > 1) {
    sections.push('', '## Provider comparison', '');
    sections.push(
      buildMarkdownTable(
        ['Provider', 'Lane', 'Total', 'Passed', 'Failed', 'Pass Rate', 'Mean'],
        ['left', 'left', 'right', 'right', 'right', 'right', 'right'],
        buildProviderLaneRows(report.results, providers, lanes),
      ),
    );
  }

  if (report.comparisons.length > 0) {
    sections.push('', '## Condition comparison', '');
    sections.push(
      buildMarkdownTable(
        ['Metric', 'Value'],
        ['left', 'right'],
        [
          ['Compared groups', String(report.comparisons.length)],
          [
            'Compared cases',
            String(
              report.comparisons.reduce(
                (count, metric) => count + metric.totalCompared,
                0,
              ),
            ),
          ],
          [
            'Realized skill lift',
            formatComparisonValue(
              averageDefined(
                report.comparisons,
                (metric) => metric.realizedSkillLift,
              ),
            ),
          ],
          [
            'Oracle skill lift',
            formatComparisonValue(
              averageDefined(
                report.comparisons,
                (metric) => metric.oracleSkillLift,
              ),
            ),
          ],
          [
            'Routing gap',
            formatComparisonValue(
              averageDefined(report.comparisons, (metric) => metric.routingGap),
            ),
          ],
          [
            'Stale-skill harm',
            formatComparisonValue(
              averageDefined(
                report.comparisons,
                (metric) => metric.staleSkillHarm,
              ),
            ),
          ],
          [
            'Regression rate',
            formatComparisonValue(
              averageDefined(
                report.comparisons,
                (metric) => metric.regressionRate,
              ),
            ),
          ],
          [
            'Unlock rate',
            formatComparisonValue(
              averageDefined(report.comparisons, (metric) => metric.unlockRate),
            ),
          ],
          [
            'Routing efficiency',
            formatComparisonValue(
              averageDefined(
                report.comparisons,
                (metric) => metric.routingEfficiency,
              ),
            ),
          ],
        ],
      ),
    );
  }

  sections.push('', '## Failed cases', '');
  if (failedResults.length === 0) {
    sections.push('- None.');
  } else {
    sections.push(
      buildMarkdownTable(
        ['Case', 'Lane', 'Provider', 'Condition', 'Score', 'Error'],
        ['left', 'left', 'left', 'left', 'right', 'left'],
        failedResults.map((result) => [
          `\`${sanitizeInline(result.caseId)}\``,
          `\`${result.lane}\``,
          `\`${sanitizeInline(result.providerId)}\``,
          `\`${result.condition}\``,
          formatScore(normalizeScore(result)),
          formatError(result),
        ]),
      ),
    );
  }

  sections.push('', '## Anti-pattern summary', '');
  if (antiPatternRows.length === 0) {
    sections.push('- None.');
  } else {
    sections.push(
      buildMarkdownTable(
        ['Rule', 'Findings', 'Affected Cases', 'Highest Severity'],
        ['left', 'right', 'right', 'left'],
        antiPatternRows.map((row) => [
          `\`${sanitizeInline(row.ruleId)}\``,
          String(row.count),
          String(row.affectedCases),
          `\`${row.highestSeverity}\``,
        ]),
      ),
    );
  }

  if (completenessRows.length > 0) {
    sections.push('', '## Completeness summary', '');
    sections.push(
      buildMarkdownTable(
        ['Metric', 'Average', 'Coverage'],
        ['left', 'right', 'right'],
        completenessRows,
      ),
    );
  }

  return `${sections.join('\n').trimEnd()}\n`;
}

/**
 * Build deterministic pairwise provider comparisons with per-condition
 * aggregate breakdowns.
 */
export function generateProviderComparison(
  results: EvalResult[],
  comparisonMetrics?: ComparisonMetrics | ComparisonMetrics[],
): ProviderComparisonReport[] {
  assertResults(results);
  const normalizedComparisons = normalizeComparisonMetrics(comparisonMetrics);
  return buildPairwiseProviderComparisons(
    sortResults(results),
    normalizedComparisons,
  ) as unknown as ProviderComparisonReport[];
}

/**
 * Format aggregate metrics as a compact Markdown summary table.
 */
export function formatSummaryTable(metrics: AggregateMetrics): string {
  invariant(
    typeof metrics.totalCases === 'number',
    'Metrics totalCases must be a number',
  );
  invariant(
    typeof metrics.passed === 'number',
    'Metrics passed must be a number',
  );
  invariant(
    typeof metrics.failed === 'number',
    'Metrics failed must be a number',
  );
  invariant(
    typeof metrics.passRate === 'number',
    'Metrics passRate must be a number',
  );
  invariant(
    typeof metrics.averageScore === 'number',
    'Metrics averageScore must be a number',
  );

  const enrichedMetrics = resolveAggregateStats(metrics);
  return buildMarkdownTable(
    ['Total', 'Passed', 'Failed', 'Pass Rate', 'Mean', 'Median', 'Min', 'Max'],
    ['right', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
    [
      [
        String(enrichedMetrics.totalCases),
        String(enrichedMetrics.passed),
        String(enrichedMetrics.failed),
        formatPercent(enrichedMetrics.passRate),
        formatScore(enrichedMetrics.averageScore),
        formatScore(enrichedMetrics.medianScore),
        formatScore(enrichedMetrics.minScore),
        formatScore(enrichedMetrics.maxScore),
      ],
    ],
  );
}

function assertResults(results: EvalResult[]): void {
  invariant(Array.isArray(results), 'Eval results must be an array');
}

function assertMetadata(metadata: RunMetadata): void {
  invariant(
    typeof metadata.runId === 'string' && metadata.runId.length > 0,
    'Run metadata runId must be a non-empty string',
  );
  invariant(
    Array.isArray(metadata.providers),
    'Run metadata providers must be an array',
  );
  invariant(
    Array.isArray(metadata.lanes),
    'Run metadata lanes must be an array',
  );
  invariant(
    Array.isArray(metadata.conditions),
    'Run metadata conditions must be an array',
  );
}

function normalizeComparisonMetrics(
  comparisonMetrics: ComparisonMetricsInput,
): ComparisonMetrics[] {
  if (comparisonMetrics === undefined) {
    return [];
  }

  const comparisons = Array.isArray(comparisonMetrics)
    ? [...comparisonMetrics]
    : [comparisonMetrics];

  return comparisons.sort(compareComparisonMetrics);
}

function buildAggregateMetrics(
  results: EvalResult[],
): AggregateMetricsWithStats {
  const rawMetrics = computeAggregateMetrics(results) as AggregateMetrics &
    Partial<
      Pick<AggregateMetricsWithStats, 'medianScore' | 'minScore' | 'maxScore'>
    >;
  const metrics: AggregateMetricsWithStats = {
    totalCases: rawMetrics.totalCases,
    passed: rawMetrics.passed,
    failed: rawMetrics.failed,
    passRate: rawMetrics.passRate,
    averageScore: rawMetrics.averageScore,
    medianScore: readAggregateStat(
      rawMetrics.medianScore,
      rawMetrics.averageScore,
    ),
    minScore: readAggregateStat(rawMetrics.minScore, rawMetrics.averageScore),
    maxScore: readAggregateStat(rawMetrics.maxScore, rawMetrics.averageScore),
    workflowComplianceRate: rawMetrics.workflowComplianceRate,
    antiPatternIncidenceRate: rawMetrics.antiPatternIncidenceRate,
    ...(results.some((result) => result.bundleCompleteness !== undefined)
      ? { bundleCompletenessRate: rawMetrics.bundleCompletenessRate ?? 0 }
      : {}),
    ...(results.some((result) => result.reportCompleteness !== undefined)
      ? { reportCompletenessRate: rawMetrics.reportCompletenessRate ?? 0 }
      : {}),
    ...(results.some((result) => result.evidenceQuality !== undefined)
      ? { evidenceQualityRate: rawMetrics.evidenceQualityRate ?? 0 }
      : {}),
  };

  AggregateMetricsSchema.parse(toAggregateMetricsCore(metrics));

  return metrics;
}

function toAggregateMetricsCore(
  metrics: AggregateMetricsWithStats,
): AggregateMetrics {
  const coreMetrics: AggregateMetrics = {
    totalCases: metrics.totalCases,
    passed: metrics.passed,
    failed: metrics.failed,
    passRate: metrics.passRate,
    averageScore: metrics.averageScore,
    workflowComplianceRate: metrics.workflowComplianceRate,
    antiPatternIncidenceRate: metrics.antiPatternIncidenceRate,
  };

  if (metrics.bundleCompletenessRate !== undefined) {
    coreMetrics.bundleCompletenessRate = metrics.bundleCompletenessRate;
  }
  if (metrics.reportCompletenessRate !== undefined) {
    coreMetrics.reportCompletenessRate = metrics.reportCompletenessRate;
  }
  if (metrics.evidenceQualityRate !== undefined) {
    coreMetrics.evidenceQualityRate = metrics.evidenceQualityRate;
  }

  AggregateMetricsSchema.parse(coreMetrics);
  return coreMetrics;
}

function resolveAggregateStats(
  metrics: AggregateMetrics,
): AggregateMetricsWithStats {
  const enrichedMetrics = metrics as Partial<AggregateMetricsWithStats> &
    AggregateMetrics;
  return {
    ...metrics,
    medianScore: readAggregateStat(
      enrichedMetrics.medianScore,
      enrichedMetrics.averageScore,
    ),
    minScore: readAggregateStat(
      enrichedMetrics.minScore,
      enrichedMetrics.averageScore,
    ),
    maxScore: readAggregateStat(
      enrichedMetrics.maxScore,
      enrichedMetrics.averageScore,
    ),
  };
}

function readAggregateStat(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function buildLaneSummaries(
  results: EvalResult[],
  metadataLanes: readonly EvalLane[],
): Record<string, AggregateMetricsWithStats> {
  const laneSummaries: Record<string, AggregateMetricsWithStats> = {};

  for (const lane of collectLanes(results, metadataLanes)) {
    laneSummaries[lane] = buildAggregateMetrics(
      results.filter((result) => result.lane === lane),
    );
  }

  return laneSummaries;
}

function buildPairwiseProviderComparisons(
  results: EvalResult[],
  comparisons: ComparisonMetrics[],
): PairwiseProviderComparisonReport[] {
  const providerIds = collectProviders(results);
  const reports: PairwiseProviderComparisonReport[] = [];

  for (let leftIndex = 0; leftIndex < providerIds.length; leftIndex += 1) {
    const leftProvider = providerIds[leftIndex];
    invariant(leftProvider !== undefined, 'Left provider must exist');

    for (
      let rightIndex = leftIndex + 1;
      rightIndex < providerIds.length;
      rightIndex += 1
    ) {
      const rightProvider = providerIds[rightIndex];
      invariant(rightProvider !== undefined, 'Right provider must exist');
      const pairProviders = [leftProvider, rightProvider];
      const pairResults = results.filter((result) =>
        pairProviders.includes(result.providerId),
      );
      const pairComparisons = comparisons.filter((metric) =>
        pairProviders.includes(metric.providerId),
      );
      const conditionBreakdowns: Record<string, AggregateMetricsWithStats> = {};

      for (const condition of collectConditions(pairResults)) {
        conditionBreakdowns[condition] = buildAggregateMetrics(
          pairResults.filter((result) => result.condition === condition),
        );
      }

      reports.push({
        providers: pairProviders,
        conditionBreakdowns,
        comparisonMetrics: pairComparisons,
      });
    }
  }

  return reports;
}

function buildProviderComparisonReport(
  results: EvalResult[],
  metadata: RunMetadata,
  comparisons: ComparisonMetrics[],
): ProviderComparisonReport | undefined {
  const providerIds = collectProviders(results, metadata.providers);
  if (providerIds.length < 2) {
    return undefined;
  }

  return {
    metadata,
    aggregate: toAggregateMetricsCore(buildAggregateMetrics(results)),
    matrix: buildMatrixEntries(results),
    providers: providerIds.map((providerId) => {
      const providerResults = results.filter(
        (result) => result.providerId === providerId,
      );
      return {
        providerId,
        aggregate: toAggregateMetricsCore(
          buildAggregateMetrics(providerResults),
        ),
        comparisons: comparisons.filter(
          (metric) => metric.providerId === providerId,
        ),
        results: providerResults,
      };
    }),
    comparisons,
  };
}

function buildMatrixEntries(results: EvalResult[]): MatrixEntry[] {
  const entries = new Map<string, MatrixEntry>();

  for (const result of results) {
    const key = [
      result.providerId,
      result.lane,
      result.caseId,
      result.category,
      result.condition,
      result.expectedSkill,
    ].join('\u0000');

    if (!entries.has(key)) {
      entries.set(key, {
        providerId: result.providerId,
        lane: result.lane,
        caseId: result.caseId,
        category: result.category,
        condition: result.condition,
        expectedSkill: result.expectedSkill,
      });
    }
  }

  return [...entries.values()].sort(
    (left, right) =>
      compareStrings(left.providerId, right.providerId) ||
      compareLane(left.lane, right.lane) ||
      compareStrings(left.caseId, right.caseId) ||
      compareStrings(left.category, right.category) ||
      compareCondition(left.condition, right.condition) ||
      compareStrings(left.expectedSkill, right.expectedSkill),
  );
}

function buildProviderLaneRows(
  results: EvalResult[],
  providers: readonly string[],
  lanes: readonly EvalLane[],
): string[][] {
  const rows: string[][] = [];

  for (const providerId of providers) {
    for (const lane of lanes) {
      const metrics = buildAggregateMetrics(
        results.filter(
          (result) => result.providerId === providerId && result.lane === lane,
        ),
      );
      rows.push([
        `\`${sanitizeInline(providerId)}\``,
        `\`${lane}\``,
        String(metrics.totalCases),
        String(metrics.passed),
        String(metrics.failed),
        formatPercent(metrics.passRate),
        formatScore(metrics.averageScore),
      ]);
    }
  }

  return rows;
}

function buildCompletenessRows(
  results: EvalResult[],
  aggregateMetrics: AggregateMetricsWithStats,
): string[][] {
  const rows: string[][] = [];
  const totalResults = results.length;
  const bundleCount = results.filter(
    (result) => result.bundleCompleteness !== undefined,
  ).length;
  const reportCount = results.filter(
    (result) => result.reportCompleteness !== undefined,
  ).length;
  const evidenceCount = results.filter(
    (result) => result.evidenceQuality !== undefined,
  ).length;

  if (
    bundleCount > 0 &&
    aggregateMetrics.bundleCompletenessRate !== undefined
  ) {
    rows.push([
      'Bundle completeness',
      formatPercent(aggregateMetrics.bundleCompletenessRate),
      `${String(bundleCount)}/${String(totalResults)}`,
    ]);
  }

  if (
    reportCount > 0 &&
    aggregateMetrics.reportCompletenessRate !== undefined
  ) {
    rows.push([
      'Report completeness',
      formatPercent(aggregateMetrics.reportCompletenessRate),
      `${String(reportCount)}/${String(totalResults)}`,
    ]);
  }

  if (evidenceCount > 0 && aggregateMetrics.evidenceQualityRate !== undefined) {
    rows.push([
      'Evidence quality',
      formatPercent(aggregateMetrics.evidenceQualityRate),
      `${String(evidenceCount)}/${String(totalResults)}`,
    ]);
  }

  return rows;
}

function summarizeAntiPatterns(results: EvalResult[]): AntiPatternSummaryRow[] {
  const summaries = new Map<
    string,
    { count: number; cases: Set<string>; highestSeverity: AntiPatternSeverity }
  >();

  for (const result of results) {
    for (const finding of result.antiPatternFindings) {
      const existing = summaries.get(finding.ruleId);
      if (existing === undefined) {
        summaries.set(finding.ruleId, {
          count: 1,
          cases: new Set([result.caseId]),
          highestSeverity: finding.severity,
        });
        continue;
      }

      existing.count += 1;
      existing.cases.add(result.caseId);
      if (compareSeverity(finding.severity, existing.highestSeverity) > 0) {
        existing.highestSeverity = finding.severity;
      }
    }
  }

  return [...summaries.entries()]
    .map(([ruleId, summary]) => ({
      ruleId,
      count: summary.count,
      affectedCases: summary.cases.size,
      highestSeverity: summary.highestSeverity,
    }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        compareSeverity(right.highestSeverity, left.highestSeverity) ||
        compareStrings(left.ruleId, right.ruleId),
    );
}

function sortResults(results: EvalResult[]): EvalResult[] {
  return [...results].sort(
    (left, right) =>
      compareStrings(left.providerId, right.providerId) ||
      compareLane(left.lane, right.lane) ||
      compareCondition(left.condition, right.condition) ||
      compareStrings(left.caseId, right.caseId) ||
      left.trial - right.trial ||
      compareStrings(left.runId, right.runId) ||
      compareStrings(left.startedAt, right.startedAt) ||
      compareStrings(left.completedAt, right.completedAt),
  );
}

function sortFailedResults(results: EvalResult[]): EvalResult[] {
  return [...results].sort(
    (left, right) =>
      normalizeScore(left) - normalizeScore(right) ||
      compareStrings(left.caseId, right.caseId) ||
      compareStrings(left.providerId, right.providerId) ||
      compareLane(left.lane, right.lane) ||
      compareCondition(left.condition, right.condition),
  );
}

function normalizeScore(result: EvalResult): number {
  if (result.score.maxPossible <= 0) {
    return 0;
  }

  const score = result.score.total / result.score.maxPossible;
  if (!Number.isFinite(score)) {
    return 0;
  }
  if (score < 0) {
    return 0;
  }
  if (score > 1) {
    return 1;
  }

  return score;
}

function collectProviders(
  results: EvalResult[],
  metadataProviders: readonly string[] = [],
): string[] {
  const providers = new Set<string>(metadataProviders);
  for (const result of results) {
    providers.add(result.providerId);
  }

  return [...providers].sort(compareStrings);
}

function collectLanes(
  results: EvalResult[],
  metadataLanes: readonly EvalLane[] = [],
): EvalLane[] {
  const lanes = new Set<EvalLane>(metadataLanes);
  for (const result of results) {
    lanes.add(result.lane);
  }

  return [...lanes].sort(compareLane);
}

function collectConditions(
  results: EvalResult[],
  metadataConditions: readonly SkillCondition[] = [],
): SkillCondition[] {
  const conditions = new Set<SkillCondition>(metadataConditions);
  for (const result of results) {
    conditions.add(result.condition);
  }

  return [...conditions].sort(compareCondition);
}

function compareComparisonMetrics(
  left: ComparisonMetrics,
  right: ComparisonMetrics,
): number {
  return (
    compareStrings(left.providerId, right.providerId) ||
    compareLane(left.lane, right.lane) ||
    compareStrings(left.groupKey, right.groupKey) ||
    compareStrings(left.expectedSkill, right.expectedSkill) ||
    compareOptionalString(left.category, right.category) ||
    compareOptionalString(left.fixture, right.fixture) ||
    compareOptionalString(left.target, right.target) ||
    left.totalCompared - right.totalCompared
  );
}

function compareLane(left: EvalLane, right: EvalLane): number {
  return compareOrderedValue(left, right, LANE_ORDER);
}

function compareCondition(left: SkillCondition, right: SkillCondition): number {
  return compareOrderedValue(left, right, CONDITION_ORDER);
}

function compareSeverity(
  left: AntiPatternSeverity,
  right: AntiPatternSeverity,
): number {
  return severityRank(left) - severityRank(right);
}

function severityRank(severity: AntiPatternSeverity): number {
  switch (severity) {
    case 'info':
      return 0;
    case 'warning':
      return 1;
    case 'error':
      return 2;
  }
}

function compareOrderedValue<T extends string>(
  left: T,
  right: T,
  order: readonly T[],
): number {
  const leftIndex = order.indexOf(left);
  const rightIndex = order.indexOf(right);

  if (leftIndex !== rightIndex) {
    return leftIndex - rightIndex;
  }

  return compareStrings(left, right);
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function compareOptionalString(
  left: string | undefined,
  right: string | undefined,
): number {
  return compareStrings(left ?? '', right ?? '');
}

function averageDefined<T>(
  values: readonly T[],
  selector: (value: T) => number | undefined,
): number | undefined {
  const numbers = values
    .map(selector)
    .filter((value): value is number => value !== undefined);
  if (numbers.length === 0) {
    return undefined;
  }

  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatScore(value: number): string {
  return value.toFixed(3);
}

function formatComparisonValue(value: number | undefined): string {
  if (value === undefined) {
    return '—';
  }

  if (Math.abs(value) <= 1) {
    return formatPercent(value);
  }

  return formatScore(value);
}

function formatError(result: EvalResult): string {
  const parts = [result.errorClass, result.errorMessage].filter(
    (part): part is string => part !== undefined,
  );

  if (parts.length === 0) {
    return '—';
  }

  return sanitizeInline(parts.join(': '), MAX_ERROR_LENGTH);
}

function formatList(values: readonly string[]): string {
  return values.length === 0 ? '—' : values.join(', ');
}

function buildMarkdownTable(
  headers: readonly string[],
  alignments: ReadonlyArray<'left' | 'right'>,
  rows: readonly string[][],
): string {
  invariant(
    headers.length === alignments.length,
    'Headers and alignments must have matching lengths',
  );

  const headerRow = `| ${headers.map(escapeMarkdownCell).join(' | ')} |`;
  const alignmentRow = `| ${alignments
    .map((alignment) => (alignment === 'left' ? ':---' : '---:'))
    .join(' | ')} |`;
  const bodyRows = rows.map((row) => {
    invariant(
      row.length === headers.length,
      'Each Markdown table row must match the header length',
    );
    return `| ${row.map(escapeMarkdownCell).join(' | ')} |`;
  });

  return [headerRow, alignmentRow, ...bodyRows].join('\n');
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function sanitizeInline(
  value: string,
  maxLength = Number.POSITIVE_INFINITY,
): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }

  const truncated = collapsed.slice(0, Math.max(0, maxLength - 1)).trimEnd();
  return `${truncated}…`;
}
