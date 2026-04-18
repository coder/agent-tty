import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { assertString, invariant } from '../../src/util/assert.js';
import {
  buildScannableTranscript,
  countAgentTtyCalls,
  detectAntiPatterns,
} from '../lib/antiPatterns.js';
import { cleanupEvalHome, createIsolatedEvalHome } from '../lib/cliHarness.js';
import { EvalResultSchema } from '../lib/schemas.js';
import { runScheduled } from '../lib/scheduler.js';
import { checkWorkflow } from '../lib/scoring.js';
import { assertUniqueWorkItems, buildWorkItemKey } from '../lib/types.js';
import type { ScheduledWorkItem } from '../lib/scheduler.js';
import type {
  AntiPatternFinding,
  ArtifactRequirement,
  EvalResult,
  EvalWorkItemIdentity,
  ExecutionEvalCase,
  NormalizedProviderOutput,
  ProviderRuntimeInfo,
  RunMetadata,
  ScoreComponent,
  SkillCondition,
  VerifierSpec,
  WorkflowCheckResult,
} from '../lib/types.js';
import type { ReporterDispatcher } from '../reporters/dispatch.js';
import {
  CaseProgressTracker,
  computePlannedCases,
} from '../reporters/runtime.js';
import type { EvalProvider } from '../providers/base.js';
import { altScreenDemoCase } from './cases/alt-screen-demo.js';
import { colorGridCase } from './cases/color-grid.js';
import { crashRecoveryCase } from './cases/crash-recovery.js';
import { doctorGatedCase } from './cases/doctor-gated.js';
import { exportProofCase } from './cases/export-proof.js';
import { helloPromptCase } from './cases/hello-prompt.js';
import { resizeDemoCase } from './cases/resize-demo.js';
import { runCommandCase } from './cases/run-command.js';
import { scrollbackDemoCase } from './cases/scrollback-demo.js';
import { unicodeGridCase } from './cases/unicode-grid.js';
import {
  EXECUTION_CASE_COVERAGE,
  getExecutionCaseCoverage,
} from './cases/shared.js';
import type { VerifierResult } from './verifiers/index.js';
import { verify, verifyArtifactExists } from './verifiers/index.js';

const EXECUTION_CASES = [
  helloPromptCase,
  resizeDemoCase,
  altScreenDemoCase,
  colorGridCase,
  unicodeGridCase,
  scrollbackDemoCase,
  crashRecoveryCase,
  exportProofCase,
  runCommandCase,
  doctorGatedCase,
] satisfies readonly ExecutionEvalCase[];

const CASE_CATEGORY_EXPECTATIONS = {
  session: 2,
  tui: 3,
  artifact: 4,
  recovery: 1,
} as const;
const RUNNER_OUTPUT_PREFIX = 'agent-tty-execution-eval-';
const DEFAULT_TOTAL_TRIALS = 1;

type ExecutionWorkItem = EvalWorkItemIdentity &
  ScheduledWorkItem & {
    evalCase: ExecutionEvalCase;
  };

type ExecutionLaneOptions = {
  conditions?: SkillCondition[];
  caseFilter?: string[];
  concurrency?: number;
  reporter?: ReporterDispatcher;
};

type EvaluatedVerifier = {
  spec: VerifierSpec;
  result: VerifierResult;
};

interface LoadedExecutionSkillPrompts {
  bootstrapSkillText: string;
  canonicalAgentTtySkillText: string;
}

let loadedExecutionSkillPromptsPromise:
  | Promise<LoadedExecutionSkillPrompts>
  | undefined;

const EXECUTION_INSTRUCTIONS = [
  'IMPORTANT: You must ACTUALLY PERFORM this task by running commands, not just describe what you would do.',
  'Use `npx tsx src/cli/main.ts` to invoke agent-tty commands.',
  'Set `AGENT_TTY_HOME` to the provided home directory for session isolation.',
].join('\n');

const STALE_EXECUTION_SKILL_TEXT = [
  'Legacy agent-tty guidance snapshot (known to be stale/wrong):',
  '- Start sessions with `agent-tty start` instead of `agent-tty create`.',
  '- Use `sleep 5` before checking terminal readiness instead of `agent-tty wait`.',
  '- Capture screenshots with `scrot` or other OS tools instead of `agent-tty screenshot`.',
  '- It is fine to leave sessions running after the task ends.',
  '',
  'Some of the guidance above is wrong for this repository snapshot. Verify commands against the current CLI behavior while completing the task.',
].join('\n');

const ENVIRONMENT_BLOCKED_ERROR_CLASS = 'environment-blocked';
const RENDERER_ENVIRONMENT_HINT =
  'Run `npx tsx src/cli/main.ts doctor --json` before retrying. If the renderer checks report a missing browser cache, run `npx playwright install chromium`.';
const RENDERER_ENVIRONMENT_ERROR_PATTERNS = [
  /Playwright browser cache not found/iu,
  /Run 'npx playwright install chromium' to install\./iu,
  /\bplaywright unavailable\b/iu,
  /\bplaywright not installed\b/iu,
  /\bplaywright import failed\b/iu,
  /\bghostty-web unavailable\b/iu,
  /\bbrowser launch failed\b/iu,
  /\bscreenshot smoke test failed\b/iu,
  /Failed to boot or replay renderer/iu,
  /Executable doesn't exist/iu,
] as const;
const RENDERER_DOCTOR_FAILURE_PATTERNS = [
  /"name"\s*:\s*"playwright_available"[\s\S]*?"status"\s*:\s*"fail"/iu,
  /"name"\s*:\s*"browser_cache_accessible"[\s\S]*?"status"\s*:\s*"(?:fail|skip)"/iu,
  /"name"\s*:\s*"browser_launch"[\s\S]*?"status"\s*:\s*"fail"/iu,
  /"name"\s*:\s*"ghostty_web_available"[\s\S]*?"status"\s*:\s*"fail"/iu,
  /"name"\s*:\s*"screenshot_viable"[\s\S]*?"status"\s*:\s*"fail"/iu,
  /"name"\s*:\s*"screenshot"[\s\S]*?"status"\s*:\s*"(?:unavailable|degraded)"/iu,
  /"name"\s*:\s*"record-export-webm"[\s\S]*?"status"\s*:\s*"(?:unavailable|degraded)"/iu,
] as const;

async function readSkillFile(relativePath: string): Promise<string> {
  const content = await readFile(
    new URL(relativePath, import.meta.url),
    'utf8',
  );
  assertString(content, `Skill file ${relativePath} must be a string`);
  invariant(content.length > 0, `Skill file ${relativePath} must not be empty`);
  return content;
}

async function loadExecutionSkillPrompts(): Promise<LoadedExecutionSkillPrompts> {
  loadedExecutionSkillPromptsPromise ??= (async () => {
    const [bootstrapSkillText, canonicalAgentTtySkillText] = await Promise.all([
      readSkillFile('../../skills/agent-tty/SKILL.md'),
      readSkillFile('../../skill-data/agent-tty/SKILL.md'),
    ]);

    return {
      bootstrapSkillText,
      canonicalAgentTtySkillText,
    };
  })();

  return loadedExecutionSkillPromptsPromise;
}

type EvaluatedArtifactRequirement = {
  requirement: ArtifactRequirement;
  result: VerifierResult;
};

assertExecutionCaseInventory(EXECUTION_CASES);

function assertExecutionCaseInventory(
  cases: readonly ExecutionEvalCase[],
): void {
  invariant(
    cases.length === 10,
    'Execution lane must register exactly 10 cases',
  );

  const seenIds = new Set<string>();
  const categoryCounts = {
    session: 0,
    tui: 0,
    artifact: 0,
    recovery: 0,
  };

  for (const evalCase of cases) {
    invariant(
      !seenIds.has(evalCase.id),
      `Duplicate execution case id: ${evalCase.id}`,
    );
    seenIds.add(evalCase.id);
    categoryCounts[evalCase.category] += 1;
  }

  for (const [category, expectedCount] of Object.entries(
    CASE_CATEGORY_EXPECTATIONS,
  ) as Array<[keyof typeof CASE_CATEGORY_EXPECTATIONS, number]>) {
    invariant(
      categoryCounts[category] === expectedCount,
      `Execution lane category ${category} must contain ${String(expectedCount)} cases`,
    );
  }
}

assertExecutionCaseCoverageMetadata(EXECUTION_CASES);

function assertExecutionCaseCoverageMetadata(
  cases: readonly ExecutionEvalCase[],
): void {
  const caseIds = new Set(cases.map((evalCase) => evalCase.id));
  const coverageIds = Object.keys(EXECUTION_CASE_COVERAGE);

  for (const caseId of caseIds) {
    invariant(
      coverageIds.includes(caseId),
      `Missing execution coverage metadata for case ${caseId}`,
    );
  }

  for (const coverageId of coverageIds) {
    invariant(
      caseIds.has(coverageId),
      `Execution coverage metadata references unknown case ${coverageId}`,
    );
  }
}

function matchesAnyPattern(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function detectRendererEnvironmentBlock(
  evalCase: ExecutionEvalCase,
  transcript: string,
  providerErrorMessage: string | undefined,
): string | undefined {
  const coverage = getExecutionCaseCoverage(evalCase.id);
  if (coverage.rendererRequirement !== 'required') {
    return undefined;
  }

  const combinedText = [transcript, providerErrorMessage]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join('\n');
  if (combinedText.length === 0) {
    return undefined;
  }

  if (
    !matchesAnyPattern(combinedText, RENDERER_ENVIRONMENT_ERROR_PATTERNS) &&
    !matchesAnyPattern(combinedText, RENDERER_DOCTOR_FAILURE_PATTERNS)
  ) {
    return undefined;
  }

  return [
    `Renderer-backed case ${evalCase.id} was blocked by missing or unhealthy Playwright/Chromium/ghostty-web dependencies.`,
    `Case note: ${coverage.summary}`,
    RENDERER_ENVIRONMENT_HINT,
  ].join(' ');
}

function safeRatio(numerator: number, denominator: number): number {
  if (denominator === 0) {
    return 1;
  }

  return numerator / denominator;
}

function countPassedWorkflowChecks(
  workflowChecks: readonly WorkflowCheckResult[],
  evalCase: ExecutionEvalCase,
): { passed: number; total: number; failed: WorkflowCheckResult[] } {
  const requiredCheckIds = new Set(
    evalCase.workflowChecks
      .filter((check) => check.required)
      .map((check) => check.id),
  );
  const failed = workflowChecks.filter(
    (result) => requiredCheckIds.has(result.checkId) && !result.passed,
  );

  return {
    passed: workflowChecks.filter(
      (result) => requiredCheckIds.has(result.checkId) && result.passed,
    ).length,
    total: requiredCheckIds.size,
    failed,
  };
}

function countPassedVerifiers(verifierResults: readonly EvaluatedVerifier[]): {
  passed: number;
  total: number;
  failed: EvaluatedVerifier[];
} {
  const requiredVerifiers = verifierResults.filter(({ spec }) => spec.required);
  return {
    passed: requiredVerifiers.filter(({ result }) => result.pass).length,
    total: requiredVerifiers.length,
    failed: requiredVerifiers.filter(({ result }) => !result.pass),
  };
}

function countPassedArtifactRequirements(
  artifactResults: readonly EvaluatedArtifactRequirement[],
): { passed: number; total: number; failed: EvaluatedArtifactRequirement[] } {
  const requiredArtifacts = artifactResults.filter(
    ({ requirement }) => requirement.required,
  );
  return {
    passed: requiredArtifacts.filter(({ result }) => result.pass).length,
    total: requiredArtifacts.length,
    failed: requiredArtifacts.filter(({ result }) => !result.pass),
  };
}

function antiPatternScore(findings: readonly AntiPatternFinding[]): number {
  return Math.max(0, 1 - Math.min(1, findings.length));
}

function summarizeAntiPatterns(
  findings: readonly AntiPatternFinding[],
): string {
  if (findings.length === 0) {
    return 'No anti-pattern findings';
  }

  const counts = {
    error: findings.filter((finding) => finding.severity === 'error').length,
    warning: findings.filter((finding) => finding.severity === 'warning')
      .length,
    info: findings.filter((finding) => finding.severity === 'info').length,
  };
  return `${String(counts.error)} error(s), ${String(counts.warning)} warning(s), ${String(counts.info)} info finding(s)`;
}

function createFallbackNormalizedOutput(
  transcript: string,
): NormalizedProviderOutput {
  return {
    finalText: transcript,
    messages: transcript.length === 0 ? [] : [transcript],
    referencedSkills: [],
    toolCalls: [],
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function pushSection(
  sections: string[],
  title: string,
  content: string | undefined,
): void {
  if (content === undefined || content.length === 0) {
    return;
  }

  sections.push(`## ${title}\n${content}`);
}

async function readTextIfExists(
  path: string | undefined,
): Promise<string | undefined> {
  if (path === undefined) {
    return undefined;
  }

  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function buildTranscript(result: {
  rawStdout: string;
  rawStderr: string;
  normalized: NormalizedProviderOutput;
  transcriptPath?: string;
}): Promise<string> {
  const sections: string[] = [];
  pushSection(sections, 'raw-stdout', result.rawStdout);
  pushSection(sections, 'raw-stderr', result.rawStderr);
  pushSection(sections, 'normalized-final-text', result.normalized.finalText);
  pushSection(
    sections,
    'normalized-reasoning',
    result.normalized.reasoningText,
  );
  if (result.normalized.messages.length > 0) {
    pushSection(
      sections,
      'normalized-messages',
      result.normalized.messages.join('\n---\n'),
    );
  }
  if (result.normalized.toolCalls.length > 0) {
    pushSection(
      sections,
      'normalized-tool-calls',
      result.normalized.toolCalls
        .map((toolCall) => safeStringify(toolCall))
        .join('\n'),
    );
  }
  const providerTranscript = await readTextIfExists(result.transcriptPath);
  pushSection(sections, 'provider-transcript', providerTranscript);
  return sections.join('\n\n');
}

async function persistRunnerArtifacts(
  outputDir: string,
  transcript: string,
  rawStdout: string,
  rawStderr: string,
): Promise<{ transcriptPath: string; stdoutPath: string; stderrPath: string }> {
  const transcriptPath = join(outputDir, 'transcript.txt');
  const stdoutPath = join(outputDir, 'stdout.txt');
  const stderrPath = join(outputDir, 'stderr.txt');

  await Promise.all([
    writeFile(transcriptPath, transcript, 'utf8'),
    writeFile(stdoutPath, rawStdout, 'utf8'),
    writeFile(stderrPath, rawStderr, 'utf8'),
  ]);

  return {
    transcriptPath,
    stdoutPath,
    stderrPath,
  };
}

async function collectFiles(
  targetPath: string,
  paths: Set<string>,
): Promise<void> {
  try {
    const targetStats = await stat(targetPath);
    if (targetStats.isFile()) {
      paths.add(resolve(targetPath));
      return;
    }
    if (!targetStats.isDirectory()) {
      return;
    }
  } catch {
    return;
  }

  const entries = await readdir(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(targetPath, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(entryPath, paths);
      continue;
    }
    if (entry.isFile()) {
      paths.add(resolve(entryPath));
    }
  }
}

async function collectArtifacts(paths: readonly string[]): Promise<string[]> {
  const artifacts = new Set<string>();
  for (const path of paths) {
    await collectFiles(path, artifacts);
  }

  return [...artifacts].sort((left, right) => left.localeCompare(right));
}

function formatCommand(command: string, argv: readonly string[]): string {
  return [command, ...argv].join(' ');
}

async function buildPromptForCondition(
  evalCase: ExecutionEvalCase,
  condition: SkillCondition,
): Promise<string> {
  const sections = [evalCase.prompt, '', EXECUTION_INSTRUCTIONS];

  switch (condition) {
    case 'none': {
      sections.push(
        '',
        'Skill condition: none.',
        'No agent-tty skill text is preloaded for this run. Complete the task using the current repository context and actual CLI behavior.',
      );
      break;
    }
    case 'self-load': {
      const { bootstrapSkillText } = await loadExecutionSkillPrompts();
      sections.push(
        '',
        'Skill condition: self-load.',
        'The following bootstrap skill is available. You can load the full skill by running `agent-tty skills get agent-tty`. Use this guidance to complete the task.',
        '',
        'Bootstrap skill text:',
        bootstrapSkillText.trim(),
      );
      break;
    }
    case 'preloaded': {
      const { canonicalAgentTtySkillText } = await loadExecutionSkillPrompts();
      sections.push(
        '',
        'Skill condition: preloaded.',
        'The following agent-tty skill documentation is preloaded. Follow it to complete the task.',
        '',
        'Canonical core skill text:',
        canonicalAgentTtySkillText.trim(),
      );
      break;
    }
    case 'stale': {
      sections.push(
        '',
        'Skill condition: stale.',
        'The following guidance is intentionally stale or wrong. Verify commands against the current repository behavior while completing the task.',
        '',
        'Stale guidance:',
        STALE_EXECUTION_SKILL_TEXT,
      );
      break;
    }
  }

  if (evalCase.fixture !== undefined) {
    sections.push('', `Fixture: ${evalCase.fixture}`);
  }

  if (evalCase.setup.length > 0) {
    sections.push(
      '',
      'Reference setup command(s):',
      ...evalCase.setup.map(
        (step) =>
          `- ${step.description}: ${formatCommand(step.command, step.argv)}`,
      ),
    );
  }

  const requiredArtifacts = evalCase.artifactRequirements.filter(
    (requirement) => requirement.required,
  );
  if (requiredArtifacts.length > 0) {
    sections.push(
      '',
      'Required artifacts:',
      ...requiredArtifacts.map((requirement) => `- ${requirement.description}`),
    );
  }

  return sections.join('\n');
}

function buildVerifierFailures(
  evalCase: ExecutionEvalCase,
  message: string,
): EvaluatedVerifier[] {
  return evalCase.verifiers.map((spec) => ({
    spec,
    result: {
      pass: false,
      message,
    },
  }));
}

function buildArtifactFailures(
  evalCase: ExecutionEvalCase,
  message: string,
): EvaluatedArtifactRequirement[] {
  return evalCase.artifactRequirements.map((requirement) => ({
    requirement,
    result: {
      pass: false,
      message,
    },
  }));
}

async function evaluateArtifactRequirements(
  requirements: readonly ArtifactRequirement[],
  artifacts: readonly string[],
): Promise<EvaluatedArtifactRequirement[]> {
  const ctx = {
    home: '',
    sessionId: '',
    transcript: '',
    artifacts: [...artifacts],
  };

  return Promise.all(
    requirements.map(async (requirement) => ({
      requirement,
      result: await verifyArtifactExists(
        {
          kind: requirement.kind,
          pathPatterns: requirement.pathPatterns,
          minCount: requirement.minCount ?? 1,
        },
        ctx,
      ),
    })),
  );
}

function summarizeFailureReasons(
  providerOk: boolean,
  verifierResults: readonly EvaluatedVerifier[],
  workflowChecks: readonly WorkflowCheckResult[],
  antiPatternFindings: readonly AntiPatternFinding[],
  artifactResults: readonly EvaluatedArtifactRequirement[],
  providerErrorMessage?: string,
): string {
  const reasons: string[] = [];
  if (!providerOk) {
    reasons.push(
      providerErrorMessage ?? 'Provider invocation reported failure',
    );
  }

  const failedVerifiers = verifierResults
    .filter(({ spec, result }) => spec.required && !result.pass)
    .map(({ spec }) => spec.id);
  if (failedVerifiers.length > 0) {
    reasons.push(`Failed verifiers: ${failedVerifiers.join(', ')}`);
  }

  const failedWorkflowChecks = workflowChecks
    .filter((check) => !check.passed)
    .map((check) => check.checkId);
  if (failedWorkflowChecks.length > 0) {
    reasons.push(
      `(informational) Failed workflow checks: ${failedWorkflowChecks.join(', ')}`,
    );
  }

  const errorFindings = antiPatternFindings.filter(
    (finding) => finding.severity === 'error',
  );
  if (errorFindings.length > 0) {
    reasons.push(
      `Error-level anti-patterns: ${errorFindings.map((finding) => finding.ruleId).join(', ')}`,
    );
  }

  const missingArtifacts = artifactResults
    .filter(({ requirement, result }) => requirement.required && !result.pass)
    .map(({ requirement }) => requirement.kind);
  if (missingArtifacts.length > 0) {
    reasons.push(
      `(informational) Missing required artifacts: ${missingArtifacts.join(', ')}`,
    );
  }

  return reasons.join('; ');
}

function buildScoreBreakdown(
  providerOk: boolean,
  evalCase: ExecutionEvalCase,
  verifierResults: readonly EvaluatedVerifier[],
  workflowChecks: readonly WorkflowCheckResult[],
  antiPatternFindings: readonly AntiPatternFinding[],
  artifactResults: readonly EvaluatedArtifactRequirement[],
  normalizedOutput: NormalizedProviderOutput,
): {
  breakdown: { total: number; maxPossible: number; items: ScoreComponent[] };
  ok: boolean;
} {
  const verifierStatus = countPassedVerifiers(verifierResults);
  const workflowStatus = countPassedWorkflowChecks(workflowChecks, evalCase);
  const artifactStatus = countPassedArtifactRequirements(artifactResults);
  invariant(
    artifactStatus.passed <= artifactStatus.total &&
      artifactStatus.failed.length <= artifactStatus.total,
    'Artifact requirement counts must stay within their evaluated total',
  );
  const errorFindings = antiPatternFindings.filter(
    (finding) => finding.severity === 'error',
  );
  const actualCalls = countAgentTtyCalls(normalizedOutput);
  const referenceSteps = evalCase.referenceSteps;
  const efficiencyScore =
    referenceSteps !== undefined && referenceSteps > 0
      ? Math.max(
          0,
          Math.min(1, referenceSteps / Math.max(referenceSteps, actualCalls)),
        )
      : 0;
  const efficiencyReason =
    referenceSteps !== undefined && referenceSteps > 0
      ? `Used ${String(actualCalls)} agent-tty call(s) vs ${String(referenceSteps)} reference step(s)`
      : 'No reference steps defined for this case';

  const items: ScoreComponent[] = [
    {
      name: 'provider-invocation',
      score: providerOk ? 1 : 0,
      maxScore: 1,
      reason: providerOk
        ? 'Provider agent-mode invocation completed successfully'
        : 'Provider agent-mode invocation failed',
    },
    {
      name: 'verifier-pass-rate',
      score: safeRatio(verifierStatus.passed, verifierStatus.total),
      maxScore: 1,
      reason: `Passed ${String(verifierStatus.passed)} of ${String(verifierStatus.total)} required verifier(s)`,
    },
    {
      name: 'workflow-compliance',
      score: safeRatio(workflowStatus.passed, workflowStatus.total),
      maxScore: 1,
      reason: `(informational) Passed ${String(workflowStatus.passed)} of ${String(workflowStatus.total)} required workflow check(s)`,
    },
    {
      name: 'anti-pattern-avoidance',
      score: antiPatternScore(errorFindings),
      maxScore: 1,
      reason: summarizeAntiPatterns(antiPatternFindings),
    },
    {
      name: 'efficiency',
      score: efficiencyScore,
      maxScore: 1,
      reason: efficiencyReason,
    },
  ];

  const total = items.reduce((sum, item) => sum + item.score, 0);
  const maxPossible = items.reduce((sum, item) => sum + item.maxScore, 0);
  const ok =
    providerOk &&
    verifierStatus.failed.length === 0 &&
    errorFindings.length === 0;

  return {
    breakdown: {
      total,
      maxPossible,
      items,
    },
    ok,
  };
}

function normalizeRequestedConditions(
  conditions: readonly SkillCondition[] | undefined,
): Set<SkillCondition> | undefined {
  if (conditions === undefined || conditions.length === 0) {
    return undefined;
  }

  return new Set(conditions);
}

function resolveTotalTrials(totalTrials: number | undefined): number {
  const resolvedTotalTrials = totalTrials ?? DEFAULT_TOTAL_TRIALS;
  invariant(
    Number.isInteger(resolvedTotalTrials) && resolvedTotalTrials > 0,
    `Execution totalTrials must be a positive integer, got: ${String(totalTrials)}`,
  );
  return resolvedTotalTrials;
}

function buildExecutionWorkItem(
  evalCase: ExecutionEvalCase,
  condition: SkillCondition,
  trial: number,
): ExecutionWorkItem {
  const identity: EvalWorkItemIdentity = {
    lane: 'execution',
    caseId: evalCase.id,
    condition,
    trial,
  };

  return {
    ...identity,
    key: buildWorkItemKey(identity),
    evalCase,
  };
}

function buildRejectedExecutionWorkItemResult(
  provider: EvalProvider,
  metadata: RunMetadata,
  workItem: ExecutionWorkItem,
  runtime: ProviderRuntimeInfo | undefined,
  reason: unknown,
): EvalResult {
  const errorClass =
    reason instanceof Error && reason.name.length > 0
      ? reason.name
      : 'ExecutionWorkItemError';
  const rawErrorMessage =
    reason instanceof Error && reason.message.length > 0
      ? reason.message
      : safeStringify(reason);
  const errorMessage =
    rawErrorMessage.length > 0
      ? rawErrorMessage
      : 'Unknown execution work item failure';
  const timestamp = new Date().toISOString();
  const modelId = resolveModelId(metadata, runtime);

  return EvalResultSchema.parse({
    runId: metadata.runId,
    providerId: provider.id,
    ...(runtime?.version === undefined
      ? {}
      : { providerVersion: runtime.version }),
    ...(modelId === undefined ? {} : { modelId }),
    lane: 'execution',
    caseId: workItem.evalCase.id,
    category: workItem.evalCase.category,
    condition: workItem.condition,
    expectedSkill: workItem.evalCase.expectedSkill,
    trial: workItem.trial,
    ok: false,
    score: {
      total: 0,
      maxPossible: 0,
      items: [],
    },
    workflowChecks: [],
    antiPatternFindings: [],
    normalizedOutput: createFallbackNormalizedOutput(''),
    errorClass,
    errorMessage,
    startedAt: timestamp,
    completedAt: timestamp,
    durationMs: 0,
  }) as EvalResult;
}

function resolveModelId(
  metadata: RunMetadata,
  runtime: ProviderRuntimeInfo | undefined,
): string | undefined {
  if (metadata.models.length === 1) {
    return metadata.models[0];
  }

  return runtime?.defaultModelId;
}

async function createEvalRequest(
  provider: EvalProvider,
  metadata: RunMetadata,
  evalCase: ExecutionEvalCase,
  condition: SkillCondition,
  trial: number,
  homeDir: string,
  outputDir: string,
  runtime: ProviderRuntimeInfo | undefined,
): Promise<Parameters<EvalProvider['invokeAgentMode']>[0]> {
  const prompt = await buildPromptForCondition(evalCase, condition);
  const modelId = resolveModelId(metadata, runtime);

  return {
    runId: metadata.runId,
    providerId: provider.id,
    condition,
    trial,
    cwd: resolve(metadata.repoRoot),
    homeDir,
    outputDir,
    env: {
      AGENT_TTY_HOME: homeDir,
      AGENT_TTY_EVAL_OUTPUT_DIR: outputDir,
    },
    evalCase: {
      ...evalCase,
      prompt,
    },
    ...(modelId === undefined ? {} : { modelId }),
  };
}

function buildResult(
  metadata: RunMetadata,
  provider: EvalProvider,
  evalCase: ExecutionEvalCase,
  condition: SkillCondition,
  trial: number,
  runtime: ProviderRuntimeInfo | undefined,
  transcript: string,
  normalizedOutput: NormalizedProviderOutput,
  providerOk: boolean,
  startedAt: string,
  completedAt: string,
  durationMs: number,
  workflowChecks: WorkflowCheckResult[],
  antiPatternFindings: AntiPatternFinding[],
  verifierResults: readonly EvaluatedVerifier[],
  artifactResults: readonly EvaluatedArtifactRequirement[],
  transcriptPath: string,
  stdoutPath: string,
  stderrPath: string,
  bundlePath: string | undefined,
  eventLogPath: string | undefined,
  errorClass: string | undefined,
  providerErrorMessage: string | undefined,
): EvalResult {
  const scored = buildScoreBreakdown(
    providerOk,
    evalCase,
    verifierResults,
    workflowChecks,
    antiPatternFindings,
    artifactResults,
    normalizedOutput,
  );
  const modelId = resolveModelId(metadata, runtime);
  const summarizedFailure = summarizeFailureReasons(
    providerOk,
    verifierResults,
    workflowChecks,
    antiPatternFindings,
    artifactResults,
    providerErrorMessage,
  );
  const environmentBlockedMessage = detectRendererEnvironmentBlock(
    evalCase,
    transcript,
    providerErrorMessage,
  );
  const effectiveErrorClass =
    environmentBlockedMessage === undefined
      ? errorClass
      : ENVIRONMENT_BLOCKED_ERROR_CLASS;
  const failureMessage = scored.ok
    ? undefined
    : environmentBlockedMessage === undefined
      ? summarizedFailure
      : [environmentBlockedMessage, summarizedFailure]
          .filter((value) => value.length > 0)
          .join(' ');

  const result: EvalResult = {
    runId: metadata.runId,
    providerId: provider.id,
    ...(runtime?.version === undefined
      ? {}
      : { providerVersion: runtime.version }),
    ...(modelId === undefined ? {} : { modelId }),
    lane: 'execution',
    caseId: evalCase.id,
    category: evalCase.category,
    condition,
    expectedSkill: evalCase.expectedSkill,
    trial,
    ok: scored.ok,
    score: scored.breakdown,
    workflowChecks,
    antiPatternFindings,
    transcriptPath,
    stdoutPath,
    stderrPath,
    ...(bundlePath === undefined ? {} : { bundlePath }),
    ...(eventLogPath === undefined ? {} : { eventLogPath }),
    normalizedOutput,
    ...(scored.ok || effectiveErrorClass === undefined
      ? {}
      : { errorClass: effectiveErrorClass }),
    ...(failureMessage === undefined ? {} : { errorMessage: failureMessage }),
    startedAt,
    completedAt,
    durationMs,
  };

  EvalResultSchema.parse(result);
  return result;
}

async function detectRuntime(
  provider: EvalProvider,
): Promise<ProviderRuntimeInfo | undefined> {
  try {
    return await provider.detect();
  } catch {
    return undefined;
  }
}

async function runSingleExecutionCase(
  provider: EvalProvider,
  metadata: RunMetadata,
  evalCase: ExecutionEvalCase,
  condition: SkillCondition,
  trial: number,
  runtime: ProviderRuntimeInfo | undefined,
): Promise<EvalResult> {
  const homeDir = await createIsolatedEvalHome();
  const outputDir = await mkdtemp(join(tmpdir(), RUNNER_OUTPUT_PREFIX));

  try {
    const request = await createEvalRequest(
      provider,
      metadata,
      evalCase,
      condition,
      trial,
      homeDir,
      outputDir,
      runtime,
    );
    const invocationStartedAt = new Date().toISOString();
    const invocationStartedMs = Date.now();

    if (runtime !== undefined && !runtime.available) {
      const transcript = `Provider ${provider.id} is unavailable.`;
      const normalizedOutput = createFallbackNormalizedOutput(transcript);
      const scannableTranscript = buildScannableTranscript(normalizedOutput);
      const persisted = await persistRunnerArtifacts(
        outputDir,
        transcript,
        '',
        '',
      );
      return buildResult(
        metadata,
        provider,
        evalCase,
        condition,
        trial,
        runtime,
        transcript,
        normalizedOutput,
        false,
        invocationStartedAt,
        invocationStartedAt,
        0,
        checkWorkflow(transcript, evalCase.workflowChecks),
        detectAntiPatterns(scannableTranscript, evalCase.antiPatterns),
        buildVerifierFailures(
          evalCase,
          'Provider is unavailable; verifier did not run.',
        ),
        buildArtifactFailures(
          evalCase,
          'Provider is unavailable; artifact verification did not run.',
        ),
        persisted.transcriptPath,
        persisted.stdoutPath,
        persisted.stderrPath,
        undefined,
        undefined,
        'provider-unavailable',
        'Provider detect() reported unavailable.',
      );
    }

    try {
      const providerResult = await provider.invokeAgentMode(request);
      const transcript = await buildTranscript(providerResult);
      const persisted = await persistRunnerArtifacts(
        outputDir,
        transcript,
        providerResult.rawStdout,
        providerResult.rawStderr,
      );
      const artifacts = await collectArtifacts([
        outputDir,
        ...(providerResult.bundlePath === undefined
          ? []
          : [providerResult.bundlePath]),
        ...(providerResult.transcriptPath === undefined
          ? []
          : [providerResult.transcriptPath]),
        ...(providerResult.eventLogPath === undefined
          ? []
          : [providerResult.eventLogPath]),
      ]);
      const verifierContext = {
        home: homeDir,
        sessionId: providerResult.sessionId ?? '',
        transcript,
        artifacts,
      };
      const verifierResults = await Promise.all(
        evalCase.verifiers.map(async (spec) => ({
          spec,
          result: await verify(spec, verifierContext),
        })),
      );
      const artifactResults = await evaluateArtifactRequirements(
        evalCase.artifactRequirements,
        artifacts,
      );
      const scannableTranscript = buildScannableTranscript(
        providerResult.normalized,
      );
      return buildResult(
        metadata,
        provider,
        evalCase,
        condition,
        trial,
        providerResult.runtime,
        transcript,
        providerResult.normalized,
        providerResult.ok,
        providerResult.startedAt,
        providerResult.completedAt,
        providerResult.durationMs,
        checkWorkflow(transcript, evalCase.workflowChecks),
        detectAntiPatterns(scannableTranscript, evalCase.antiPatterns),
        verifierResults,
        artifactResults,
        providerResult.transcriptPath ?? persisted.transcriptPath,
        persisted.stdoutPath,
        persisted.stderrPath,
        providerResult.bundlePath,
        providerResult.eventLogPath,
        providerResult.errorClass,
        providerResult.errorMessage,
      );
    } catch (error) {
      const completedAt = new Date().toISOString();
      const durationMs = Math.max(0, Date.now() - invocationStartedMs);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const transcript =
        error instanceof Error && error.stack !== undefined
          ? `${error.name}: ${errorMessage}\n${error.stack}`
          : errorMessage;
      const normalizedOutput = createFallbackNormalizedOutput(transcript);
      const scannableTranscript = buildScannableTranscript(normalizedOutput);
      const persisted = await persistRunnerArtifacts(
        outputDir,
        transcript,
        '',
        errorMessage,
      );
      return buildResult(
        metadata,
        provider,
        evalCase,
        condition,
        trial,
        runtime,
        transcript,
        normalizedOutput,
        false,
        invocationStartedAt,
        completedAt,
        durationMs,
        checkWorkflow(transcript, evalCase.workflowChecks),
        detectAntiPatterns(scannableTranscript, evalCase.antiPatterns),
        buildVerifierFailures(
          evalCase,
          'Provider invocation failed before verifier execution.',
        ),
        buildArtifactFailures(
          evalCase,
          'Provider invocation failed before artifact verification.',
        ),
        persisted.transcriptPath,
        persisted.stdoutPath,
        persisted.stderrPath,
        undefined,
        undefined,
        error instanceof Error ? error.name : 'ProviderInvocationError',
        errorMessage,
      );
    }
  } finally {
    try {
      await cleanupEvalHome(homeDir);
    } catch {
      // Best-effort cleanup; preserve the eval result when temp-home cleanup fails.
    }
    try {
      await rm(outputDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; preserve the eval result when temp-dir cleanup fails.
    }
  }
}
/** Return all registered execution-lane cases in deterministic order. */
export function getAllExecutionCases(): ExecutionEvalCase[] {
  assertExecutionCaseInventory(EXECUTION_CASES);
  return [...EXECUTION_CASES];
}

export function enumerateExecutionWorkItems(options?: {
  conditions?: SkillCondition[];
  caseFilter?: string[];
  totalTrials?: number;
}): ExecutionWorkItem[] {
  const requestedConditions = normalizeRequestedConditions(options?.conditions);
  const totalTrials = resolveTotalTrials(options?.totalTrials);
  const requestedCaseIds =
    options?.caseFilter === undefined || options.caseFilter.length === 0
      ? undefined
      : new Set(options.caseFilter);
  const availableCases = getAllExecutionCases();

  if (requestedCaseIds !== undefined) {
    const availableCaseIds = new Set(
      availableCases.map((evalCase) => evalCase.id),
    );
    for (const caseId of requestedCaseIds) {
      invariant(
        availableCaseIds.has(caseId),
        `Unknown execution case id: ${caseId}`,
      );
    }
  }

  const items = availableCases.flatMap((evalCase) => {
    if (requestedCaseIds !== undefined && !requestedCaseIds.has(evalCase.id)) {
      return [];
    }

    return evalCase.conditions.flatMap((condition) => {
      if (
        requestedConditions !== undefined &&
        !requestedConditions.has(condition)
      ) {
        return [];
      }

      const conditionItems: ExecutionWorkItem[] = [];
      for (let trialIndex = 0; trialIndex < totalTrials; trialIndex += 1) {
        const trial = trialIndex + 1;
        conditionItems.push(buildExecutionWorkItem(evalCase, condition, trial));
      }
      return conditionItems;
    });
  });

  assertUniqueWorkItems(items);
  return items;
}

export async function executeExecutionWorkItem(
  provider: EvalProvider,
  metadata: RunMetadata,
  workItem: ExecutionWorkItem,
  runtime: ProviderRuntimeInfo | undefined,
): Promise<EvalResult> {
  invariant(
    Number.isInteger(workItem.trial) && workItem.trial > 0,
    'Execution work item trial must be a positive integer',
  );
  return runSingleExecutionCase(
    provider,
    metadata,
    workItem.evalCase,
    workItem.condition,
    workItem.trial,
    runtime,
  );
}

/**
 * Run the execution eval lane for one provider across the selected case and
 * condition matrix.
 */
export async function runExecutionLane(
  provider: EvalProvider,
  metadata: RunMetadata,
  options: ExecutionLaneOptions = {},
): Promise<EvalResult[]> {
  const totalTrials = resolveTotalTrials(metadata.totalTrials);
  const items = enumerateExecutionWorkItems({
    ...(options.conditions === undefined
      ? {}
      : { conditions: options.conditions }),
    ...(options.caseFilter === undefined
      ? {}
      : { caseFilter: options.caseFilter }),
    totalTrials,
  });
  const plannedCases = computePlannedCases(items);
  const reporter = options.reporter;
  const concurrency = options.concurrency ?? 1;
  const activeReporter =
    reporter !== undefined && items.length > 0 ? reporter : undefined;
  if (activeReporter !== undefined) {
    invariant(
      Number.isInteger(concurrency) && concurrency > 0,
      'options.concurrency must be a positive integer',
    );
  }

  let trackerTimestamp: string | undefined;
  const tracker = new CaseProgressTracker<ExecutionWorkItem, EvalResult>({
    runId: metadata.runId,
    lane: 'execution',
    plannedCases,
    ...(reporter === undefined ? {} : { dispatcher: reporter }),
    now: () => trackerTimestamp ?? new Date().toISOString(),
  });
  const trialStarts = new Map<
    string,
    { startedAt: string; startedAtMs: number }
  >();
  const getTimestamp = (): { iso: string; ms: number } => {
    const iso = new Date().toISOString();
    return { iso, ms: Date.parse(iso) };
  };
  const runtime = await detectRuntime(provider);

  const laneStartedAt =
    activeReporter === undefined ? undefined : getTimestamp();
  if (activeReporter !== undefined && laneStartedAt !== undefined) {
    await activeReporter.dispatch('laneStart', {
      runId: metadata.runId,
      lane: 'execution',
      caseIds: Array.from(new Set(items.map((item) => item.caseId))),
      conditions: Array.from(new Set(items.map((item) => item.condition))),
      concurrency,
      plannedItems: items.length,
      startedAt: laneStartedAt.iso,
    });
  }

  const settlements = await runScheduled<ExecutionWorkItem, EvalResult>(
    items,
    (item) => executeExecutionWorkItem(provider, metadata, item, runtime),
    {
      concurrency,
      ...(activeReporter === undefined
        ? {}
        : {
            onItemStart: async (item: ExecutionWorkItem) => {
              const started = getTimestamp();
              trialStarts.set(item.key, {
                startedAt: started.iso,
                startedAtMs: started.ms,
              });

              trackerTimestamp = started.iso;
              try {
                await tracker.onTrialStart(item);
              } finally {
                trackerTimestamp = undefined;
              }

              await activeReporter.dispatch('trialStart', {
                runId: metadata.runId,
                lane: 'execution',
                caseId: item.caseId,
                condition: item.condition,
                trial: item.trial,
                startedAt: started.iso,
                requestedOutputPath: null,
                requestedArtifactPath: null,
              });
            },
            onItemFinish: async (item: ExecutionWorkItem, settled) => {
              const started = trialStarts.get(item.key);
              invariant(
                started !== undefined,
                `Missing reporter start state for ${item.key}`,
              );
              const completed = getTimestamp();

              if (settled.status === 'fulfilled') {
                await activeReporter.dispatch('trialFinish', {
                  runId: metadata.runId,
                  lane: 'execution',
                  caseId: item.caseId,
                  condition: item.condition,
                  trial: item.trial,
                  startedAt: started.startedAt,
                  completedAt: completed.iso,
                  durationMs: Math.max(0, completed.ms - started.startedAtMs),
                  status: settled.value.ok ? 'passed' : 'failed',
                  ok: settled.value.ok,
                  errorClass: settled.value.errorClass ?? null,
                  errorMessage: settled.value.errorMessage ?? null,
                  score: settled.value.score.total,
                  transcriptPath: settled.value.transcriptPath ?? null,
                  stdoutPath: settled.value.stdoutPath ?? null,
                  stderrPath: settled.value.stderrPath ?? null,
                  eventLogPath: settled.value.eventLogPath ?? null,
                  bundlePath: settled.value.bundlePath ?? null,
                  artifactManifestPath:
                    settled.value.artifactManifestPath ?? null,
                });
              } else {
                await activeReporter.dispatch('trialFinish', {
                  runId: metadata.runId,
                  lane: 'execution',
                  caseId: item.caseId,
                  condition: item.condition,
                  trial: item.trial,
                  startedAt: started.startedAt,
                  completedAt: completed.iso,
                  durationMs: Math.max(0, completed.ms - started.startedAtMs),
                  status: 'errored',
                  ok: false,
                  errorClass:
                    settled.reason instanceof Error
                      ? settled.reason.name
                      : 'Error',
                  errorMessage:
                    settled.reason instanceof Error
                      ? settled.reason.message
                      : String(settled.reason),
                  score: null,
                  transcriptPath: null,
                  stdoutPath: null,
                  stderrPath: null,
                  eventLogPath: null,
                  bundlePath: null,
                  artifactManifestPath: null,
                });
              }

              trackerTimestamp = completed.iso;
              try {
                await tracker.onTrialFinish(item, settled);
              } finally {
                trackerTimestamp = undefined;
                trialStarts.delete(item.key);
              }
            },
          }),
    },
  );

  if (activeReporter !== undefined && laneStartedAt !== undefined) {
    const completed = getTimestamp();
    const laneTotals = settlements.reduce(
      (totals, settlement) => {
        totals.total += 1;
        if (settlement.status === 'rejected') {
          totals.errored += 1;
        } else if (settlement.value.ok) {
          totals.passed += 1;
        } else {
          totals.failed += 1;
        }
        return totals;
      },
      { total: 0, passed: 0, failed: 0, errored: 0 },
    );

    await activeReporter.dispatch('laneFinish', {
      runId: metadata.runId,
      lane: 'execution',
      startedAt: laneStartedAt.iso,
      completedAt: completed.iso,
      durationMs: Math.max(0, completed.ms - laneStartedAt.ms),
      total: laneTotals.total,
      passed: laneTotals.passed,
      failed: laneTotals.failed,
      errored: laneTotals.errored,
    });
  }

  return settlements.map((settlement) =>
    settlement.status === 'fulfilled'
      ? settlement.value
      : buildRejectedExecutionWorkItemResult(
          provider,
          metadata,
          settlement.item,
          runtime,
          settlement.reason,
        ),
  );
}
