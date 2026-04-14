import { assertString, invariant } from '../../src/util/assert.js';
import type {
  AggregateMetrics,
  AntiPatternFinding,
  AntiPatternRule,
  EvalResult,
  ExpectedSkill,
  ForbiddenPatternResult,
  PatternMatchResult,
  PromptCaseScore,
  PromptEvalCase,
  ScoreComponent,
  WorkflowCheck,
  WorkflowCheckResult,
} from './types.js';

const REGEX_LITERAL_FLAGS_PATTERN = /^[dgimsuvy]*$/;
const COMPILED_PATTERN_CACHE = new Map<string, RegExp>();
const FORBIDDEN_PATTERN_PENALTY = 0.1;
const ANTI_PATTERN_PENALTY = 0.05;
const PROMPT_SCORE_WEIGHTS = Object.freeze({
  expectedPatterns: 0.4,
  skillSelection: 0.4,
  workflowCompliance: 0.2,
});

invariant(
  Math.abs(
    PROMPT_SCORE_WEIGHTS.expectedPatterns +
      PROMPT_SCORE_WEIGHTS.skillSelection +
      PROMPT_SCORE_WEIGHTS.workflowCompliance -
      1,
  ) < 1e-9,
  'Prompt scoring weights must sum to 1',
);

interface MatchOccurrence {
  matchedText: string;
  offset: number;
  lineNumber: number;
}

interface AggregateMetricsWithStats extends AggregateMetrics {
  medianScore: number;
  minScore: number;
  maxScore: number;
}

interface WorkflowEvaluation {
  check: WorkflowCheck;
  matches: PatternMatchResult[];
  forbiddenMatches: ForbiddenPatternResult[];
}

interface ResolvedWorkflowStatus {
  passed: boolean;
  message?: string;
}

/**
 * Compile a cached regex from either raw source text or /pattern/flags form.
 *
 * Throws a descriptive error when the pattern cannot be compiled.
 */
export function compilePattern(source: string): RegExp {
  assertString(source, 'Pattern source must be a string');
  invariant(source.length > 0, 'Pattern source must not be empty');

  const cached = COMPILED_PATTERN_CACHE.get(source);
  if (cached !== undefined) {
    return cached;
  }

  const { pattern, flags } = parsePatternSource(source);

  try {
    const compiled = new RegExp(pattern, flags);
    COMPILED_PATTERN_CACHE.set(source, compiled);
    return compiled;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid regex pattern "${source}": ${message}`, {
      cause: error,
    });
  }
}

/**
 * Match each expected pattern against text.
 */
export function matchPatterns(
  text: string,
  patterns: string[],
): PatternMatchResult[] {
  assertString(text, 'Text to match must be a string');
  invariant(Array.isArray(patterns), 'Patterns must be an array');

  const lineStarts = computeLineStarts(text);
  return patterns.map((pattern) => {
    assertString(pattern, 'Each pattern must be a string');
    invariant(pattern.length > 0, 'Patterns must not be empty');
    const occurrences = collectOccurrences(
      text,
      compilePattern(pattern),
      lineStarts,
    );
    return buildPatternMatchResult(pattern, occurrences);
  });
}

/**
 * Match each forbidden pattern against text.
 */
export function checkForbiddenPatterns(
  text: string,
  patterns: string[],
): ForbiddenPatternResult[] {
  assertString(text, 'Text to scan must be a string');
  invariant(Array.isArray(patterns), 'Forbidden patterns must be an array');

  const lineStarts = computeLineStarts(text);
  return patterns.map((pattern) => {
    assertString(pattern, 'Each forbidden pattern must be a string');
    invariant(pattern.length > 0, 'Forbidden patterns must not be empty');
    const occurrences = collectOccurrences(
      text,
      compilePattern(pattern),
      lineStarts,
    );
    return buildForbiddenPatternResult(pattern, occurrences);
  });
}

/**
 * Evaluate workflow checks against text, including required and forbidden
 * pattern matching plus dependency handling.
 */
export function checkWorkflow(
  text: string,
  checks: WorkflowCheck[],
): WorkflowCheckResult[] {
  assertString(text, 'Workflow text must be a string');
  invariant(Array.isArray(checks), 'Workflow checks must be an array');

  const evaluations = new Map<string, WorkflowEvaluation>();
  for (const check of checks) {
    assertString(check.id, 'Workflow check id must be a string');
    invariant(
      !evaluations.has(check.id),
      `Duplicate workflow check id: ${check.id}`,
    );
    invariant(
      Array.isArray(check.requiredPatterns),
      `Workflow check ${check.id} requiredPatterns must be an array`,
    );
    invariant(
      Array.isArray(check.forbiddenPatterns),
      `Workflow check ${check.id} forbiddenPatterns must be an array`,
    );
    invariant(
      Array.isArray(check.dependsOn),
      `Workflow check ${check.id} dependsOn must be an array`,
    );

    evaluations.set(check.id, {
      check,
      matches: matchPatterns(text, check.requiredPatterns),
      forbiddenMatches: checkForbiddenPatterns(text, check.forbiddenPatterns),
    });
  }

  const resolvedStatuses = new Map<string, ResolvedWorkflowStatus>();
  return checks.map((check) => {
    const evaluation = evaluations.get(check.id);
    invariant(
      evaluation !== undefined,
      `Missing workflow evaluation for ${check.id}`,
    );
    const resolved = resolveWorkflowStatus(
      check.id,
      evaluations,
      resolvedStatuses,
      new Set<string>(),
    );

    const baseResult = {
      checkId: check.id,
      passed: resolved.passed,
      matches: evaluation.matches,
      forbiddenMatches: evaluation.forbiddenMatches,
    };

    if (resolved.message === undefined) {
      return baseResult;
    }

    return {
      ...baseResult,
      message: resolved.message,
    };
  });
}

/**
 * Score one prompt-lane response deterministically from regex matches,
 * inferred skill selection, workflow compliance, and anti-pattern findings.
 */
export function scorePromptCase(
  response: string,
  evalCase: PromptEvalCase,
): PromptCaseScore {
  assertString(response, 'Prompt response must be a string');
  invariant(
    Array.isArray(evalCase.expectedPatterns),
    `Prompt eval case ${evalCase.id} expectedPatterns must be an array`,
  );
  invariant(
    Array.isArray(evalCase.forbiddenPatterns),
    `Prompt eval case ${evalCase.id} forbiddenPatterns must be an array`,
  );
  invariant(
    Array.isArray(evalCase.workflowChecks),
    `Prompt eval case ${evalCase.id} workflowChecks must be an array`,
  );
  invariant(
    Array.isArray(evalCase.antiPatterns),
    `Prompt eval case ${evalCase.id} antiPatterns must be an array`,
  );

  const patternMatches = matchPatterns(response, evalCase.expectedPatterns);
  const forbiddenPatternMatches = checkForbiddenPatterns(
    response,
    evalCase.forbiddenPatterns,
  );
  const workflowChecks = checkWorkflow(response, evalCase.workflowChecks);
  const antiPatternFindings = detectAntiPatternFindings(
    response,
    evalCase.antiPatterns,
  );

  const matchedExpectedPatterns = countMatchedPatterns(patternMatches);
  const expectedPatternCoverage = safeDivide(
    matchedExpectedPatterns,
    patternMatches.length,
  );
  const forbiddenViolationCount = countForbiddenViolations(
    forbiddenPatternMatches,
  );
  const forbiddenPenalty = FORBIDDEN_PATTERN_PENALTY * forbiddenViolationCount;
  const inferredSkill = inferSelectedSkill(response);
  const expectedSkillCorrect = inferredSkill === evalCase.expectedSkill;
  const skillScore = expectedSkillCorrect ? 1 : 0;
  const requiredChecks = evalCase.workflowChecks.filter(
    (check) => check.required,
  );
  const passedRequiredChecks = workflowChecks.filter((result) => {
    const workflowCheck = requiredChecks.find(
      (check) => check.id === result.checkId,
    );
    return workflowCheck !== undefined && result.passed;
  }).length;
  const workflowScore = safeDivide(passedRequiredChecks, requiredChecks.length);
  const antiPatternPenalty = ANTI_PATTERN_PENALTY * antiPatternFindings.length;

  const positiveScore = clampUnitInterval(
    expectedPatternCoverage * PROMPT_SCORE_WEIGHTS.expectedPatterns +
      skillScore * PROMPT_SCORE_WEIGHTS.skillSelection +
      workflowScore * PROMPT_SCORE_WEIGHTS.workflowCompliance,
  );
  const totalScore = clampUnitInterval(
    positiveScore - forbiddenPenalty - antiPatternPenalty,
  );

  const breakdownItems: ScoreComponent[] = [
    {
      name: 'expected-pattern-coverage',
      score: expectedPatternCoverage * PROMPT_SCORE_WEIGHTS.expectedPatterns,
      maxScore: PROMPT_SCORE_WEIGHTS.expectedPatterns,
      reason: `${String(matchedExpectedPatterns)}/${String(patternMatches.length)} expected patterns matched`,
    },
    {
      name: 'skill-selection-correctness',
      score: skillScore * PROMPT_SCORE_WEIGHTS.skillSelection,
      maxScore: PROMPT_SCORE_WEIGHTS.skillSelection,
      reason: expectedSkillCorrect
        ? `Inferred expected skill "${evalCase.expectedSkill}"`
        : `Expected skill "${evalCase.expectedSkill}", inferred "${inferredSkill}"`,
    },
    {
      name: 'workflow-compliance',
      score: workflowScore * PROMPT_SCORE_WEIGHTS.workflowCompliance,
      maxScore: PROMPT_SCORE_WEIGHTS.workflowCompliance,
      reason: `${String(passedRequiredChecks)}/${String(requiredChecks.length)} required workflow checks passed`,
    },
    {
      name: 'forbidden-pattern-penalty',
      score: 0,
      maxScore: 0,
      reason:
        forbiddenViolationCount === 0
          ? 'No forbidden pattern violations'
          : `Penalty -${forbiddenPenalty.toFixed(2)} for ${String(forbiddenViolationCount)} forbidden matches`,
    },
    {
      name: 'anti-pattern-penalty',
      score: 0,
      maxScore: 0,
      reason:
        antiPatternFindings.length === 0
          ? 'No anti-pattern findings'
          : `Penalty -${antiPatternPenalty.toFixed(2)} for ${String(antiPatternFindings.length)} anti-pattern findings`,
    },
  ];

  const passed =
    patternMatches.every((match) => match.matched) &&
    forbiddenViolationCount === 0 &&
    expectedSkillCorrect &&
    requiredChecks.every((check) =>
      workflowChecks.some(
        (result) => result.checkId === check.id && result.passed,
      ),
    ) &&
    antiPatternFindings.length === 0;

  return {
    expectedSkillCorrect,
    patternMatches,
    forbiddenPatternMatches,
    workflowChecks,
    antiPatternFindings,
    breakdown: {
      total: totalScore,
      maxPossible: 1,
      items: breakdownItems,
    },
    passed,
  };
}

/**
 * Compute aggregate metrics for a batch of eval results.
 *
 * The returned object always uses 0 for empty-input and zero-denominator cases.
 * In addition to the AggregateMetrics contract, runtime results also include
 * `medianScore`, `minScore`, and `maxScore` for reporting convenience.
 */
export function computeAggregateMetrics(
  results: EvalResult[],
): AggregateMetrics {
  invariant(Array.isArray(results), 'Eval results must be an array');

  const totalCases = results.length;
  const passed = results.filter((result) => result.ok).length;
  const failed = totalCases - passed;
  const normalizedScores = results.map(normalizeScoreBreakdown);
  const bundleScores = results
    .map((result) => result.bundleCompleteness?.score)
    .filter((score): score is number => score !== undefined);
  const reportScores = results
    .map((result) => result.reportCompleteness?.score)
    .filter((score): score is number => score !== undefined);
  const evidenceScores = results
    .map((result) => result.evidenceQuality?.score)
    .filter((score): score is number => score !== undefined);
  const totalWorkflowChecks = results.reduce(
    (count, result) => count + result.workflowChecks.length,
    0,
  );
  const passedWorkflowChecks = results.reduce(
    (count, result) =>
      count +
      result.workflowChecks.filter((workflow) => workflow.passed).length,
    0,
  );
  const resultsWithAntiPatterns = results.filter(
    (result) => result.antiPatternFindings.length > 0,
  ).length;

  const aggregate: AggregateMetricsWithStats = {
    totalCases,
    passed,
    failed,
    passRate: safeDivide(passed, totalCases),
    averageScore: average(normalizedScores),
    medianScore: median(normalizedScores),
    minScore: min(normalizedScores),
    maxScore: max(normalizedScores),
    workflowComplianceRate: safeDivide(
      passedWorkflowChecks,
      totalWorkflowChecks,
    ),
    antiPatternIncidenceRate: safeDivide(resultsWithAntiPatterns, totalCases),
    bundleCompletenessRate: average(bundleScores),
    reportCompletenessRate: average(reportScores),
    evidenceQualityRate: average(evidenceScores),
  };

  return aggregate;
}

/**
 * Compute precision, recall, and F1 deterministically from expected/actual
 * boolean classifications. Zero-denominator cases return 0.
 */
export function computePrecisionRecall(
  results: Array<{ expected: boolean; actual: boolean }>,
): { precision: number; recall: number; f1: number } {
  invariant(
    Array.isArray(results),
    'Precision/recall results must be an array',
  );

  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;

  for (const result of results) {
    invariant(
      typeof result.expected === 'boolean',
      'Precision/recall result.expected must be a boolean',
    );
    invariant(
      typeof result.actual === 'boolean',
      'Precision/recall result.actual must be a boolean',
    );

    if (result.expected && result.actual) {
      truePositives += 1;
    } else if (!result.expected && result.actual) {
      falsePositives += 1;
    } else if (result.expected && !result.actual) {
      falseNegatives += 1;
    }
  }

  const precision = safeDivide(truePositives, truePositives + falsePositives);
  const recall = safeDivide(truePositives, truePositives + falseNegatives);
  const f1 =
    precision === 0 || recall === 0
      ? 0
      : safeDivide(2 * precision * recall, precision + recall);

  return {
    precision,
    recall,
    f1,
  };
}

function parsePatternSource(source: string): {
  pattern: string;
  flags: string;
} {
  const literalPattern = tryParseRegexLiteral(source);
  if (literalPattern !== null) {
    return literalPattern;
  }

  return {
    pattern: source,
    flags: '',
  };
}

function tryParseRegexLiteral(
  source: string,
): { pattern: string; flags: string } | null {
  if (!source.startsWith('/') || source.length < 2) {
    return null;
  }

  let escaped = false;
  let inCharacterClass = false;

  for (let index = 1; index < source.length; index += 1) {
    const current = source[index];
    invariant(current !== undefined, 'Regex literal parser exceeded bounds');

    if (escaped) {
      escaped = false;
      continue;
    }

    if (current === '\\') {
      escaped = true;
      continue;
    }

    if (current === '[') {
      inCharacterClass = true;
      continue;
    }

    if (current === ']' && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }

    if (current === '/' && !inCharacterClass) {
      const flags = source.slice(index + 1);
      if (flags.length === 0) {
        return {
          pattern: source.slice(1, index),
          flags,
        };
      }

      if (!REGEX_LITERAL_FLAGS_PATTERN.test(flags)) {
        return null;
      }

      return {
        pattern: source.slice(1, index),
        flags,
      };
    }
  }

  return null;
}

function computeLineStarts(text: string): number[] {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      lineStarts.push(index + 1);
    }
  }
  return lineStarts;
}

function lineNumberFromOffset(offset: number, lineStarts: number[]): number {
  invariant(offset >= 0, 'Match offset must be non-negative');
  invariant(lineStarts.length > 0, 'Line starts must not be empty');

  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const mid = low + Math.floor((high - low) / 2);
    const start = lineStarts[mid];
    invariant(start !== undefined, 'Line start index must be defined');
    if (start <= offset) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return high + 1;
}

function collectOccurrences(
  text: string,
  pattern: RegExp,
  lineStarts: number[],
): MatchOccurrence[] {
  const matcher = createGlobalMatcher(pattern);

  return Array.from(text.matchAll(matcher), (match): MatchOccurrence => {
    const matchedText = match[0];
    assertString(matchedText, 'Regex match must include matched text');
    const offset = match.index;
    return {
      matchedText,
      offset,
      lineNumber: lineNumberFromOffset(offset, lineStarts),
    };
  });
}

function createGlobalMatcher(pattern: RegExp): RegExp {
  const flagsWithoutSticky = pattern.flags.replaceAll('y', '');
  const globalFlags = flagsWithoutSticky.includes('g')
    ? flagsWithoutSticky
    : `${flagsWithoutSticky}g`;
  return new RegExp(pattern.source, globalFlags);
}

function buildPatternMatchResult(
  pattern: string,
  occurrences: MatchOccurrence[],
): PatternMatchResult {
  return {
    pattern,
    matched: occurrences.length > 0,
    matchedTexts: occurrences.map((occurrence) => occurrence.matchedText),
    lineNumbers: occurrences.map((occurrence) => occurrence.lineNumber),
    matchCount: occurrences.length,
  };
}

function buildForbiddenPatternResult(
  pattern: string,
  occurrences: MatchOccurrence[],
): ForbiddenPatternResult {
  return {
    pattern,
    violated: occurrences.length > 0,
    matchedTexts: occurrences.map((occurrence) => occurrence.matchedText),
    lineNumbers: occurrences.map((occurrence) => occurrence.lineNumber),
    matchCount: occurrences.length,
  };
}

function resolveWorkflowStatus(
  checkId: string,
  evaluations: Map<string, WorkflowEvaluation>,
  cache: Map<string, ResolvedWorkflowStatus>,
  activeCheckIds: Set<string>,
): ResolvedWorkflowStatus {
  const cached = cache.get(checkId);
  if (cached !== undefined) {
    return cached;
  }

  const evaluation = evaluations.get(checkId);
  invariant(evaluation !== undefined, `Unknown workflow check id: ${checkId}`);

  if (activeCheckIds.has(checkId)) {
    return {
      passed: false,
      message: `Cyclic workflow dependency detected at ${checkId}`,
    };
  }

  activeCheckIds.add(checkId);

  const messageParts: string[] = [];
  for (const dependencyId of evaluation.check.dependsOn) {
    const dependency = evaluations.get(dependencyId);
    if (dependency === undefined) {
      messageParts.push(`Missing dependency "${dependencyId}"`);
      continue;
    }

    const dependencyStatus = resolveWorkflowStatus(
      dependencyId,
      evaluations,
      cache,
      activeCheckIds,
    );
    if (!dependencyStatus.passed) {
      messageParts.push(`Dependency "${dependencyId}" did not pass`);
    }
  }

  activeCheckIds.delete(checkId);

  const missingRequiredPatterns = evaluation.matches
    .filter((result) => !result.matched)
    .map((result) => result.pattern);
  if (missingRequiredPatterns.length > 0) {
    messageParts.push(
      `Missing required patterns: ${missingRequiredPatterns.join(', ')}`,
    );
  }

  const violatedForbiddenPatterns = evaluation.forbiddenMatches
    .filter((result) => result.violated)
    .map((result) => result.pattern);
  if (violatedForbiddenPatterns.length > 0) {
    messageParts.push(
      `Matched forbidden patterns: ${violatedForbiddenPatterns.join(', ')}`,
    );
  }

  const resolved: ResolvedWorkflowStatus = {
    passed: messageParts.length === 0,
  };
  if (messageParts.length > 0) {
    resolved.message = messageParts.join('; ');
  }

  cache.set(checkId, resolved);
  return resolved;
}

function detectAntiPatternFindings(
  text: string,
  rules: AntiPatternRule[],
): AntiPatternFinding[] {
  invariant(Array.isArray(rules), 'Anti-pattern rules must be an array');

  const lineStarts = computeLineStarts(text);
  const findings: AntiPatternFinding[] = [];

  for (const rule of rules) {
    assertString(rule.id, 'Anti-pattern rule id must be a string');
    invariant(
      Array.isArray(rule.patterns),
      `Anti-pattern rule ${rule.id} patterns must be an array`,
    );

    for (const pattern of rule.patterns) {
      assertString(pattern, 'Anti-pattern pattern must be a string');
      const occurrences = collectOccurrences(
        text,
        compilePattern(pattern),
        lineStarts,
      );

      for (const occurrence of occurrences) {
        findings.push({
          ruleId: rule.id,
          severity: rule.severity,
          message: rule.description,
          matchedText: occurrence.matchedText,
          lineNumber: occurrence.lineNumber,
          suggestedFix: rule.suggestedFix,
        });
      }
    }
  }

  return findings;
}

function inferSelectedSkill(response: string): ExpectedSkill {
  if (matchesAny(response, ['\\bdogfood-tui\\b'])) {
    return 'dogfood-tui';
  }

  if (
    matchesAny(response, [
      '\\bagent-tty\\s+skills\\s+get\\s+agent-tty\\b',
      '\\bagent-tty\\s+--',
      '\\bagent-tty\\b',
    ])
  ) {
    return 'agent-tty';
  }

  return 'none';
}

function matchesAny(text: string, patterns: string[]): boolean {
  return matchPatterns(text, patterns).some((result) => result.matched);
}

function countMatchedPatterns(results: PatternMatchResult[]): number {
  return results.filter((result) => result.matched).length;
}

function countForbiddenViolations(results: ForbiddenPatternResult[]): number {
  return results.reduce((count, result) => count + result.matchCount, 0);
}

function normalizeScoreBreakdown(result: EvalResult): number {
  return clampUnitInterval(
    safeDivide(result.score.total, result.score.maxPossible),
  );
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return safeDivide(
    values.reduce((sum, value) => sum + value, 0),
    values.length,
  );
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const middleValue = sorted[middle];
  invariant(middleValue !== undefined, 'Median index must be in bounds');

  if (sorted.length % 2 === 1) {
    return middleValue;
  }

  const previousValue = sorted[middle - 1];
  invariant(
    previousValue !== undefined,
    'Median lower index must be in bounds',
  );
  return (previousValue + middleValue) / 2;
}

function min(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((currentMin, value) =>
    value < currentMin ? value : currentMin,
  );
}

function max(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((currentMax, value) =>
    value > currentMax ? value : currentMax,
  );
}

function safeDivide(numerator: number, denominator: number): number {
  invariant(Number.isFinite(numerator), 'Numerator must be finite');
  invariant(Number.isFinite(denominator), 'Denominator must be finite');
  if (denominator <= 0) {
    return 0;
  }

  return numerator / denominator;
}

function clampUnitInterval(value: number): number {
  invariant(Number.isFinite(value), 'Score values must be finite');
  if (value <= 0) {
    return 0;
  }

  if (value >= 1) {
    return 1;
  }

  return value;
}
