import type { EventRecord } from '../../src/protocol/schemas.js';
import type { ArtifactKind } from '../../src/tools/review-bundle.js';
import type {
  BundleValidationCheck,
  BundleValidationProfile,
} from '../../src/tools/validate-bundle.js';

/** Expected skill for an eval case. */
export type ExpectedSkill = 'none' | 'agent-tty' | 'dogfood-tui';

/** Skill loading condition for an eval run. */
export type SkillCondition = 'none' | 'self-load' | 'preloaded' | 'stale';

/** Eval lane identifier. */
export type EvalLane = 'prompt' | 'execution' | 'dogfood';

/** Deterministic verifier kind. */
export type VerifierKind =
  | 'snapshot'
  | 'screenshot'
  | 'event-log'
  | 'json'
  | 'bundle'
  | 'command'
  | 'custom';

/** Severity for anti-pattern findings. */
export type AntiPatternSeverity = 'info' | 'warning' | 'error';

/** Provider execution mode. */
export type ProviderMode = 'stub' | 'plan-only' | 'agent-run';

/** Weighted score component for a breakdown. */
export interface ScoreComponent {
  name: string;
  score: number;
  maxScore: number;
  reason?: string;
}

/** Setup command that prepares an execution or dogfood case. */
export interface SetupStep {
  id: string;
  description: string;
  command: string;
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** Deterministic verifier configuration for a case. */
export interface VerifierSpec {
  id: string;
  kind: VerifierKind;
  description: string;
  required: boolean;
  config: Record<string, unknown>;
}

/** Workflow rule used for compliance scoring. */
export interface WorkflowCheck {
  id: string;
  description: string;
  required: boolean;
  requiredPatterns: string[];
  forbiddenPatterns: string[];
  dependsOn: string[];
  weight?: number;
}

/** Anti-pattern rule used for transcript analysis. */
export interface AntiPatternRule {
  id: string;
  description: string;
  severity: AntiPatternSeverity;
  patterns: string[];
  suggestedFix: string;
  lanes?: EvalLane[];
}

/** Artifact requirement for a proof bundle or run output. */
export interface ArtifactRequirement {
  kind: ArtifactKind;
  required: boolean;
  description: string;
  minCount?: number;
  pathPatterns: string[];
}

/** Report requirement for dogfood notes or summaries. */
export interface ReportRequirement {
  id: string;
  description: string;
  required: boolean;
  section?: string;
  requiredPatterns: string[];
  forbiddenPatterns: string[];
}

/** Positive pattern match details for deterministic scoring. */
export interface PatternMatchResult {
  pattern: string;
  matched: boolean;
  matchedTexts: string[];
  lineNumbers: number[];
  matchCount: number;
}

/** Forbidden pattern match details for deterministic scoring. */
export interface ForbiddenPatternResult {
  pattern: string;
  violated: boolean;
  matchedTexts: string[];
  lineNumbers: number[];
  matchCount: number;
}

/** Anti-pattern detection finding emitted from a transcript scan. */
export interface AntiPatternFinding {
  ruleId: string;
  severity: AntiPatternSeverity;
  message: string;
  matchedText?: string;
  lineNumber?: number;
  suggestedFix?: string;
}

/** Workflow check result emitted during scoring. */
export interface WorkflowCheckResult {
  checkId: string;
  passed: boolean;
  message?: string;
  matches: PatternMatchResult[];
  forbiddenMatches: ForbiddenPatternResult[];
}

/** Generic numeric breakdown for deterministic scoring. */
export interface ScoreBreakdown {
  total: number;
  maxPossible: number;
  items: ScoreComponent[];
}

/** Bundle completeness result derived from bundle validation checks. */
export interface BundleCompletenessScore {
  profile: BundleValidationProfile;
  totalChecks: number;
  passed: number;
  failed: number;
  score: number;
  details: BundleValidationCheck[];
}

/** Report completeness result for dogfood notes and summaries. */
export interface ReportCompletenessScore {
  sectionsExpected: number;
  sectionsFound: number;
  score: number;
  missingSections: string[];
  matchedRequirements: PatternMatchResult[];
  forbiddenFindings: ForbiddenPatternResult[];
}

/** Aggregate evidence-quality score for dogfood outputs. */
export interface EvidenceQualityScore {
  score: number;
  artifactCoverage: number;
  breakdown: ScoreBreakdown;
  bundleCompleteness?: BundleCompletenessScore;
  reportCompleteness?: ReportCompletenessScore;
  notes: string[];
}

/** Metadata describing a whole eval report run. */
export interface RunMetadata {
  runId: string;
  createdAt: string;
  repoRoot: string;
  providers: string[];
  models: string[];
  lanes: EvalLane[];
  conditions: SkillCondition[];
  totalTrials: number;
  notes: string[];
}

/** Matrix entry representing one case/provider/condition combination. */
export interface MatrixEntry {
  providerId: string;
  lane: EvalLane;
  caseId: string;
  category: string;
  condition: SkillCondition;
  expectedSkill: ExpectedSkill;
  fixture?: string;
  target?: string;
}

/** Derived comparison metrics across skill conditions. */
export interface ComparisonMetrics {
  providerId: string;
  lane: EvalLane;
  groupKey: string;
  caseIds: string[];
  expectedSkill: ExpectedSkill;
  totalCompared: number;
  category?: string;
  fixture?: string;
  target?: string;
  missingConditions: SkillCondition[];
  realizedSkillLift?: number;
  oracleSkillLift?: number;
  routingGap?: number;
  staleSkillHarm?: number;
  regressionRate?: number;
  unlockRate?: number;
  routingEfficiency?: number;
}

/** Prompt-only eval case for routing and planning checks. */
export interface PromptEvalCase {
  id: string;
  lane: 'prompt';
  category: 'trigger' | 'selection' | 'workflow' | 'anti-pattern';
  prompt: string;
  expectedSkill: ExpectedSkill;
  context?: string;
  expectedPatterns: string[];
  forbiddenPatterns: string[];
  rubric: string[];
  workflowChecks: WorkflowCheck[];
  antiPatterns: AntiPatternRule[];
  budgets: {
    timeoutMs: number;
  };
}

/** Closed-loop execution eval case for terminal workflows. */
export interface ExecutionEvalCase {
  id: string;
  lane: 'execution';
  category: 'session' | 'tui' | 'artifact' | 'recovery';
  prompt: string;
  expectedSkill: ExpectedSkill;
  fixture?: string;
  target?: string;
  conditions: SkillCondition[];
  setup: SetupStep[];
  verifiers: VerifierSpec[];
  workflowChecks: WorkflowCheck[];
  antiPatterns: AntiPatternRule[];
  artifactRequirements: ArtifactRequirement[];
  budgets: {
    timeoutMs: number;
    maxAgentSteps?: number;
    maxWallClockMs?: number;
  };
}

/** Dogfood eval case for evidence capture and reporting quality. */
export interface DogfoodEvalCase {
  id: string;
  lane: 'dogfood';
  category: 'qa' | 'release-readiness' | 'bug-repro' | 'reporting';
  prompt: string;
  expectedSkill: ExpectedSkill;
  fixture?: string;
  target?: string;
  bundlePath: string;
  bundleRequirements: string[];
  conditions: SkillCondition[];
  validationProfile: BundleValidationProfile;
  artifactRequirements: ArtifactRequirement[];
  reportRequirements: ReportRequirement[];
  verifiers: VerifierSpec[];
  workflowChecks: WorkflowCheck[];
  antiPatterns: AntiPatternRule[];
  budgets: {
    timeoutMs: number;
    maxWallClockMs?: number;
  };
}

/** Any supported eval case. */
export type EvalCase = PromptEvalCase | ExecutionEvalCase | DogfoodEvalCase;

/** Detailed prompt-lane score for one case response. */
export interface PromptCaseScore {
  expectedSkillCorrect: boolean;
  patternMatches: PatternMatchResult[];
  forbiddenPatternMatches: ForbiddenPatternResult[];
  workflowChecks: WorkflowCheckResult[];
  antiPatternFindings: AntiPatternFinding[];
  breakdown: ScoreBreakdown;
  passed: boolean;
}

/** One normalized eval result emitted by a lane runner. */
export interface EvalResult {
  runId: string;
  providerId: string;
  providerVersion?: string;
  modelId?: string;
  lane: EvalLane;
  caseId: string;
  category: string;
  condition: SkillCondition;
  expectedSkill: ExpectedSkill;
  trial: number;
  ok: boolean;
  score: ScoreBreakdown;
  promptScore?: PromptCaseScore;
  workflowChecks: WorkflowCheckResult[];
  antiPatternFindings: AntiPatternFinding[];
  bundleCompleteness?: BundleCompletenessScore;
  reportCompleteness?: ReportCompletenessScore;
  evidenceQuality?: EvidenceQualityScore;
  transcriptPath?: string;
  stdoutPath?: string;
  stderrPath?: string;
  artifactManifestPath?: string;
  bundlePath?: string;
  eventLogPath?: string;
  normalizedOutput: NormalizedProviderOutput;
  judgeScore?: number;
  errorClass?: string;
  errorMessage?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

/** Aggregate metrics for a set of eval results. */
export interface AggregateMetrics {
  totalCases: number;
  passed: number;
  failed: number;
  passRate: number;
  averageScore: number;
  workflowComplianceRate: number;
  antiPatternIncidenceRate: number;
  bundleCompletenessRate?: number;
  reportCompletenessRate?: number;
  evidenceQualityRate?: number;
}

/** JSON-serializable top-level eval report. */
export interface JsonReport {
  metadata: RunMetadata;
  aggregate: AggregateMetrics;
  comparisons: ComparisonMetrics[];
  results: EvalResult[];
  providerComparison?: ProviderComparisonReport;
}

/** Cross-provider comparison view for an eval run. */
export interface ProviderComparisonReport {
  metadata: RunMetadata;
  aggregate: AggregateMetrics;
  matrix: MatrixEntry[];
  providers: Array<{
    providerId: string;
    aggregate: AggregateMetrics;
    comparisons: ComparisonMetrics[];
    results: EvalResult[];
  }>;
  comparisons: ComparisonMetrics[];
}

/** Options for invoking the repo CLI from eval code. */
export interface EvalCliOptions {
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  home?: string;
  timeoutMs?: number;
  json: boolean;
}

/** Result envelope for a repo CLI invocation. */
export interface EvalCliResult {
  command: string[];
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  ok: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  parsed?: unknown;
}

/** Canonical event-log record used by eval helpers. */
export type EvalEventRecord = EventRecord;

/** Request payload for a provider plan-only eval invocation. */
export interface ProviderPromptRequest {
  runId: string;
  providerId: string;
  condition: SkillCondition;
  trial: number;
  modelId?: string;
  cwd?: string;
  env?: Record<string, string>;
  evalCase: PromptEvalCase;
}

/** Normalized result from a provider plan-only eval invocation. */
export interface ProviderPromptResult {
  request: ProviderPromptRequest;
  runtime: ProviderRuntimeInfo;
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  rawStdout: string;
  rawStderr: string;
  normalized: NormalizedProviderOutput;
  errorClass?: string;
  errorMessage?: string;
}

/** Request payload for a provider agent-run eval invocation. */
export interface ProviderAgentRequest {
  runId: string;
  providerId: string;
  condition: SkillCondition;
  trial: number;
  modelId?: string;
  cwd: string;
  homeDir?: string;
  outputDir?: string;
  env?: Record<string, string>;
  evalCase: ExecutionEvalCase | DogfoodEvalCase;
}

/** Normalized result from a provider agent-run eval invocation. */
export interface ProviderAgentResult {
  request: ProviderAgentRequest;
  runtime: ProviderRuntimeInfo;
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  rawStdout: string;
  rawStderr: string;
  normalized: NormalizedProviderOutput;
  sessionId?: string;
  transcriptPath?: string;
  bundlePath?: string;
  eventLogPath?: string;
  errorClass?: string;
  errorMessage?: string;
}

/** Detected runtime properties for an eval provider. */
export interface ProviderRuntimeInfo {
  providerId: string;
  available: boolean;
  detectedAt: string;
  version?: string;
  commandPath?: string;
  defaultModelId?: string;
  capabilities: ProviderCapabilities;
  notes: string[];
}

/** Provider output normalized for downstream scoring and storage. */
export interface NormalizedProviderOutput {
  finalText: string;
  reasoningText?: string;
  messages: string[];
  referencedSkills: string[];
  selectedSkill?: ExpectedSkill;
  toolCalls: Array<Record<string, unknown>>;
}

/** Capability flags exposed by a provider adapter. */
export interface ProviderCapabilities {
  supportsDetect: boolean;
  supportsPlanMode: boolean;
  supportsAgentMode: boolean;
  supportsStreaming: boolean;
  supportsToolCalls: boolean;
  supportsTranscriptCapture: boolean;
}

/** Provider configuration used by the eval harness. */
export interface ProviderConfig {
  providerId: string;
  mode: ProviderMode;
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  defaultModelId?: string;
  timeoutMs?: number;
  capabilities: ProviderCapabilities;
  cannedOutputs?: Record<string, NormalizedProviderOutput>;
}
