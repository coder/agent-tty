import { invariant } from '../../src/util/assert.js';
import { ComparisonMetricsSchema, MatrixEntrySchema } from './schemas.js';
import type {
  ComparisonMetrics,
  EvalCase,
  EvalResult,
  MatrixEntry,
  SkillCondition,
} from './types.js';

/** Canonical ordered skill-condition tuple used throughout eval comparisons. */
export const SKILL_CONDITIONS = Object.freeze([
  'none',
  'self-load',
  'preloaded',
  'stale',
] as const);

const SKILL_CONDITION_SET = new Set<SkillCondition>(SKILL_CONDITIONS);

function assertNonEmptyString(
  value: unknown,
  label: string,
): asserts value is string {
  invariant(
    typeof value === 'string' && value.length > 0,
    `${label} must be a non-empty string`,
  );
}

function assertArrayInput(value: unknown, label: string): void {
  invariant(Array.isArray(value), `${label} must be an array`);
}

function assertFiniteNumber(
  value: unknown,
  label: string,
): asserts value is number {
  invariant(
    typeof value === 'number' && Number.isFinite(value),
    `${label} must be a finite number`,
  );
}

function assertSkillCondition(
  value: unknown,
  label: string,
): asserts value is SkillCondition {
  invariant(
    typeof value === 'string' &&
      SKILL_CONDITION_SET.has(value as SkillCondition),
    `${label} must be a supported skill condition`,
  );
}

function appendGroupValue<K, V>(groups: Map<K, V[]>, key: K, value: V): void {
  const existing = groups.get(key);
  if (existing === undefined) {
    groups.set(key, [value]);
    return;
  }

  existing.push(value);
}

function validateMatrixEntry(entry: MatrixEntry): MatrixEntry {
  const parsedEntry = MatrixEntrySchema.safeParse(entry);
  if (!parsedEntry.success) {
    throw new Error(
      `Matrix entry validation failed for ${entry.caseId}/${entry.providerId}/${entry.condition}: ${parsedEntry.error.message}`,
    );
  }

  return parsedEntry.data as MatrixEntry;
}

function validateComparisonMetrics(
  metrics: ComparisonMetrics,
): ComparisonMetrics {
  const parsedMetrics = ComparisonMetricsSchema.safeParse(metrics);
  if (!parsedMetrics.success) {
    throw new Error(
      `Comparison metrics validation failed for ${metrics.groupKey}: ${parsedMetrics.error.message}`,
    );
  }

  return parsedMetrics.data as ComparisonMetrics;
}

function assertEvalResultBoundary(result: EvalResult): void {
  assertNonEmptyString(result.providerId, 'result.providerId');
  assertNonEmptyString(result.lane, 'result.lane');
  assertNonEmptyString(result.caseId, 'result.caseId');
  assertNonEmptyString(result.category, 'result.category');
  assertNonEmptyString(result.expectedSkill, 'result.expectedSkill');
  assertSkillCondition(result.condition, 'result.condition');
  assertFiniteNumber(result.score.total, 'result.score.total');
}

function resolveConditionList(evalCase: EvalCase): readonly SkillCondition[] {
  if (evalCase.lane === 'prompt') {
    return SKILL_CONDITIONS;
  }

  if (evalCase.conditions.length === 0) {
    return SKILL_CONDITIONS;
  }

  const seenConditions = new Set<SkillCondition>();
  for (const condition of evalCase.conditions) {
    assertSkillCondition(condition, `Case ${evalCase.id} condition`);
    invariant(
      !seenConditions.has(condition),
      `Case ${evalCase.id} conditions must not contain duplicates: ${condition}`,
    );
    seenConditions.add(condition);
  }

  return evalCase.conditions;
}

function computeMean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }

  let total = 0;
  for (const value of values) {
    assertFiniteNumber(value, 'Mean input value');
    total += value;
  }

  return total / values.length;
}

function collectScoreTotals(
  results: readonly EvalResult[] | undefined,
): number[] {
  if (results === undefined || results.length === 0) {
    return [];
  }

  return results.map((result) => {
    assertFiniteNumber(
      result.score.total,
      `Score total for ${result.caseId}/${result.providerId}/${result.condition}`,
    );
    return result.score.total;
  });
}

function clamp(value: number, minimum: number, maximum: number): number {
  invariant(minimum <= maximum, 'Clamp bounds must be ordered');

  if (value < minimum) {
    return minimum;
  }

  if (value > maximum) {
    return maximum;
  }

  return value;
}

function buildComparableGroupMapKey(result: EvalResult): string {
  return JSON.stringify([result.providerId, result.caseId]);
}

function buildComparisonGroupKey(result: EvalResult): string {
  return JSON.stringify([result.providerId, result.lane, result.caseId]);
}

function assertComparableGroup(results: readonly EvalResult[]): EvalResult {
  const firstResult = results[0];
  invariant(firstResult !== undefined, 'Comparison groups must not be empty');
  assertEvalResultBoundary(firstResult);

  for (const result of results.slice(1)) {
    assertEvalResultBoundary(result);
    invariant(
      result.providerId === firstResult.providerId,
      `Comparable group provider mismatch for case ${firstResult.caseId}`,
    );
    invariant(
      result.caseId === firstResult.caseId,
      `Comparable group case mismatch for provider ${firstResult.providerId}`,
    );
    invariant(
      result.lane === firstResult.lane,
      `Comparable group lane mismatch for ${firstResult.providerId}/${firstResult.caseId}`,
    );
    invariant(
      result.category === firstResult.category,
      `Comparable group category mismatch for ${firstResult.providerId}/${firstResult.caseId}`,
    );
    invariant(
      result.expectedSkill === firstResult.expectedSkill,
      `Comparable group expectedSkill mismatch for ${firstResult.providerId}/${firstResult.caseId}`,
    );
  }

  return firstResult;
}

/**
 * Generate the canonical case × condition × provider matrix for eval runs.
 */
export function buildConditionMatrix(
  cases: readonly EvalCase[],
  providers: readonly string[],
): MatrixEntry[] {
  assertArrayInput(cases, 'cases');
  invariant(cases.length > 0, 'cases must not be empty');
  assertArrayInput(providers, 'providers');
  invariant(providers.length > 0, 'providers must not be empty');

  const seenProviders = new Set<string>();
  for (const providerId of providers) {
    assertNonEmptyString(providerId, 'providerId');
    invariant(
      !seenProviders.has(providerId),
      `providers must not contain duplicates: ${providerId}`,
    );
    seenProviders.add(providerId);
  }

  const matrix: MatrixEntry[] = [];
  for (const evalCase of cases) {
    assertNonEmptyString(evalCase.id, 'evalCase.id');
    assertNonEmptyString(evalCase.category, `Case ${evalCase.id} category`);
    assertNonEmptyString(
      evalCase.expectedSkill,
      `Case ${evalCase.id} expectedSkill`,
    );

    const conditions = resolveConditionList(evalCase);
    for (const condition of conditions) {
      assertSkillCondition(condition, `Case ${evalCase.id} condition`);
      for (const providerId of providers) {
        const entry: MatrixEntry = {
          providerId,
          lane: evalCase.lane,
          caseId: evalCase.id,
          category: evalCase.category,
          condition,
          expectedSkill: evalCase.expectedSkill,
          ...(evalCase.lane !== 'prompt' && evalCase.fixture !== undefined
            ? { fixture: evalCase.fixture }
            : {}),
          ...(evalCase.lane !== 'prompt' && evalCase.target !== undefined
            ? { target: evalCase.target }
            : {}),
        };
        matrix.push(validateMatrixEntry(entry));
      }
    }
  }

  return matrix;
}

/**
 * Group eval results by case ID for downstream reporting and aggregation.
 */
export function groupResultsByCase(
  results: readonly EvalResult[],
): Map<string, EvalResult[]> {
  assertArrayInput(results, 'results');

  const groupedResults = new Map<string, EvalResult[]>();
  for (const result of results) {
    assertEvalResultBoundary(result);
    appendGroupValue(groupedResults, result.caseId, result);
  }

  return groupedResults;
}

/**
 * Group eval results by skill condition using the canonical condition ordering.
 */
export function groupResultsByCondition(
  results: readonly EvalResult[],
): Map<SkillCondition, EvalResult[]> {
  assertArrayInput(results, 'results');

  const groupedResults = new Map<SkillCondition, EvalResult[]>();
  for (const condition of SKILL_CONDITIONS) {
    groupedResults.set(condition, []);
  }

  for (const result of results) {
    assertEvalResultBoundary(result);
    const bucket = groupedResults.get(result.condition);
    invariant(
      bucket !== undefined,
      `Missing grouped-results bucket for condition ${result.condition}`,
    );
    bucket.push(result);
  }

  return groupedResults;
}

/**
 * Group eval results by provider ID for downstream reporting and aggregation.
 */
export function groupResultsByProvider(
  results: readonly EvalResult[],
): Map<string, EvalResult[]> {
  assertArrayInput(results, 'results');

  const groupedResults = new Map<string, EvalResult[]>();
  for (const result of results) {
    assertEvalResultBoundary(result);
    appendGroupValue(groupedResults, result.providerId, result);
  }

  return groupedResults;
}

/**
 * Compute per-provider, per-case skill-condition comparison metrics from eval results.
 */
export function computeComparisonMetrics(
  results: readonly EvalResult[],
): ComparisonMetrics[] {
  assertArrayInput(results, 'results');

  const comparableGroups = new Map<string, EvalResult[]>();
  for (const result of results) {
    assertEvalResultBoundary(result);
    appendGroupValue(
      comparableGroups,
      buildComparableGroupMapKey(result),
      result,
    );
  }

  const comparisons: ComparisonMetrics[] = [];
  for (const groupResults of comparableGroups.values()) {
    const firstResult = assertComparableGroup(groupResults);
    const resultsByCondition = groupResultsByCondition(groupResults);
    const noneScores = collectScoreTotals(resultsByCondition.get('none'));
    const selfLoadScores = collectScoreTotals(
      resultsByCondition.get('self-load'),
    );
    const preloadedScores = collectScoreTotals(
      resultsByCondition.get('preloaded'),
    );
    const staleScores = collectScoreTotals(resultsByCondition.get('stale'));

    const noneMean = computeMean(noneScores);
    const selfLoadMean = computeMean(selfLoadScores);
    const preloadedMean = computeMean(preloadedScores);
    const staleMean = computeMean(staleScores);

    const hasNoneScores = noneScores.length > 0;
    const hasSelfLoadScores = selfLoadScores.length > 0;
    const hasPreloadedScores = preloadedScores.length > 0;
    const hasStaleScores = staleScores.length > 0;

    const realizedSkillLift =
      hasNoneScores && hasSelfLoadScores ? selfLoadMean - noneMean : 0;
    const oracleSkillLift =
      hasNoneScores && hasPreloadedScores ? preloadedMean - noneMean : 0;
    const routingGap =
      realizedSkillLift !== 0 && oracleSkillLift !== 0
        ? oracleSkillLift - realizedSkillLift
        : 0;
    const staleSkillHarm =
      hasNoneScores && hasStaleScores ? noneMean - staleMean : 0;
    const regressionRate =
      hasNoneScores && hasSelfLoadScores && selfLoadMean < noneMean ? 1 : 0;
    const unlockRate =
      hasNoneScores && hasSelfLoadScores && selfLoadMean > noneMean ? 1 : 0;
    const routingEfficiency =
      oracleSkillLift > 0
        ? clamp(realizedSkillLift / oracleSkillLift, 0, 1)
        : 0;
    const missingConditions = SKILL_CONDITIONS.filter(
      (condition) => (resultsByCondition.get(condition)?.length ?? 0) === 0,
    );

    const comparison: ComparisonMetrics = {
      providerId: firstResult.providerId,
      lane: firstResult.lane,
      groupKey: buildComparisonGroupKey(firstResult),
      caseIds: [firstResult.caseId],
      expectedSkill: firstResult.expectedSkill,
      totalCompared: 1,
      category: firstResult.category,
      missingConditions,
      realizedSkillLift,
      oracleSkillLift,
      routingGap,
      staleSkillHarm,
      regressionRate,
      unlockRate,
      routingEfficiency,
    };

    comparisons.push(validateComparisonMetrics(comparison));
  }

  return comparisons;
}
