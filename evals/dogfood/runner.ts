import { mkdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { scanBundleArtifacts } from '../../src/tools/review-bundle.js';
import { invariant } from '../../src/util/assert.js';
import { detectAntiPatterns } from '../lib/antiPatterns.js';
import {
  scoreBundleCompleteness,
  scoreEvidenceQuality,
  scoreReportCompleteness,
} from '../lib/bundleScoring.js';
import { SKILL_CONDITIONS } from '../lib/matrix.js';
import { DogfoodEvalCaseSchema, EvalResultSchema } from '../lib/schemas.js';
import { checkWorkflow } from '../lib/scoring.js';
import type {
  DogfoodEvalCase,
  EvalResult,
  NormalizedProviderOutput,
  ProviderRuntimeInfo,
  RunMetadata,
  SkillCondition,
} from '../lib/types.js';
import type { EvalProvider } from '../providers/base.js';
import evidenceCompletenessCase from './cases/evidence-completeness.js';
import exploratoryQaCase from './cases/exploratory-qa.js';
import navigationFocusReproCase from './cases/navigation-focus-repro.js';
import releaseReadinessCase from './cases/release-readiness.js';
import renderingBugReproCase from './cases/rendering-bug-repro.js';
import resizeRegressionCase from './cases/resize-regression.js';
import {
  scoreDogfoodRun,
  scoreReportRequirements,
} from './scorers/index.js';

function coerceDogfoodCase(evalCase: unknown): DogfoodEvalCase {
  return DogfoodEvalCaseSchema.parse(evalCase) as DogfoodEvalCase;
}

const DOGFOOD_CASES: readonly DogfoodEvalCase[] = [
  coerceDogfoodCase(exploratoryQaCase),
  coerceDogfoodCase(releaseReadinessCase),
  coerceDogfoodCase(renderingBugReproCase),
  coerceDogfoodCase(navigationFocusReproCase),
  coerceDogfoodCase(resizeRegressionCase),
  coerceDogfoodCase(evidenceCompletenessCase),
] as const;

const EMPTY_NORMALIZED_OUTPUT: NormalizedProviderOutput = {
  finalText: '',
  messages: [],
  referencedSkills: [],
  toolCalls: [],
};

const NO_CAPABILITIES: ProviderRuntimeInfo['capabilities'] = {
  supportsDetect: false,
  supportsPlanMode: false,
  supportsAgentMode: false,
  supportsStreaming: false,
  supportsToolCalls: false,
  supportsTranscriptCapture: false,
};

const SKILL_TEXT_CACHE = new Map<string, Promise<string>>();

function clampUnitInterval(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function buildFallbackRuntime(
  providerId: string,
  note: string,
): ProviderRuntimeInfo {
  return {
    providerId,
    available: false,
    detectedAt: new Date().toISOString(),
    capabilities: NO_CAPABILITIES,
    notes: [note],
  };
}

function buildDogfoodBreakdownItems(score: {
  bundleCompleteness: number;
  reportCompleteness: number;
  evidenceQuality: number;
  taxonomyUsage: number;
  reproducibility: number;
}): EvalResult['score']['items'] {
  return [
    {
      name: 'bundle-completeness',
      score: clampUnitInterval(score.bundleCompleteness) * 0.2,
      maxScore: 0.2,
      reason: 'Bundle validation and required artifact coverage.',
    },
    {
      name: 'report-completeness',
      score: clampUnitInterval(score.reportCompleteness) * 0.2,
      maxScore: 0.2,
      reason: 'Report structure and case-specific reporting requirements.',
    },
    {
      name: 'evidence-quality',
      score: clampUnitInterval(score.evidenceQuality) * 0.2,
      maxScore: 0.2,
      reason: 'Evidence modality coverage, diversity, and manifest sanity.',
    },
    {
      name: 'taxonomy-usage',
      score: clampUnitInterval(score.taxonomyUsage) * 0.2,
      maxScore: 0.2,
      reason: 'Use of the dogfood-tui issue taxonomy in the report.',
    },
    {
      name: 'reproducibility',
      score: clampUnitInterval(score.reproducibility) * 0.2,
      maxScore: 0.2,
      reason: 'Presence of reproducible, command-backed steps and outcomes.',
    },
  ];
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readOptionalTextFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

async function readSkillText(relativePath: string): Promise<string> {
  const url = new URL(relativePath, import.meta.url);
  const cacheKey = url.href;
  const cached = SKILL_TEXT_CACHE.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const readPromise = readFile(url, 'utf8');
  SKILL_TEXT_CACHE.set(cacheKey, readPromise);
  return readPromise;
}

function formatArtifactRequirement(evalCase: DogfoodEvalCase): string[] {
  return evalCase.artifactRequirements.map((requirement) => {
    const prefix = requirement.required ? 'required' : 'optional';
    const count = requirement.minCount === undefined ? '' : ` (min ${String(requirement.minCount)})`;
    return `- ${requirement.kind} [${prefix}]${count}: ${requirement.description}`;
  });
}

function formatReportRequirement(evalCase: DogfoodEvalCase): string[] {
  return evalCase.reportRequirements.map((requirement) => {
    const section = requirement.section ?? requirement.id;
    return `- ${section}: ${requirement.description}`;
  });
}

function buildSystemPromptContext(
  condition: SkillCondition,
  bootstrapSkill: string,
  dogfoodSkill: string,
  staleSkill: string,
): { summary: string; systemPrompt: string; env: Record<string, string> } {
  switch (condition) {
    case 'none': {
      const systemPrompt =
        'No specialized skill text is preloaded for this dogfood eval run.';
      return {
        summary:
          'No skill text is preloaded. The agent must solve the task without dogfood-specific guidance.',
        systemPrompt,
        env: {
          EVAL_SKILL_CONDITION: condition,
          EVAL_SYSTEM_PROMPT: systemPrompt,
        },
      };
    }
    case 'self-load': {
      const systemPrompt = [
        'Only the bootstrap agent-tty skill is preloaded for this run.',
        'Use it to decide whether to self-load the specialized dogfood-tui skill.',
        '--- BEGIN BOOTSTRAP SKILL: agent-tty ---',
        bootstrapSkill.trim(),
        '--- END BOOTSTRAP SKILL ---',
      ].join('\n\n');
      return {
        summary:
          'Bootstrap-only context is preloaded. The agent should decide whether to self-load dogfood-tui.',
        systemPrompt,
        env: {
          EVAL_SKILL_CONDITION: condition,
          EVAL_PRELOADED_SKILL_NAME: 'agent-tty-bootstrap',
          EVAL_SYSTEM_PROMPT: systemPrompt,
        },
      };
    }
    case 'preloaded': {
      const systemPrompt = [
        'The canonical dogfood-tui skill is preloaded for this run.',
        'Follow it as the system prompt context for the task below.',
        '--- BEGIN PRELOADED SKILL: dogfood-tui ---',
        dogfoodSkill.trim(),
        '--- END PRELOADED SKILL ---',
      ].join('\n\n');
      return {
        summary:
          'The canonical dogfood-tui skill is preloaded and should guide the workflow.',
        systemPrompt,
        env: {
          EVAL_SKILL_CONDITION: condition,
          EVAL_PRELOADED_SKILL_NAME: 'dogfood-tui',
          EVAL_SYSTEM_PROMPT: systemPrompt,
        },
      };
    }
    case 'stale': {
      const systemPrompt = [
        'A stale or mismatched skill is preloaded for this run.',
        'It is intentionally limited to generalized terminal automation guidance and omits the specialized dogfood evidence workflow.',
        '--- BEGIN STALE OR WRONG SKILL CONTEXT ---',
        staleSkill.trim(),
        '--- END STALE OR WRONG SKILL CONTEXT ---',
      ].join('\n\n');
      return {
        summary:
          'Mismatched generalized agent-tty guidance is preloaded instead of dogfood-tui.',
        systemPrompt,
        env: {
          EVAL_SKILL_CONDITION: condition,
          EVAL_PRELOADED_SKILL_NAME: 'agent-tty-stale',
          EVAL_SYSTEM_PROMPT: systemPrompt,
        },
      };
    }
  }
}

function buildPrompt(
  evalCase: DogfoodEvalCase,
  requestedBundlePath: string,
  systemPromptContext: { summary: string; systemPrompt: string },
): string {
  return [
    `Skill condition: ${evalCase.conditions.join(', ')}.`,
    `Fixture: ${evalCase.fixture ?? evalCase.target ?? 'unknown'}.`,
    `Requested proof bundle directory: ${requestedBundlePath}.`,
    `Bundle validation profile: ${evalCase.validationProfile}.`,
    '',
    'System prompt context summary:',
    systemPromptContext.summary,
    '',
    'Simulated system prompt context:',
    systemPromptContext.systemPrompt,
    '',
    'Bundle requirements:',
    ...evalCase.bundleRequirements.map((requirement) => `- ${requirement}`),
    '',
    'Required report sections:',
    ...formatReportRequirement(evalCase),
    '',
    'Artifact requirements:',
    ...formatArtifactRequirement(evalCase),
    '',
    'Task:',
    evalCase.prompt,
  ].join('\n');
}

async function resolveReportText(
  bundlePath: string | undefined,
  fallbackText: string,
): Promise<string | undefined> {
  if (bundlePath !== undefined) {
    try {
      const artifacts = await scanBundleArtifacts(bundlePath);
      const noteArtifacts = artifacts.filter((artifact) => artifact.kind === 'notes');
      if (noteArtifacts.length > 0) {
        const noteContents = await Promise.all(
          noteArtifacts.map(async (artifact) => {
            const contents = await readOptionalTextFile(
              join(bundlePath, artifact.relativePath),
            );
            return contents?.trim();
          }),
        );
        const nonEmptyNotes = noteContents.filter(
          (contents): contents is string =>
            typeof contents === 'string' && contents.length > 0,
        );
        if (nonEmptyNotes.length > 0) {
          return nonEmptyNotes.join('\n\n---\n\n');
        }
      }
    } catch {
      // Ignore bundle-scanning failures and fall back to agent output.
    }
  }

  return fallbackText.trim().length > 0 ? fallbackText : undefined;
}

async function resolveTranscriptText(result: {
  transcriptPath?: string;
  rawStdout: string;
  rawStderr: string;
  normalized: NormalizedProviderOutput;
}): Promise<string> {
  if (result.transcriptPath !== undefined) {
    const transcript = await readOptionalTextFile(result.transcriptPath);
    if (transcript !== undefined) {
      return transcript;
    }
  }

  return [
    result.rawStdout,
    result.rawStderr,
    ...result.normalized.messages,
  ]
    .filter((chunk) => chunk.trim().length > 0)
    .join('\n\n');
}

async function resolveBundlePath(
  reportedBundlePath: string | undefined,
  requestedBundlePath: string,
): Promise<string | undefined> {
  if (reportedBundlePath !== undefined) {
    const resolvedReportedBundlePath = resolve(reportedBundlePath);
    if (await pathExists(resolvedReportedBundlePath)) {
      return resolvedReportedBundlePath;
    }
  }

  const resolvedRequestedBundlePath = resolve(requestedBundlePath);
  return (await pathExists(resolvedRequestedBundlePath))
    ? resolvedRequestedBundlePath
    : undefined;
}

async function resolveArtifactManifestPath(
  bundlePath: string | undefined,
): Promise<string | undefined> {
  if (bundlePath === undefined) {
    return undefined;
  }

  const manifestPath = join(bundlePath, 'manifest.json');
  return (await pathExists(manifestPath)) ? manifestPath : undefined;
}

function validateConditionList(
  conditions: readonly SkillCondition[] | undefined,
): SkillCondition[] | undefined {
  if (conditions === undefined) {
    return undefined;
  }

  const seen = new Set<SkillCondition>();
  for (const condition of conditions) {
    invariant(
      SKILL_CONDITIONS.includes(condition),
      `Unsupported dogfood skill condition: ${condition}`,
    );
    invariant(!seen.has(condition), `Duplicate dogfood skill condition: ${condition}`);
    seen.add(condition);
  }

  return [...conditions];
}

function validateCaseFilter(caseFilter: readonly string[] | undefined): string[] | undefined {
  if (caseFilter === undefined) {
    return undefined;
  }

  const availableCaseIds = new Set(DOGFOOD_CASES.map((evalCase) => evalCase.id));
  const seen = new Set<string>();
  for (const caseId of caseFilter) {
    invariant(caseId.trim().length > 0, 'caseFilter entries must not be empty');
    invariant(availableCaseIds.has(caseId), `Unknown dogfood case id: ${caseId}`);
    invariant(!seen.has(caseId), `Duplicate dogfood case id: ${caseId}`);
    seen.add(caseId);
  }

  return [...caseFilter];
}

function buildRequestedPaths(
  metadata: RunMetadata,
  providerId: string,
  evalCase: DogfoodEvalCase,
  condition: SkillCondition,
): { outputDir: string; homeDir: string; requestedBundlePath: string } {
  const outputDir = resolve(
    tmpdir(),
    'agent-tty-evals',
    metadata.runId,
    providerId,
    evalCase.id,
    condition,
  );
  const homeDir = join(outputDir, 'agent-tty-home');
  const requestedBundlePath = join(outputDir, evalCase.bundlePath);

  return {
    outputDir,
    homeDir,
    requestedBundlePath,
  };
}

function buildCaseInventory(): DogfoodEvalCase[] {
  const cases = [...DOGFOOD_CASES];
  const categoryCounts = new Map<DogfoodEvalCase['category'], number>();
  for (const evalCase of cases) {
    categoryCounts.set(
      evalCase.category,
      (categoryCounts.get(evalCase.category) ?? 0) + 1,
    );
  }

  invariant(cases.length === 6, 'Dogfood lane must define exactly 6 cases');
  invariant(categoryCounts.get('qa') === 1, 'Dogfood lane must define exactly 1 QA case');
  invariant(
    categoryCounts.get('release-readiness') === 1,
    'Dogfood lane must define exactly 1 release-readiness case',
  );
  invariant(
    categoryCounts.get('bug-repro') === 3,
    'Dogfood lane must define exactly 3 bug-repro cases',
  );
  invariant(
    categoryCounts.get('reporting') === 1,
    'Dogfood lane must define exactly 1 reporting case',
  );

  return cases;
}

export function getAllDogfoodCases(): DogfoodEvalCase[] {
  return buildCaseInventory();
}

export async function runDogfoodLane(
  provider: EvalProvider,
  metadata: RunMetadata,
  options?: { conditions?: SkillCondition[]; caseFilter?: string[] },
): Promise<EvalResult[]> {
  const selectedConditions = validateConditionList(options?.conditions);
  const selectedCaseIds = validateCaseFilter(options?.caseFilter);
  const allCases = getAllDogfoodCases();
  const cases =
    selectedCaseIds === undefined
      ? allCases
      : allCases.filter((evalCase) => selectedCaseIds.includes(evalCase.id));
  const bootstrapSkill = await readSkillText('../../skills/agent-tty/SKILL.md');
  const dogfoodSkill = await readSkillText('../../skill-data/dogfood-tui/SKILL.md');
  const staleSkill = await readSkillText('../../skill-data/agent-tty/SKILL.md');

  let detectedRuntime: ProviderRuntimeInfo;
  try {
    detectedRuntime = await provider.detect();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    detectedRuntime = buildFallbackRuntime(
      provider.id,
      `provider.detect() failed before dogfood lane execution: ${message}`,
    );
  }

  const requestedModelId =
    metadata.models[0] ?? detectedRuntime.defaultModelId ?? undefined;
  const repoRoot = resolve(metadata.repoRoot);
  const results: EvalResult[] = [];

  for (const evalCase of cases) {
    const caseConditions =
      selectedConditions === undefined
        ? evalCase.conditions
        : evalCase.conditions.filter((condition) =>
            selectedConditions.includes(condition),
          );

    for (const condition of caseConditions) {
      const startedAt = new Date().toISOString();
      const { outputDir, homeDir, requestedBundlePath } = buildRequestedPaths(
        metadata,
        provider.id,
        evalCase,
        condition,
      );
      await mkdir(outputDir, { recursive: true });
      await mkdir(homeDir, { recursive: true });

      const systemPromptContext = buildSystemPromptContext(
        condition,
        bootstrapSkill,
        dogfoodSkill,
        staleSkill,
      );
      const requestCase = DogfoodEvalCaseSchema.parse({
        ...evalCase,
        prompt: buildPrompt(
          { ...evalCase, conditions: [condition] },
          requestedBundlePath,
          systemPromptContext,
        ),
        bundlePath: requestedBundlePath,
        conditions: [condition],
      }) as DogfoodEvalCase;

      try {
        const agentResult = await provider.invokeAgentMode({
          runId: metadata.runId,
          providerId: provider.id,
          condition,
          trial: 1,
          ...(requestedModelId === undefined ? {} : { modelId: requestedModelId }),
          cwd: repoRoot,
          homeDir,
          outputDir,
          env: {
            AGENT_TTY_HOME: homeDir,
            EVAL_OUTPUT_DIR: outputDir,
            EVAL_REQUESTED_BUNDLE_DIR: requestedBundlePath,
            EVAL_FIXTURE: evalCase.fixture ?? '',
            ...systemPromptContext.env,
          },
          evalCase: requestCase,
        });

        const transcript = await resolveTranscriptText(agentResult);
        const bundlePath = await resolveBundlePath(
          agentResult.bundlePath,
          requestedBundlePath,
        );
        const reportText = await resolveReportText(
          bundlePath,
          agentResult.normalized.finalText,
        );
        const dogfoodScore = await scoreDogfoodRun(
          bundlePath ?? requestedBundlePath,
          reportText,
          transcript,
          evalCase,
        );
        const reportRequirementScore = scoreReportRequirements(
          reportText ?? '',
          evalCase.reportRequirements,
        );
        const reportSections = evalCase.reportRequirements
          .map((requirement) => requirement.section)
          .filter(
            (section): section is string =>
              typeof section === 'string' && section.trim().length > 0,
          );
        const baseReportCompleteness = scoreReportCompleteness(
          reportText ?? '',
          reportSections,
        );
        const reportCompleteness = {
          ...baseReportCompleteness,
          sectionsExpected: reportRequirementScore.details.length,
          sectionsFound: reportRequirementScore.details.filter((detail) => detail.found)
            .length,
          score: clampUnitInterval(
            (baseReportCompleteness.score + reportRequirementScore.score) / 2,
          ),
          details: reportRequirementScore.details.map((detail) => ({
            section: detail.section,
            found: detail.found,
            required:
              evalCase.reportRequirements.find(
                (requirement) =>
                  (requirement.section ?? requirement.id) === detail.section,
              )?.required ?? true,
          })),
          missingSections: reportRequirementScore.details
            .filter((detail) => !detail.found)
            .map((detail) => detail.section),
        };
        const bundleCompleteness = await scoreBundleCompleteness(
          bundlePath ?? requestedBundlePath,
          evalCase.validationProfile,
        );
        const evidenceQuality = await scoreEvidenceQuality(
          bundlePath ?? requestedBundlePath,
        );
        const workflowChecks =
          requestCase.workflowChecks.length === 0
            ? []
            : checkWorkflow(transcript, requestCase.workflowChecks);
        const antiPatternFindings = detectAntiPatterns(
          transcript,
          requestCase.antiPatterns,
        );
        const artifactManifestPath = await resolveArtifactManifestPath(bundlePath);
        const blockingAntiPattern = antiPatternFindings.some(
          (finding) => finding.severity === 'error',
        );
        const missingRequiredReportSection = reportRequirementScore.details.some(
          (detail) => !detail.found,
        );
        const missingRequiredWorkflow = workflowChecks.some(
          (check) => !check.passed,
        );
        const ok =
          agentResult.ok &&
          !blockingAntiPattern &&
          !missingRequiredReportSection &&
          !missingRequiredWorkflow &&
          dogfoodScore.overallScore >= 0.6;
        const completedAt = agentResult.completedAt;
        const result: EvalResult = EvalResultSchema.parse({
          runId: metadata.runId,
          providerId: provider.id,
          ...(agentResult.runtime.version === undefined
            ? {}
            : { providerVersion: agentResult.runtime.version }),
          ...(requestedModelId === undefined ? {} : { modelId: requestedModelId }),
          lane: 'dogfood',
          caseId: evalCase.id,
          category: evalCase.category,
          condition,
          expectedSkill: evalCase.expectedSkill,
          trial: 1,
          ok,
          score: {
            total: dogfoodScore.overallScore,
            maxPossible: 1,
            items: buildDogfoodBreakdownItems(dogfoodScore),
          },
          workflowChecks,
          antiPatternFindings,
          bundleCompleteness,
          reportCompleteness,
          evidenceQuality,
          ...(agentResult.transcriptPath === undefined
            ? {}
            : { transcriptPath: agentResult.transcriptPath }),
          ...(bundlePath === undefined ? {} : { bundlePath }),
          ...(artifactManifestPath === undefined ? {} : { artifactManifestPath }),
          ...(agentResult.eventLogPath === undefined
            ? {}
            : { eventLogPath: agentResult.eventLogPath }),
          normalizedOutput: agentResult.normalized,
          ...(agentResult.errorClass === undefined
            ? {}
            : { errorClass: agentResult.errorClass }),
          ...(agentResult.errorMessage === undefined
            ? {}
            : { errorMessage: agentResult.errorMessage }),
          startedAt: agentResult.startedAt,
          completedAt,
          durationMs: agentResult.durationMs,
        }) as EvalResult;

        results.push(result);
      } catch (error) {
        const completedAt = new Date().toISOString();
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorClass =
          error instanceof Error && error.name.length > 0 ? error.name : 'Error';
        const result: EvalResult = EvalResultSchema.parse({
          runId: metadata.runId,
          providerId: provider.id,
          ...(detectedRuntime.version === undefined
            ? {}
            : { providerVersion: detectedRuntime.version }),
          ...(requestedModelId === undefined ? {} : { modelId: requestedModelId }),
          lane: 'dogfood',
          caseId: evalCase.id,
          category: evalCase.category,
          condition,
          expectedSkill: evalCase.expectedSkill,
          trial: 1,
          ok: false,
          score: {
            total: 0,
            maxPossible: 1,
            items: buildDogfoodBreakdownItems({
              bundleCompleteness: 0,
              reportCompleteness: 0,
              evidenceQuality: 0,
              taxonomyUsage: 0,
              reproducibility: 0,
            }),
          },
          workflowChecks: [],
          antiPatternFindings: [],
          normalizedOutput: EMPTY_NORMALIZED_OUTPUT,
          errorClass,
          errorMessage,
          startedAt,
          completedAt,
          durationMs: Math.max(
            0,
            Date.parse(completedAt) - Date.parse(startedAt),
          ),
        }) as EvalResult;

        results.push(result);
      }
    }
  }

  return results;
}
