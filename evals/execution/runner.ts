import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { assertString, invariant } from '../../src/util/assert.js';
import { detectAntiPatterns } from '../lib/antiPatterns.js';
import { createIsolatedEvalHome } from '../lib/cliHarness.js';
import { EvalResultSchema } from '../lib/schemas.js';
import { checkWorkflow } from '../lib/scoring.js';
import type {
  AntiPatternFinding,
  ArtifactRequirement,
  EvalResult,
  ExecutionEvalCase,
  NormalizedProviderOutput,
  ProviderRuntimeInfo,
  RunMetadata,
  ScoreComponent,
  SkillCondition,
  VerifierSpec,
  WorkflowCheckResult,
} from '../lib/types.js';
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
const DEFAULT_TRIAL = 1;

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
  let penalty = 0;
  for (const finding of findings) {
    switch (finding.severity) {
      case 'error':
        penalty += 1;
        break;
      case 'warning':
        penalty += 0.5;
        break;
      case 'info':
        penalty += 0.25;
        break;
      default:
        break;
    }
  }

  return Math.max(0, 1 - Math.min(1, penalty));
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
    reasons.push(`Failed workflow checks: ${failedWorkflowChecks.join(', ')}`);
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
    reasons.push(`Missing required artifacts: ${missingArtifacts.join(', ')}`);
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
): {
  breakdown: { total: number; maxPossible: number; items: ScoreComponent[] };
  ok: boolean;
} {
  const verifierStatus = countPassedVerifiers(verifierResults);
  const workflowStatus = countPassedWorkflowChecks(workflowChecks, evalCase);
  const artifactStatus = countPassedArtifactRequirements(artifactResults);
  const errorFindings = antiPatternFindings.filter(
    (finding) => finding.severity === 'error',
  );

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
      reason: `Passed ${String(workflowStatus.passed)} of ${String(workflowStatus.total)} required workflow check(s)`,
    },
    {
      name: 'anti-pattern-avoidance',
      score: antiPatternScore(antiPatternFindings),
      maxScore: 1,
      reason: summarizeAntiPatterns(antiPatternFindings),
    },
  ];

  if (artifactStatus.total > 0) {
    items.push({
      name: 'artifact-requirements',
      score: safeRatio(artifactStatus.passed, artifactStatus.total),
      maxScore: 1,
      reason: `Satisfied ${String(artifactStatus.passed)} of ${String(artifactStatus.total)} required artifact expectation(s)`,
    });
  }

  const total = items.reduce((sum, item) => sum + item.score, 0);
  const maxPossible = items.reduce((sum, item) => sum + item.maxScore, 0);
  const ok =
    providerOk &&
    verifierStatus.failed.length === 0 &&
    workflowStatus.failed.length === 0 &&
    errorFindings.length === 0 &&
    artifactStatus.failed.length === 0;

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
    trial: DEFAULT_TRIAL,
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
  runtime: ProviderRuntimeInfo | undefined,
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
  );
  const modelId = resolveModelId(metadata, runtime);
  const failureMessage = scored.ok
    ? undefined
    : summarizeFailureReasons(
        providerOk,
        verifierResults,
        workflowChecks,
        antiPatternFindings,
        artifactResults,
        providerErrorMessage,
      );

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
    trial: DEFAULT_TRIAL,
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
    ...(scored.ok || errorClass === undefined ? {} : { errorClass }),
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
  runtime: ProviderRuntimeInfo | undefined,
): Promise<EvalResult> {
  const homeDir = await createIsolatedEvalHome();
  const outputDir = await mkdtemp(join(tmpdir(), RUNNER_OUTPUT_PREFIX));
  const request = await createEvalRequest(
    provider,
    metadata,
    evalCase,
    condition,
    homeDir,
    outputDir,
    runtime,
  );
  const invocationStartedAt = new Date().toISOString();
  const invocationStartedMs = Date.now();

  if (runtime !== undefined && !runtime.available) {
    const transcript = `Provider ${provider.id} is unavailable.`;
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
      runtime,
      createFallbackNormalizedOutput(transcript),
      false,
      invocationStartedAt,
      invocationStartedAt,
      0,
      checkWorkflow(transcript, evalCase.workflowChecks),
      detectAntiPatterns(transcript, evalCase.antiPatterns),
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
    return buildResult(
      metadata,
      provider,
      evalCase,
      condition,
      providerResult.runtime,
      providerResult.normalized,
      providerResult.ok,
      providerResult.startedAt,
      providerResult.completedAt,
      providerResult.durationMs,
      checkWorkflow(transcript, evalCase.workflowChecks),
      detectAntiPatterns(transcript, evalCase.antiPatterns),
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
    const errorMessage = error instanceof Error ? error.message : String(error);
    const transcript =
      error instanceof Error && error.stack !== undefined
        ? `${error.name}: ${errorMessage}\n${error.stack}`
        : errorMessage;
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
      runtime,
      createFallbackNormalizedOutput(transcript),
      false,
      invocationStartedAt,
      completedAt,
      durationMs,
      checkWorkflow(transcript, evalCase.workflowChecks),
      detectAntiPatterns(transcript, evalCase.antiPatterns),
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
}

/** Return all registered execution-lane cases in deterministic order. */
export function getAllExecutionCases(): ExecutionEvalCase[] {
  assertExecutionCaseInventory(EXECUTION_CASES);
  return [...EXECUTION_CASES];
}

/**
 * Run the execution eval lane for one provider across the selected case and
 * condition matrix.
 */
export async function runExecutionLane(
  provider: EvalProvider,
  metadata: RunMetadata,
  options: { conditions?: SkillCondition[]; caseFilter?: string[] } = {},
): Promise<EvalResult[]> {
  const requestedConditions = normalizeRequestedConditions(options.conditions);
  const requestedCaseIds =
    options.caseFilter === undefined || options.caseFilter.length === 0
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

  const selectedCases = availableCases.filter(
    (evalCase) =>
      requestedCaseIds === undefined || requestedCaseIds.has(evalCase.id),
  );
  const runtime = await detectRuntime(provider);
  const results: EvalResult[] = [];

  for (const evalCase of selectedCases) {
    const selectedConditions = evalCase.conditions.filter(
      (condition) =>
        requestedConditions === undefined || requestedConditions.has(condition),
    );
    for (const condition of selectedConditions) {
      results.push(
        await runSingleExecutionCase(
          provider,
          metadata,
          evalCase,
          condition,
          runtime,
        ),
      );
    }
  }

  return results;
}
