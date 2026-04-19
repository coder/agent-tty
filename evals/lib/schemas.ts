import { z } from 'zod';

import { EventRecordSchema } from '../../src/protocol/schemas.js';
import { SnapshotCheckReportSchema } from '../snapshots/schemas/report.js';
import type { ArtifactKind } from '../../src/tools/review-bundle.js';
import type { BundleValidationProfile } from '../../src/tools/validate-bundle.js';
import type {
  AggregateMetrics,
  AntiPatternFinding,
  BaselineComparison,
  BaselineOverall,
  BundleCompletenessScore,
  ComparisonMetrics,
  ConfidenceInterval,
  DogfoodEvalCase,
  EvalCase,
  EvalCliOptions,
  EvalCliResult,
  EvalEventRecord,
  EvalResult,
  ExecutionEvalCase,
  JsonReport,
  MatrixEntry,
  NormalizedProviderOutput,
  PatternMatchResult,
  PerCaseComparison,
  PromptCaseScore,
  PromptEvalCase,
  ProviderAgentRequest,
  ProviderAgentResult,
  ProviderCapabilities,
  ProviderComparisonReport,
  ProviderConfig,
  ProviderPromptRequest,
  ProviderPromptResult,
  ProviderRuntimeInfo,
  ReportCompletenessScore,
  TokenReportSummary,
  TokenUsage,
  TrialAggregation,
} from './types.js';

const NonEmptyStringSchema = z.string().min(1);
const PositiveIntSchema = z.number().int().positive();
const NonNegativeIntSchema = z.number().int().nonnegative();
const NonNegativeNumberSchema = z.number().nonnegative();
const FiniteNumberSchema = z.number();
const IsoTimestampSchema = z.iso.datetime();
const RegexPatternSchema = z.string().min(1).max(500);
const PathStringSchema = NonEmptyStringSchema;
const StringListSchema = z.array(NonEmptyStringSchema);
const UnitIntervalSchema = z.number().min(0).max(1);
const StringRecordSchema = z.record(NonEmptyStringSchema, z.string());
const UnknownRecordSchema = z.record(NonEmptyStringSchema, z.unknown());

function addTimestampOrderIssue(
  startedAt: string,
  completedAt: string,
  ctx: z.RefinementCtx,
): void {
  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    ctx.addIssue({
      code: 'custom',
      message: 'completedAt must be on or after startedAt',
      path: ['completedAt'],
    });
  }
}

const PromptCategorySchema = z.enum([
  'trigger',
  'selection',
  'workflow',
  'anti-pattern',
]);
const ExecutionCategorySchema = z.enum([
  'session',
  'tui',
  'artifact',
  'recovery',
]);
const DogfoodCategorySchema = z.enum([
  'qa',
  'release-readiness',
  'bug-repro',
  'reporting',
]);

export const ExpectedSkillSchema = z.enum(['none', 'agent-tty', 'dogfood-tui']);
export const SkillConditionSchema = z.enum([
  'none',
  'self-load',
  'preloaded',
  'stale',
]);
export const EvalLaneSchema = z.enum(['prompt', 'execution', 'dogfood']);
export const VerifierKindSchema = z.enum([
  'snapshot',
  'screenshot',
  'event-log',
  'json',
  'bundle',
  'command',
  'custom',
]);
export const AntiPatternSeveritySchema = z.enum(['info', 'warning', 'error']);
export const ProviderModeSchema = z.enum(['stub', 'plan-only', 'agent-run']);
export const ArtifactKindSchema = z.enum([
  'screenshot',
  'video',
  'recording',
  'json',
  'notes',
  'script',
  'support',
  'other',
]);
export const BundleValidationProfileSchema = z.enum([
  'contract-reporting',
  'interactive-renderer',
]);

const PromptBudgetSchema = z
  .object({
    timeoutMs: PositiveIntSchema,
  })
  .strict();

const ExecutionBudgetSchema = z
  .object({
    timeoutMs: PositiveIntSchema,
    maxAgentSteps: PositiveIntSchema.optional(),
    maxWallClockMs: PositiveIntSchema.optional(),
  })
  .strict();

const DogfoodBudgetSchema = z
  .object({
    timeoutMs: PositiveIntSchema,
    maxAgentSteps: PositiveIntSchema.optional(),
    maxWallClockMs: PositiveIntSchema.optional(),
  })
  .strict();

const BundleValidationCheckSchema = z
  .object({
    name: NonEmptyStringSchema,
    ok: z.boolean(),
    message: NonEmptyStringSchema,
  })
  .strict();

export const ScoreComponentSchema = z
  .object({
    name: NonEmptyStringSchema,
    score: NonNegativeNumberSchema,
    maxScore: NonNegativeNumberSchema,
    reason: NonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((obj, ctx) => {
    if (obj.score > obj.maxScore) {
      ctx.addIssue({
        code: 'custom',
        message: 'score must be less than or equal to maxScore',
        path: ['score'],
      });
    }
  });

export const SetupStepSchema = z
  .object({
    id: NonEmptyStringSchema,
    description: NonEmptyStringSchema,
    command: NonEmptyStringSchema,
    argv: z.array(NonEmptyStringSchema),
    cwd: PathStringSchema.optional(),
    env: StringRecordSchema.optional(),
    timeoutMs: PositiveIntSchema.optional(),
  })
  .strict();

export const VerifierSpecSchema = z
  .object({
    id: NonEmptyStringSchema,
    kind: VerifierKindSchema,
    description: NonEmptyStringSchema,
    required: z.boolean(),
    config: UnknownRecordSchema,
  })
  .strict();

export const WorkflowCheckSchema = z
  .object({
    id: NonEmptyStringSchema,
    description: NonEmptyStringSchema,
    required: z.boolean(),
    requiredPatterns: z.array(RegexPatternSchema),
    forbiddenPatterns: z.array(RegexPatternSchema),
    dependsOn: z.array(NonEmptyStringSchema),
    weight: NonNegativeNumberSchema.optional(),
  })
  .strict();

export const AntiPatternRuleSchema = z
  .object({
    id: NonEmptyStringSchema,
    description: NonEmptyStringSchema,
    severity: AntiPatternSeveritySchema,
    patterns: z.array(RegexPatternSchema),
    suggestedFix: NonEmptyStringSchema,
    lanes: z.array(EvalLaneSchema).optional(),
  })
  .strict();

export const ArtifactRequirementSchema = z
  .object({
    kind: ArtifactKindSchema,
    required: z.boolean(),
    description: NonEmptyStringSchema,
    minCount: PositiveIntSchema.optional(),
    pathPatterns: z.array(RegexPatternSchema),
  })
  .strict()
  .superRefine((obj, ctx) => {
    if (obj.required && obj.minCount === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'minCount is required when required is true',
        path: ['minCount'],
      });
    }
  });

export const ReportRequirementSchema = z
  .object({
    id: NonEmptyStringSchema,
    description: NonEmptyStringSchema,
    required: z.boolean(),
    section: NonEmptyStringSchema.optional(),
    requiredPatterns: z.array(RegexPatternSchema),
    forbiddenPatterns: z.array(RegexPatternSchema),
  })
  .strict();

export const PatternMatchResultSchema = z
  .object({
    pattern: RegexPatternSchema,
    matched: z.boolean(),
    matchedTexts: z.array(z.string()),
    lineNumbers: z.array(NonNegativeIntSchema),
    matchCount: NonNegativeIntSchema,
  })
  .strict();

export const ForbiddenPatternResultSchema = z
  .object({
    pattern: RegexPatternSchema,
    violated: z.boolean(),
    matchedTexts: z.array(z.string()),
    lineNumbers: z.array(NonNegativeIntSchema),
    matchCount: NonNegativeIntSchema,
    note: NonEmptyStringSchema.optional(),
  })
  .strict();

export const AntiPatternFindingSchema = z
  .object({
    ruleId: NonEmptyStringSchema,
    severity: AntiPatternSeveritySchema,
    message: NonEmptyStringSchema,
    matchedText: z.string().optional(),
    lineNumber: NonNegativeIntSchema.optional(),
    suggestedFix: NonEmptyStringSchema.optional(),
  })
  .strict();

export const WorkflowCheckResultSchema = z
  .object({
    checkId: NonEmptyStringSchema,
    passed: z.boolean(),
    message: NonEmptyStringSchema.optional(),
    matches: z.array(PatternMatchResultSchema),
    forbiddenMatches: z.array(ForbiddenPatternResultSchema),
  })
  .strict();

export const ScoreBreakdownSchema = z
  .object({
    total: NonNegativeNumberSchema,
    maxPossible: NonNegativeNumberSchema,
    items: z.array(ScoreComponentSchema),
  })
  .strict()
  .superRefine((obj, ctx) => {
    if (obj.maxPossible < obj.total) {
      ctx.addIssue({
        code: 'custom',
        message: 'maxPossible must be greater than or equal to total',
        path: ['maxPossible'],
      });
    }
  });

export const BundleCompletenessScoreSchema = z
  .object({
    profile: BundleValidationProfileSchema,
    totalChecks: NonNegativeIntSchema,
    passed: NonNegativeIntSchema,
    failed: NonNegativeIntSchema,
    score: UnitIntervalSchema,
    details: z.array(BundleValidationCheckSchema),
  })
  .strict()
  .superRefine((obj, ctx) => {
    if (obj.passed + obj.failed !== obj.totalChecks) {
      ctx.addIssue({
        code: 'custom',
        message: 'passed + failed must equal totalChecks',
        path: ['totalChecks'],
      });
    }
  });

export const ReportCompletenessScoreSchema = z
  .object({
    sectionsExpected: NonNegativeIntSchema,
    sectionsFound: NonNegativeIntSchema,
    evidenceRefsFound: NonNegativeIntSchema,
    score: UnitIntervalSchema,
    details: z.array(
      z
        .object({
          section: NonEmptyStringSchema,
          found: z.boolean(),
          required: z.boolean().optional(),
        })
        .strict(),
    ),
    missingSections: z.array(NonEmptyStringSchema),
    matchedRequirements: z.array(PatternMatchResultSchema),
    forbiddenFindings: z.array(ForbiddenPatternResultSchema),
  })
  .strict()
  .superRefine((obj, ctx) => {
    if (obj.sectionsFound > obj.sectionsExpected) {
      ctx.addIssue({
        code: 'custom',
        message: 'sectionsFound must be less than or equal to sectionsExpected',
        path: ['sectionsFound'],
      });
    }
  });

export const EvidenceQualityScoreSchema = z
  .object({
    score: UnitIntervalSchema,
    artifactCoverage: UnitIntervalSchema,
    modalityCoverage: UnitIntervalSchema,
    fileDiversity: UnitIntervalSchema,
    manifestSanity: UnitIntervalSchema,
    breakdown: ScoreBreakdownSchema,
    bundleCompleteness: BundleCompletenessScoreSchema.optional(),
    reportCompleteness: ReportCompletenessScoreSchema.optional(),
    notes: z.array(NonEmptyStringSchema),
    details: z.array(
      z
        .object({
          dimension: NonEmptyStringSchema,
          score: UnitIntervalSchema,
          notes: NonEmptyStringSchema.optional(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((obj, ctx) => {
    if (
      Math.abs(obj.artifactCoverage - obj.modalityCoverage) > Number.EPSILON
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'artifactCoverage must match modalityCoverage',
        path: ['artifactCoverage'],
      });
    }
  });

export const RunMetadataSchema = z
  .object({
    runId: NonEmptyStringSchema,
    createdAt: IsoTimestampSchema,
    repoRoot: PathStringSchema,
    outputBaseDir: PathStringSchema.optional(),
    providers: z.array(NonEmptyStringSchema),
    models: z.array(NonEmptyStringSchema),
    lanes: z.array(EvalLaneSchema),
    conditions: z.array(SkillConditionSchema),
    totalTrials: NonNegativeIntSchema,
    notes: z.array(NonEmptyStringSchema),
  })
  .strict();

export const MatrixEntrySchema = z
  .object({
    providerId: NonEmptyStringSchema,
    lane: EvalLaneSchema,
    caseId: NonEmptyStringSchema,
    category: NonEmptyStringSchema,
    condition: SkillConditionSchema,
    expectedSkill: ExpectedSkillSchema,
    fixture: PathStringSchema.optional(),
    target: PathStringSchema.optional(),
  })
  .strict();

export const ComparisonMetricsSchema = z
  .object({
    providerId: NonEmptyStringSchema,
    lane: EvalLaneSchema,
    groupKey: NonEmptyStringSchema,
    caseIds: StringListSchema,
    expectedSkill: ExpectedSkillSchema,
    totalCompared: NonNegativeIntSchema,
    category: NonEmptyStringSchema.optional(),
    fixture: PathStringSchema.optional(),
    target: PathStringSchema.optional(),
    missingConditions: z.array(SkillConditionSchema),
    realizedSkillLift: FiniteNumberSchema.optional(),
    oracleSkillLift: FiniteNumberSchema.optional(),
    routingGap: FiniteNumberSchema.optional(),
    staleSkillHarm: FiniteNumberSchema.optional(),
    regressionRate: FiniteNumberSchema.optional(),
    unlockRate: FiniteNumberSchema.optional(),
    routingEfficiency: FiniteNumberSchema.optional(),
  })
  .strict();

export const PromptEvalCaseSchema = z
  .object({
    id: NonEmptyStringSchema,
    lane: z.literal('prompt'),
    category: PromptCategorySchema,
    prompt: NonEmptyStringSchema,
    expectedSkill: ExpectedSkillSchema,
    context: NonEmptyStringSchema.optional(),
    expectedPatterns: z.array(RegexPatternSchema).min(1),
    forbiddenPatterns: z.array(RegexPatternSchema),
    rubric: z.array(NonEmptyStringSchema),
    workflowChecks: z.array(WorkflowCheckSchema),
    antiPatterns: z.array(AntiPatternRuleSchema),
    budgets: PromptBudgetSchema,
  })
  .strict();

export const ExecutionEvalCaseSchema = z
  .object({
    id: NonEmptyStringSchema,
    lane: z.literal('execution'),
    category: ExecutionCategorySchema,
    prompt: NonEmptyStringSchema,
    expectedSkill: ExpectedSkillSchema,
    fixture: PathStringSchema.optional(),
    target: PathStringSchema.optional(),
    conditions: z.array(SkillConditionSchema),
    setup: z.array(SetupStepSchema),
    verifiers: z.array(VerifierSpecSchema),
    workflowChecks: z.array(WorkflowCheckSchema),
    antiPatterns: z.array(AntiPatternRuleSchema),
    artifactRequirements: z.array(ArtifactRequirementSchema),
    budgets: ExecutionBudgetSchema,
    referenceSteps: PositiveIntSchema.optional(),
    workspace: NonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((obj, ctx) => {
    if (obj.conditions.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'conditions must include at least one skill condition',
        path: ['conditions'],
      });
    }

    if (obj.verifiers.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'verifiers must include at least one verifier',
        path: ['verifiers'],
      });
    }

    if (obj.fixture === undefined && obj.target === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'fixture or target is required',
        path: ['fixture'],
      });
    }
  });

export const DogfoodEvalCaseSchema = z
  .object({
    id: NonEmptyStringSchema,
    lane: z.literal('dogfood'),
    category: DogfoodCategorySchema,
    prompt: NonEmptyStringSchema,
    expectedSkill: ExpectedSkillSchema,
    fixture: PathStringSchema.optional(),
    target: PathStringSchema.optional(),
    bundlePath: PathStringSchema,
    bundleRequirements: z.array(NonEmptyStringSchema),
    conditions: z.array(SkillConditionSchema),
    validationProfile: BundleValidationProfileSchema,
    artifactRequirements: z.array(ArtifactRequirementSchema),
    reportRequirements: z.array(ReportRequirementSchema),
    verifiers: z.array(VerifierSpecSchema),
    workflowChecks: z.array(WorkflowCheckSchema),
    antiPatterns: z.array(AntiPatternRuleSchema),
    budgets: DogfoodBudgetSchema,
    referenceSteps: PositiveIntSchema.optional(),
    workspace: NonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((obj, ctx) => {
    if (obj.conditions.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'conditions must include at least one skill condition',
        path: ['conditions'],
      });
    }

    if (obj.bundleRequirements.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'bundleRequirements must include at least one requirement',
        path: ['bundleRequirements'],
      });
    }

    if (
      obj.artifactRequirements.length === 0 &&
      obj.reportRequirements.length === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'artifactRequirements or reportRequirements must include at least one requirement',
        path: ['artifactRequirements'],
      });
    }
  });

export const EvalCaseSchema = z.discriminatedUnion('lane', [
  PromptEvalCaseSchema,
  ExecutionEvalCaseSchema,
  DogfoodEvalCaseSchema,
]);

const AgentEvalCaseSchema = z.discriminatedUnion('lane', [
  ExecutionEvalCaseSchema,
  DogfoodEvalCaseSchema,
]);

export const PromptCaseScoreSchema = z
  .object({
    expectedSkillCorrect: z.boolean(),
    patternMatches: z.array(PatternMatchResultSchema),
    forbiddenPatternMatches: z.array(ForbiddenPatternResultSchema),
    workflowChecks: z.array(WorkflowCheckResultSchema),
    antiPatternFindings: z.array(AntiPatternFindingSchema),
    breakdown: ScoreBreakdownSchema,
    passed: z.boolean(),
  })
  .strict();

export const ProviderCapabilitiesSchema = z
  .object({
    supportsDetect: z.boolean(),
    supportsPlanMode: z.boolean(),
    supportsAgentMode: z.boolean(),
    supportsStreaming: z.boolean(),
    supportsToolCalls: z.boolean(),
    supportsTranscriptCapture: z.boolean(),
  })
  .strict();

export const ProviderRuntimeInfoSchema = z
  .object({
    providerId: NonEmptyStringSchema,
    available: z.boolean(),
    detectedAt: IsoTimestampSchema,
    version: NonEmptyStringSchema.optional(),
    commandPath: PathStringSchema.optional(),
    defaultModelId: NonEmptyStringSchema.optional(),
    capabilities: ProviderCapabilitiesSchema,
    notes: z.array(NonEmptyStringSchema),
  })
  .strict();

export const TokenUsageSchema = z
  .object({
    inputTokens: NonNegativeIntSchema,
    outputTokens: NonNegativeIntSchema,
    totalTokens: NonNegativeIntSchema,
    cachedTokens: NonNegativeIntSchema.optional(),
  })
  .strict();

const TokenReportGrandTotalSchema = z
  .object({
    inputTokens: NonNegativeIntSchema,
    outputTokens: NonNegativeIntSchema,
    totalTokens: NonNegativeIntSchema,
    cachedTokens: NonNegativeIntSchema.optional(),
    trials: NonNegativeIntSchema,
  })
  .strict();

const TokenReportLaneSchema = z
  .object({
    lane: NonEmptyStringSchema,
    inputTokens: NonNegativeIntSchema,
    outputTokens: NonNegativeIntSchema,
    totalTokens: NonNegativeIntSchema,
    cachedTokens: NonNegativeIntSchema.optional(),
    trials: NonNegativeIntSchema,
  })
  .strict();

const TokenReportCaseSchema = z
  .object({
    lane: NonEmptyStringSchema,
    caseId: NonEmptyStringSchema,
    condition: NonEmptyStringSchema,
    inputTokens: NonNegativeIntSchema,
    outputTokens: NonNegativeIntSchema,
    totalTokens: NonNegativeIntSchema,
    cachedTokens: NonNegativeIntSchema.optional(),
    trials: NonNegativeIntSchema,
  })
  .strict();

export const TokenReportSummarySchema = z
  .object({
    grandTotal: TokenReportGrandTotalSchema,
    perLane: z.array(TokenReportLaneSchema),
    perCase: z.array(TokenReportCaseSchema),
    snapshotCheck: SnapshotCheckReportSchema.optional(),
  })
  .strict();

export const NormalizedProviderOutputSchema = z
  .object({
    finalText: z.string(),
    reasoningText: z.string().optional(),
    messages: z.array(z.string()),
    referencedSkills: z.array(NonEmptyStringSchema),
    selectedSkill: ExpectedSkillSchema.optional(),
    toolCalls: z.array(UnknownRecordSchema),
    tokenUsage: TokenUsageSchema.optional(),
  })
  .strict();

export const EvalResultSchema = z
  .object({
    runId: NonEmptyStringSchema,
    providerId: NonEmptyStringSchema,
    providerVersion: NonEmptyStringSchema.optional(),
    modelId: NonEmptyStringSchema.optional(),
    lane: EvalLaneSchema,
    caseId: NonEmptyStringSchema,
    category: NonEmptyStringSchema,
    condition: SkillConditionSchema,
    expectedSkill: ExpectedSkillSchema,
    trial: NonNegativeIntSchema,
    ok: z.boolean(),
    score: ScoreBreakdownSchema,
    promptScore: PromptCaseScoreSchema.optional(),
    workflowChecks: z.array(WorkflowCheckResultSchema),
    antiPatternFindings: z.array(AntiPatternFindingSchema),
    bundleCompleteness: BundleCompletenessScoreSchema.optional(),
    reportCompleteness: ReportCompletenessScoreSchema.optional(),
    evidenceQuality: EvidenceQualityScoreSchema.optional(),
    transcriptPath: PathStringSchema.optional(),
    stdoutPath: PathStringSchema.optional(),
    stderrPath: PathStringSchema.optional(),
    artifactManifestPath: PathStringSchema.optional(),
    bundlePath: PathStringSchema.optional(),
    eventLogPath: PathStringSchema.optional(),
    normalizedOutput: NormalizedProviderOutputSchema,
    judgeScore: UnitIntervalSchema.optional(),
    errorClass: NonEmptyStringSchema.optional(),
    errorMessage: NonEmptyStringSchema.optional(),
    startedAt: IsoTimestampSchema,
    completedAt: IsoTimestampSchema,
    durationMs: NonNegativeIntSchema,
  })
  .strict()
  .superRefine((obj, ctx) => {
    addTimestampOrderIssue(obj.startedAt, obj.completedAt, ctx);
  });

export const AggregateMetricsSchema = z
  .object({
    totalCases: NonNegativeIntSchema,
    passed: NonNegativeIntSchema,
    failed: NonNegativeIntSchema,
    passRate: UnitIntervalSchema,
    averageScore: NonNegativeNumberSchema,
    workflowComplianceRate: UnitIntervalSchema,
    antiPatternIncidenceRate: UnitIntervalSchema,
    bundleCompletenessRate: UnitIntervalSchema.optional(),
    reportCompletenessRate: UnitIntervalSchema.optional(),
    evidenceQualityRate: UnitIntervalSchema.optional(),
  })
  .strict()
  .superRefine((obj, ctx) => {
    if (obj.passed + obj.failed !== obj.totalCases) {
      ctx.addIssue({
        code: 'custom',
        message: 'passed + failed must equal totalCases',
        path: ['totalCases'],
      });
    }
  });

export const ConditionAggregateSummarySchema = z
  .object({
    condition: SkillConditionSchema,
    totalCases: NonNegativeIntSchema,
    passed: NonNegativeIntSchema,
    failed: NonNegativeIntSchema,
    passRate: UnitIntervalSchema,
    averageScore: NonNegativeNumberSchema,
  })
  .strict()
  .superRefine((obj, ctx) => {
    if (obj.passed + obj.failed !== obj.totalCases) {
      ctx.addIssue({
        code: 'custom',
        message: 'passed + failed must equal totalCases',
        path: ['totalCases'],
      });
    }
  });

export const ConditionComparisonSummarySchema = z
  .object({
    comparedConditions: z.array(SkillConditionSchema).min(2),
    comparedGroups: NonNegativeIntSchema,
    comparedCases: NonNegativeIntSchema,
    conditionBreakdown: z.array(ConditionAggregateSummarySchema).min(2),
    keyDeltas: z
      .object({
        realizedSkillLift: FiniteNumberSchema.optional(),
        oracleSkillLift: FiniteNumberSchema.optional(),
        routingGap: FiniteNumberSchema.optional(),
        staleSkillHarm: FiniteNumberSchema.optional(),
        regressionRate: FiniteNumberSchema.optional(),
        unlockRate: FiniteNumberSchema.optional(),
        routingEfficiency: FiniteNumberSchema.optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((obj, ctx) => {
    if (obj.conditionBreakdown.length !== obj.comparedConditions.length) {
      ctx.addIssue({
        code: 'custom',
        message:
          'conditionBreakdown length must match comparedConditions length',
        path: ['conditionBreakdown'],
      });
    }
  });

const ProviderAggregateSchema = z
  .object({
    providerId: NonEmptyStringSchema,
    aggregate: AggregateMetricsSchema,
    comparisons: z.array(ComparisonMetricsSchema),
    results: z.array(EvalResultSchema),
  })
  .strict();

export const ProviderComparisonReportSchema = z
  .object({
    metadata: RunMetadataSchema,
    aggregate: AggregateMetricsSchema,
    matrix: z.array(MatrixEntrySchema),
    providers: z.array(ProviderAggregateSchema),
    comparisons: z.array(ComparisonMetricsSchema),
  })
  .strict();

export const ConfidenceIntervalSchema = z
  .object({
    lower: FiniteNumberSchema,
    upper: FiniteNumberSchema,
  })
  .strict();

export const TrialAggregationSchema = z
  .object({
    lane: EvalLaneSchema,
    caseId: NonEmptyStringSchema,
    condition: SkillConditionSchema,
    trials: PositiveIntSchema,
    passRate: UnitIntervalSchema,
    passRateCI: ConfidenceIntervalSchema,
    meanScore: FiniteNumberSchema,
    stdDev: NonNegativeNumberSchema,
    scoreCI: ConfidenceIntervalSchema,
    minScore: FiniteNumberSchema,
    maxScore: FiniteNumberSchema,
  })
  .strict();

export const PerCaseComparisonSchema = z
  .object({
    caseId: NonEmptyStringSchema,
    condition: SkillConditionSchema,
    baselinePassRate: UnitIntervalSchema,
    candidatePassRate: UnitIntervalSchema,
    baselineMeanScore: FiniteNumberSchema,
    candidateMeanScore: FiniteNumberSchema,
    scoreDelta: z
      .object({
        mean: FiniteNumberSchema,
        ci: ConfidenceIntervalSchema,
        significant: z.boolean(),
      })
      .strict(),
    passRateDelta: z
      .object({
        mean: FiniteNumberSchema,
        ci: ConfidenceIntervalSchema,
        significant: z.boolean(),
      })
      .strict(),
    winRate: z
      .object({
        wins: NonNegativeIntSchema,
        losses: NonNegativeIntSchema,
        ties: NonNegativeIntSchema,
        n: NonNegativeIntSchema,
        winRate: UnitIntervalSchema,
      })
      .strict(),
    verdict: z.enum(['improved', 'regressed', 'inconclusive']),
  })
  .strict();

export const BaselineOverallSchema = z
  .object({
    baselineMeanScore: FiniteNumberSchema,
    candidateMeanScore: FiniteNumberSchema,
    baselinePassRate: UnitIntervalSchema,
    candidatePassRate: UnitIntervalSchema,
    totalWins: NonNegativeIntSchema,
    totalLosses: NonNegativeIntSchema,
    totalTies: NonNegativeIntSchema,
    verdict: z.enum(['improved', 'regressed', 'inconclusive']),
  })
  .strict();

export const BaselineComparisonSchema = z
  .object({
    baselineRunId: NonEmptyStringSchema,
    baselineCreatedAt: IsoTimestampSchema,
    overall: BaselineOverallSchema,
    perCase: z.array(PerCaseComparisonSchema),
  })
  .strict();

export const JsonReportSchema = z
  .object({
    metadata: RunMetadataSchema,
    aggregate: AggregateMetricsSchema,
    conditionComparisonSummary: ConditionComparisonSummarySchema.optional(),
    comparisons: z.array(ComparisonMetricsSchema),
    results: z.array(EvalResultSchema),
    providerComparison: ProviderComparisonReportSchema.optional(),
    aggregated: z.array(TrialAggregationSchema).optional(),
    baselineComparison: BaselineComparisonSchema.optional(),
    tokenReport: TokenReportSummarySchema.optional(),
  })
  .strict();

export const EvalCliOptionsSchema = z
  .object({
    args: StringListSchema,
    cwd: PathStringSchema.optional(),
    env: StringRecordSchema.optional(),
    home: PathStringSchema.optional(),
    timeoutMs: NonNegativeIntSchema.optional(),
    json: z.boolean(),
  })
  .strict();

export const EvalCliResultSchema = z
  .object({
    command: StringListSchema,
    cwd: PathStringSchema,
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    ok: z.boolean(),
    durationMs: NonNegativeIntSchema,
    stdout: z.string(),
    stderr: z.string(),
    parsed: z.unknown().optional(),
  })
  .strict();

export const EvalEventRecordSchema = EventRecordSchema;

export const ProviderPromptRequestSchema = z
  .object({
    runId: NonEmptyStringSchema,
    providerId: NonEmptyStringSchema,
    condition: SkillConditionSchema,
    trial: NonNegativeIntSchema,
    modelId: NonEmptyStringSchema.optional(),
    cwd: PathStringSchema.optional(),
    env: StringRecordSchema.optional(),
    evalCase: PromptEvalCaseSchema,
  })
  .strict();

export const ProviderPromptResultSchema = z
  .object({
    request: ProviderPromptRequestSchema,
    runtime: ProviderRuntimeInfoSchema,
    ok: z.boolean(),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    startedAt: IsoTimestampSchema,
    completedAt: IsoTimestampSchema,
    durationMs: NonNegativeIntSchema,
    rawStdout: z.string(),
    rawStderr: z.string(),
    normalized: NormalizedProviderOutputSchema,
    errorClass: NonEmptyStringSchema.optional(),
    errorMessage: NonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((obj, ctx) => {
    addTimestampOrderIssue(obj.startedAt, obj.completedAt, ctx);
  });

export const ProviderAgentRequestSchema = z
  .object({
    runId: NonEmptyStringSchema,
    providerId: NonEmptyStringSchema,
    condition: SkillConditionSchema,
    trial: NonNegativeIntSchema,
    modelId: NonEmptyStringSchema.optional(),
    cwd: PathStringSchema,
    homeDir: PathStringSchema.optional(),
    outputDir: PathStringSchema.optional(),
    env: StringRecordSchema.optional(),
    evalCase: AgentEvalCaseSchema,
  })
  .strict();

export const ProviderAgentResultSchema = z
  .object({
    request: ProviderAgentRequestSchema,
    runtime: ProviderRuntimeInfoSchema,
    ok: z.boolean(),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    startedAt: IsoTimestampSchema,
    completedAt: IsoTimestampSchema,
    durationMs: NonNegativeIntSchema,
    rawStdout: z.string(),
    rawStderr: z.string(),
    normalized: NormalizedProviderOutputSchema,
    sessionId: NonEmptyStringSchema.optional(),
    transcriptPath: PathStringSchema.optional(),
    bundlePath: PathStringSchema.optional(),
    eventLogPath: PathStringSchema.optional(),
    errorClass: NonEmptyStringSchema.optional(),
    errorMessage: NonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((obj, ctx) => {
    addTimestampOrderIssue(obj.startedAt, obj.completedAt, ctx);
  });

export const ProviderConfigSchema = z
  .object({
    providerId: NonEmptyStringSchema,
    mode: ProviderModeSchema,
    command: StringListSchema,
    cwd: PathStringSchema.optional(),
    env: StringRecordSchema.optional(),
    defaultModelId: NonEmptyStringSchema.optional(),
    timeoutMs: NonNegativeIntSchema.optional(),
    capabilities: ProviderCapabilitiesSchema,
    cannedOutputs: z
      .record(NonEmptyStringSchema, NormalizedProviderOutputSchema)
      .optional(),
  })
  .strict();

export type ExpectedSkillSchemaType = z.infer<typeof ExpectedSkillSchema>;
export type SkillConditionSchemaType = z.infer<typeof SkillConditionSchema>;
export type EvalLaneSchemaType = z.infer<typeof EvalLaneSchema>;
export type VerifierKindSchemaType = z.infer<typeof VerifierKindSchema>;
export type AntiPatternSeveritySchemaType = z.infer<
  typeof AntiPatternSeveritySchema
>;
export type ProviderModeSchemaType = z.infer<typeof ProviderModeSchema>;
export type ArtifactKindSchemaType = z.infer<typeof ArtifactKindSchema>;
export type BundleValidationProfileSchemaType = z.infer<
  typeof BundleValidationProfileSchema
>;
export type ScoreComponentSchemaType = z.infer<typeof ScoreComponentSchema>;
export type SetupStepSchemaType = z.infer<typeof SetupStepSchema>;
export type VerifierSpecSchemaType = z.infer<typeof VerifierSpecSchema>;
export type WorkflowCheckSchemaType = z.infer<typeof WorkflowCheckSchema>;
export type AntiPatternRuleSchemaType = z.infer<typeof AntiPatternRuleSchema>;
export type ArtifactRequirementSchemaType = z.infer<
  typeof ArtifactRequirementSchema
>;
export type ReportRequirementSchemaType = z.infer<
  typeof ReportRequirementSchema
>;
export type PatternMatchResultSchemaType = z.infer<
  typeof PatternMatchResultSchema
>;
export type ForbiddenPatternResultSchemaType = z.infer<
  typeof ForbiddenPatternResultSchema
>;
export type AntiPatternFindingSchemaType = z.infer<
  typeof AntiPatternFindingSchema
>;
export type WorkflowCheckResultSchemaType = z.infer<
  typeof WorkflowCheckResultSchema
>;
export type ScoreBreakdownSchemaType = z.infer<typeof ScoreBreakdownSchema>;
export type BundleCompletenessScoreSchemaType = z.infer<
  typeof BundleCompletenessScoreSchema
>;
export type ReportCompletenessScoreSchemaType = z.infer<
  typeof ReportCompletenessScoreSchema
>;
export type EvidenceQualityScoreSchemaType = z.infer<
  typeof EvidenceQualityScoreSchema
>;
export type RunMetadataSchemaType = z.infer<typeof RunMetadataSchema>;
export type MatrixEntrySchemaType = z.infer<typeof MatrixEntrySchema>;
export type ComparisonMetricsSchemaType = z.infer<
  typeof ComparisonMetricsSchema
>;
export type PromptEvalCaseSchemaType = z.infer<typeof PromptEvalCaseSchema>;
export type ExecutionEvalCaseSchemaType = z.infer<
  typeof ExecutionEvalCaseSchema
>;
export type DogfoodEvalCaseSchemaType = z.infer<typeof DogfoodEvalCaseSchema>;
export type EvalCaseSchemaType = z.infer<typeof EvalCaseSchema>;
export type PromptCaseScoreSchemaType = z.infer<typeof PromptCaseScoreSchema>;
export type ProviderCapabilitiesSchemaType = z.infer<
  typeof ProviderCapabilitiesSchema
>;
export type ProviderRuntimeInfoSchemaType = z.infer<
  typeof ProviderRuntimeInfoSchema
>;
export type TokenUsageSchemaType = z.infer<typeof TokenUsageSchema>;
export type TokenReportSummarySchemaType = z.infer<
  typeof TokenReportSummarySchema
>;
export type NormalizedProviderOutputSchemaType = z.infer<
  typeof NormalizedProviderOutputSchema
>;
export type EvalResultSchemaType = z.infer<typeof EvalResultSchema>;
export type AggregateMetricsSchemaType = z.infer<typeof AggregateMetricsSchema>;
export type ProviderComparisonReportSchemaType = z.infer<
  typeof ProviderComparisonReportSchema
>;
export type ConfidenceIntervalSchemaType = z.infer<
  typeof ConfidenceIntervalSchema
>;
export type TrialAggregationSchemaType = z.infer<typeof TrialAggregationSchema>;
export type PerCaseComparisonSchemaType = z.infer<
  typeof PerCaseComparisonSchema
>;
export type BaselineOverallSchemaType = z.infer<typeof BaselineOverallSchema>;
export type BaselineComparisonSchemaType = z.infer<
  typeof BaselineComparisonSchema
>;
export type JsonReportSchemaType = z.infer<typeof JsonReportSchema>;
export type EvalCliOptionsSchemaType = z.infer<typeof EvalCliOptionsSchema>;
export type EvalCliResultSchemaType = z.infer<typeof EvalCliResultSchema>;
export type EvalEventRecordSchemaType = z.infer<typeof EvalEventRecordSchema>;
export type ProviderPromptRequestSchemaType = z.infer<
  typeof ProviderPromptRequestSchema
>;
export type ProviderPromptResultSchemaType = z.infer<
  typeof ProviderPromptResultSchema
>;
export type ProviderAgentRequestSchemaType = z.infer<
  typeof ProviderAgentRequestSchema
>;
export type ProviderAgentResultSchemaType = z.infer<
  typeof ProviderAgentResultSchema
>;
export type ProviderConfigSchemaType = z.infer<typeof ProviderConfigSchema>;

type AssertExact<T, U> = [T] extends [U]
  ? [U] extends [T]
    ? true
    : never
  : never;

export type _ArtifactKindSchemaParity = AssertExact<
  ArtifactKind,
  ArtifactKindSchemaType
>;
export type _BundleValidationProfileSchemaParity = AssertExact<
  BundleValidationProfile,
  BundleValidationProfileSchemaType
>;
export type _PatternMatchResultSchemaParity = AssertExact<
  PatternMatchResult,
  PatternMatchResultSchemaType
>;
export type _AntiPatternFindingSchemaParity = AssertExact<
  AntiPatternFinding,
  AntiPatternFindingSchemaType
>;
export type _BundleCompletenessScoreSchemaParity = AssertExact<
  BundleCompletenessScore,
  BundleCompletenessScoreSchemaType
>;
export type _ReportCompletenessScoreSchemaParity = AssertExact<
  ReportCompletenessScore,
  ReportCompletenessScoreSchemaType
>;
export type _MatrixEntrySchemaParity = AssertExact<
  MatrixEntry,
  MatrixEntrySchemaType
>;
export type _ComparisonMetricsSchemaParity = AssertExact<
  ComparisonMetrics,
  ComparisonMetricsSchemaType
>;
export type _PromptEvalCaseSchemaParity = AssertExact<
  PromptEvalCase,
  PromptEvalCaseSchemaType
>;
export type _ExecutionEvalCaseSchemaParity = AssertExact<
  ExecutionEvalCase,
  ExecutionEvalCaseSchemaType
>;
export type _DogfoodEvalCaseSchemaParity = AssertExact<
  DogfoodEvalCase,
  DogfoodEvalCaseSchemaType
>;
export type _EvalCaseSchemaParity = AssertExact<EvalCase, EvalCaseSchemaType>;
export type _PromptCaseScoreSchemaParity = AssertExact<
  PromptCaseScore,
  PromptCaseScoreSchemaType
>;
export type _EvalResultSchemaParity = AssertExact<
  EvalResult,
  EvalResultSchemaType
>;
export type _AggregateMetricsSchemaParity = AssertExact<
  AggregateMetrics,
  AggregateMetricsSchemaType
>;
export type _ConfidenceIntervalSchemaParity = AssertExact<
  ConfidenceInterval,
  ConfidenceIntervalSchemaType
>;
export type _TrialAggregationSchemaParity = AssertExact<
  TrialAggregation,
  TrialAggregationSchemaType
>;
export type _PerCaseComparisonSchemaParity = AssertExact<
  PerCaseComparison,
  PerCaseComparisonSchemaType
>;
export type _BaselineOverallSchemaParity = AssertExact<
  BaselineOverall,
  BaselineOverallSchemaType
>;
export type _BaselineComparisonSchemaParity = AssertExact<
  BaselineComparison,
  BaselineComparisonSchemaType
>;
export type _JsonReportSchemaParity = AssertExact<
  JsonReport,
  JsonReportSchemaType
>;
export type _ProviderComparisonReportSchemaParity = AssertExact<
  ProviderComparisonReport,
  ProviderComparisonReportSchemaType
>;
export type _EvalCliOptionsSchemaParity = AssertExact<
  EvalCliOptions,
  EvalCliOptionsSchemaType
>;
export type _EvalCliResultSchemaParity = AssertExact<
  EvalCliResult,
  EvalCliResultSchemaType
>;
export type _EvalEventRecordSchemaParity = AssertExact<
  EvalEventRecord,
  EvalEventRecordSchemaType
>;
export type _ProviderPromptRequestSchemaParity = AssertExact<
  ProviderPromptRequest,
  ProviderPromptRequestSchemaType
>;
export type _ProviderPromptResultSchemaParity = AssertExact<
  ProviderPromptResult,
  ProviderPromptResultSchemaType
>;
export type _ProviderAgentRequestSchemaParity = AssertExact<
  ProviderAgentRequest,
  ProviderAgentRequestSchemaType
>;
export type _ProviderAgentResultSchemaParity = AssertExact<
  ProviderAgentResult,
  ProviderAgentResultSchemaType
>;
export type _ProviderRuntimeInfoSchemaParity = AssertExact<
  ProviderRuntimeInfo,
  ProviderRuntimeInfoSchemaType
>;
export type _TokenUsageSchemaParity = AssertExact<
  TokenUsage,
  TokenUsageSchemaType
>;
export type _TokenReportSummarySchemaParity = AssertExact<
  TokenReportSummary,
  TokenReportSummarySchemaType
>;
export type _NormalizedProviderOutputSchemaParity = AssertExact<
  NormalizedProviderOutput,
  NormalizedProviderOutputSchemaType
>;
export type _ProviderCapabilitiesSchemaParity = AssertExact<
  ProviderCapabilities,
  ProviderCapabilitiesSchemaType
>;
export type _ProviderConfigSchemaParity = AssertExact<
  ProviderConfig,
  ProviderConfigSchemaType
>;
