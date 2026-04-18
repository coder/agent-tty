import { readFile } from 'node:fs/promises';

import { assertString, invariant } from '../../src/util/assert.js';
import { EvalArtifactStore, writeTokenUsageArtifact } from '../lib/artifacts.js';
import { detectAntiPatterns } from '../lib/antiPatterns.js';
import { SKILL_CONDITIONS } from '../lib/matrix.js';
import { runScheduled } from '../lib/scheduler.js';
import {
  EvalResultSchema,
  PromptEvalCaseSchema,
  ProviderPromptRequestSchema,
  RunMetadataSchema,
} from '../lib/schemas.js';
import { scorePromptCase } from '../lib/scoring.js';
import type { ScheduledWorkItem, SettledResult } from '../lib/scheduler.js';
import { assertUniqueWorkItems, buildWorkItemKey } from '../lib/types.js';
import type {
  AntiPatternFinding,
  EvalResult,
  EvalWorkItemIdentity,
  PromptCaseScore,
  PromptEvalCase,
  ProviderPromptRequest,
  ProviderPromptResult,
  RunMetadata,
  SkillCondition,
} from '../lib/types.js';
import type { ReporterDispatcher } from '../reporters/dispatch.js';
import {
  CaseProgressTracker,
  computePlannedCases,
} from '../reporters/runtime.js';
import type { EvalProvider } from '../providers/base.js';
import { ANTI_PATTERN_PROMPT_CASES } from './cases/anti-patterns.js';
import { SHOULD_NOT_TRIGGER_PROMPT_CASES } from './cases/should-not-trigger.js';
import { TRIGGER_AGENT_TTY_PROMPT_CASES } from './cases/trigger-agent-tty.js';
import { TRIGGER_DOGFOOD_TUI_PROMPT_CASES } from './cases/trigger-dogfood-tui.js';

const EXPECTED_PROMPT_CASE_COUNT = 24;
const NONE_CONDITION_SYSTEM_PROMPT = [
  'You are answering a plan-mode routing evaluation for a coding agent.',
  'Choose the most appropriate workflow for the user request and explain it concisely.',
  'Avoid brittle waiting, ad hoc screenshot tooling, or unrelated setup when simpler reasoning or editing is enough.',
].join('\n');
const STALE_CONDITION_SYSTEM_PROMPT = [
  'Legacy preloaded guidance snapshot (known to be stale):',
  '- Prefer tmux or screen for long-lived terminal sessions.',
  '- Use sleep 5 or setTimeout(...) before checking readiness.',
  '- Capture screenshots with scrot, import, or xdotool.',
  '- QA runs can skip structured evidence collection and cleanup.',
  '',
  'Respond to the task using the available guidance.',
].join('\n');

interface LoadedSkillPrompts {
  selfLoad: string;
  preloaded: string;
}

let loadedSkillPromptsPromise: Promise<LoadedSkillPrompts> | undefined;

type PromptWorkItemOptions = {
  conditions?: SkillCondition[];
  caseFilter?: string[];
};

type PromptLaneOptions = PromptWorkItemOptions & {
  concurrency?: number;
  reporter?: ReporterDispatcher;
};

type PromptWorkItem = EvalWorkItemIdentity &
  ScheduledWorkItem & {
    evalCase: PromptEvalCase;
    systemPrompt: string;
  };

type RejectedPromptWorkItemSettlement = Extract<
  SettledResult<PromptWorkItem, EvalResult>,
  { status: 'rejected' }
>;

function clonePromptCase(evalCase: PromptEvalCase): PromptEvalCase {
  return PromptEvalCaseSchema.parse({
    ...evalCase,
    expectedPatterns: [...evalCase.expectedPatterns],
    forbiddenPatterns: [...evalCase.forbiddenPatterns],
    rubric: [...evalCase.rubric],
    workflowChecks: evalCase.workflowChecks.map((check) => ({
      ...check,
      requiredPatterns: [...check.requiredPatterns],
      forbiddenPatterns: [...check.forbiddenPatterns],
      dependsOn: [...check.dependsOn],
    })),
    antiPatterns: evalCase.antiPatterns.map((rule) => ({
      ...rule,
      patterns: [...rule.patterns],
      ...(rule.lanes === undefined ? {} : { lanes: [...rule.lanes] }),
    })),
    budgets: { ...evalCase.budgets },
  }) as PromptEvalCase;
}

function resolveRequestedConditions(
  metadata: RunMetadata,
  requestedConditions: SkillCondition[] | undefined,
): SkillCondition[] {
  const sourceConditions = requestedConditions ?? metadata.conditions;
  const resolvedConditions =
    sourceConditions.length > 0 ? sourceConditions : [...SKILL_CONDITIONS];

  invariant(
    resolvedConditions.length > 0,
    'Prompt lane must run with at least one skill condition',
  );

  const metadataConditions = new Set(metadata.conditions);
  const seenConditions = new Set<SkillCondition>();
  for (const condition of resolvedConditions) {
    invariant(
      SKILL_CONDITIONS.includes(condition),
      `Unsupported skill condition: ${condition}`,
    );
    invariant(
      !seenConditions.has(condition),
      `Duplicate skill condition requested: ${condition}`,
    );
    seenConditions.add(condition);
    if (metadata.conditions.length > 0) {
      invariant(
        metadataConditions.has(condition),
        `Requested condition ${condition} must be declared in run metadata`,
      );
    }
  }

  return [...resolvedConditions];
}

function resolveRequestedCases(
  allCases: PromptEvalCase[],
  caseFilter: string[] | undefined,
): PromptEvalCase[] {
  if (caseFilter === undefined) {
    return allCases.map(clonePromptCase);
  }

  const caseMap = new Map(allCases.map((evalCase) => [evalCase.id, evalCase]));
  const seenIds = new Set<string>();
  return caseFilter.map((caseId) => {
    assertString(caseId, 'caseFilter entries must be strings');
    invariant(caseId.length > 0, 'caseFilter entries must not be empty');
    invariant(!seenIds.has(caseId), `Duplicate case filter id: ${caseId}`);
    seenIds.add(caseId);

    const evalCase = caseMap.get(caseId);
    invariant(evalCase !== undefined, `Unknown prompt eval case id: ${caseId}`);
    return clonePromptCase(evalCase);
  });
}

function validatePromptRunMetadata(metadata: RunMetadata): RunMetadata {
  const parsedMetadata = RunMetadataSchema.parse(metadata) as RunMetadata;
  invariant(
    parsedMetadata.lanes.includes('prompt'),
    'Run metadata must include the prompt lane',
  );
  invariant(
    parsedMetadata.totalTrials > 0,
    'Run metadata totalTrials must be positive for prompt-lane runs',
  );
  return parsedMetadata;
}

function assertPromptProviderMetadata(
  provider: EvalProvider,
  metadata: RunMetadata,
): void {
  invariant(
    metadata.providers.includes(provider.id),
    `Run metadata providers must include ${provider.id}`,
  );
}

function assertPromptWorkItem(workItem: PromptWorkItem): void {
  invariant(workItem.lane === 'prompt', 'Prompt work item lane must be prompt');
  invariant(
    workItem.caseId === workItem.evalCase.id,
    `Prompt work item case id must match eval case id for ${workItem.key}`,
  );
  invariant(
    workItem.systemPrompt.length > 0,
    `Prompt work item system prompt must not be empty for ${workItem.key}`,
  );
  invariant(
    workItem.key === buildWorkItemKey(workItem),
    `Prompt work item key must match identity for ${workItem.caseId}`,
  );
}

function buildFallbackNormalizedOutput(
  errorMessage?: string,
): EvalResult['normalizedOutput'] {
  return {
    finalText: '',
    messages: errorMessage === undefined ? [] : [errorMessage],
    referencedSkills: [],
    toolCalls: [],
  };
}

function buildConditionSystemPrompt(
  condition: SkillCondition,
  loadedSkillPrompts: LoadedSkillPrompts,
): string {
  switch (condition) {
    case 'none':
      return NONE_CONDITION_SYSTEM_PROMPT;
    case 'self-load':
      return loadedSkillPrompts.selfLoad;
    case 'preloaded':
      return loadedSkillPrompts.preloaded;
    case 'stale':
      return STALE_CONDITION_SYSTEM_PROMPT;
    default:
      return condition satisfies never;
  }
}

function buildPromptRequest(
  provider: EvalProvider,
  metadata: RunMetadata,
  evalCase: PromptEvalCase,
  condition: SkillCondition,
  trial: number,
  systemPrompt: string,
): ProviderPromptRequest {
  const contextualizedCase = PromptEvalCaseSchema.parse({
    ...clonePromptCase(evalCase),
    context:
      evalCase.context === undefined
        ? systemPrompt
        : `${systemPrompt}\n\nTask-specific context:\n${evalCase.context}`,
  }) as PromptEvalCase;

  return ProviderPromptRequestSchema.parse({
    runId: metadata.runId,
    providerId: provider.id,
    condition,
    trial,
    modelId: metadata.models[0],
    cwd: metadata.repoRoot,
    evalCase: contextualizedCase,
  }) as ProviderPromptRequest;
}

function mergeAntiPatternFindings(
  findings: readonly AntiPatternFinding[],
): AntiPatternFinding[] {
  const deduped = new Map<string, AntiPatternFinding>();
  for (const finding of findings) {
    const key = [
      finding.ruleId,
      finding.severity,
      finding.lineNumber ?? '',
      finding.matchedText ?? '',
      finding.message,
    ].join('::');
    if (!deduped.has(key)) {
      deduped.set(key, finding);
    }
  }

  return [...deduped.values()].sort((left, right) => {
    const leftLine = left.lineNumber ?? Number.MAX_SAFE_INTEGER;
    const rightLine = right.lineNumber ?? Number.MAX_SAFE_INTEGER;
    if (leftLine !== rightLine) {
      return leftLine - rightLine;
    }
    return left.ruleId.localeCompare(right.ruleId);
  });
}

function hasBlockingAntiPattern(
  findings: readonly AntiPatternFinding[],
): boolean {
  return findings.some((finding) => finding.severity === 'error');
}

function extractResponseText(result: ProviderPromptResult): string {
  const normalizedFinalText = result.normalized.finalText;
  if (normalizedFinalText.length > 0) {
    return normalizedFinalText;
  }

  if (result.rawStdout.length > 0) {
    return result.rawStdout;
  }

  return result.rawStderr;
}

function buildEvalResult(
  request: ProviderPromptRequest,
  promptResult: ProviderPromptResult,
): EvalResult {
  const responseText = extractResponseText(promptResult);
  const promptScore = scorePromptCase(responseText, request.evalCase);
  const antiPatternFindings = mergeAntiPatternFindings(
    detectAntiPatterns(responseText),
  );
  const blockingAntiPatternDetected =
    hasBlockingAntiPattern(antiPatternFindings);

  return EvalResultSchema.parse({
    runId: request.runId,
    providerId: request.providerId,
    providerVersion: promptResult.runtime.version,
    modelId:
      promptResult.request.modelId ?? promptResult.runtime.defaultModelId,
    lane: 'prompt',
    caseId: request.evalCase.id,
    category: request.evalCase.category,
    condition: request.condition,
    expectedSkill: request.evalCase.expectedSkill,
    trial: request.trial,
    ok: promptResult.ok && promptScore.passed && !blockingAntiPatternDetected,
    score: promptScore.breakdown,
    promptScore,
    workflowChecks: promptScore.workflowChecks,
    antiPatternFindings,
    normalizedOutput: promptResult.normalized,
    errorClass: promptResult.errorClass,
    errorMessage: promptResult.errorMessage,
    startedAt: promptResult.startedAt,
    completedAt: promptResult.completedAt,
    durationMs: promptResult.durationMs,
  }) as EvalResult;
}

function buildErrorEvalResult(
  request: ProviderPromptRequest,
  error: unknown,
  startedAt: string,
  completedAt: string,
  durationMs: number,
): EvalResult {
  const message = error instanceof Error ? error.message : String(error);
  const errorClass = error instanceof Error ? error.name : 'Error';
  const promptScore: PromptCaseScore = scorePromptCase('', request.evalCase);
  const antiPatternFindings = mergeAntiPatternFindings(detectAntiPatterns(''));

  return EvalResultSchema.parse({
    runId: request.runId,
    providerId: request.providerId,
    modelId: request.modelId,
    lane: 'prompt',
    caseId: request.evalCase.id,
    category: request.evalCase.category,
    condition: request.condition,
    expectedSkill: request.evalCase.expectedSkill,
    trial: request.trial,
    ok: false,
    score: promptScore.breakdown,
    promptScore,
    workflowChecks: promptScore.workflowChecks,
    antiPatternFindings,
    normalizedOutput: buildFallbackNormalizedOutput(message),
    errorClass,
    errorMessage: message,
    startedAt,
    completedAt,
    durationMs,
  }) as EvalResult;
}

function buildRejectedPromptWorkItemEvalResult(
  provider: EvalProvider,
  metadata: RunMetadata,
  settlement: RejectedPromptWorkItemSettlement,
): EvalResult {
  const errorMessage =
    settlement.reason instanceof Error
      ? settlement.reason.message
      : String(settlement.reason);
  const message = `Unexpected scheduler rejection for ${settlement.item.key}: ${errorMessage}`;
  const errorClass =
    settlement.reason instanceof Error ? settlement.reason.name : 'Error';
  const promptScore: PromptCaseScore = scorePromptCase(
    '',
    settlement.item.evalCase,
  );
  const antiPatternFindings = mergeAntiPatternFindings(detectAntiPatterns(''));
  const startedAt = new Date().toISOString();
  const completedAt = new Date().toISOString();
  const durationMs = Math.max(
    0,
    Date.parse(completedAt) - Date.parse(startedAt),
  );

  return EvalResultSchema.parse({
    runId: metadata.runId,
    providerId: provider.id,
    modelId: metadata.models[0],
    lane: settlement.item.lane,
    caseId: settlement.item.caseId,
    category: settlement.item.evalCase.category,
    condition: settlement.item.condition,
    expectedSkill: settlement.item.evalCase.expectedSkill,
    trial: settlement.item.trial,
    ok: false,
    score: promptScore.breakdown,
    promptScore,
    workflowChecks: promptScore.workflowChecks,
    antiPatternFindings,
    normalizedOutput: buildFallbackNormalizedOutput(message),
    errorClass,
    errorMessage: message,
    startedAt,
    completedAt,
    durationMs,
  }) as EvalResult;
}

async function writePromptTokenUsageArtifacts(
  metadata: RunMetadata,
  results: readonly EvalResult[],
): Promise<void> {
  let artifactsDir: string | undefined;

  for (const result of results) {
    const tokenUsage = result.normalizedOutput.tokenUsage;
    if (tokenUsage === undefined) {
      continue;
    }

    if (artifactsDir === undefined) {
      const outputBaseDir = metadata.outputBaseDir;
      invariant(
        typeof outputBaseDir === 'string' && outputBaseDir.length > 0,
        'Prompt lane token usage artifacts require metadata.outputBaseDir',
      );
      artifactsDir = new EvalArtifactStore(outputBaseDir).runDir(metadata.runId);
    }

    invariant(
      result.providerId.length > 0,
      'Prompt lane token usage artifacts require result.providerId',
    );
    invariant(
      typeof result.modelId === 'string' && result.modelId.length > 0,
      'Prompt lane token usage artifacts require result.modelId',
    );
    invariant(
      result.caseId.length > 0,
      'Prompt lane token usage artifacts require result.caseId',
    );
    invariant(
      result.condition.length > 0,
      'Prompt lane token usage artifacts require result.condition',
    );
    invariant(
      result.lane === 'prompt',
      'Prompt lane token usage artifacts require prompt results',
    );
    invariant(
      Number.isInteger(result.trial) && result.trial > 0,
      'Prompt lane token usage artifacts require positive result.trial',
    );

    const createdAtMs = Date.parse(result.completedAt);
    invariant(
      Number.isInteger(createdAtMs) && createdAtMs >= 0,
      'Prompt lane token usage artifacts require a valid completedAt timestamp',
    );

    await writeTokenUsageArtifact({
      artifactsDir,
      caseId: result.caseId,
      lane: result.lane,
      condition: result.condition,
      provider: result.providerId,
      model: result.modelId,
      trialIndex: result.trial - 1,
      tokenUsage,
      createdAtMs,
    });
  }
}

async function readSkillFile(relativePath: string): Promise<string> {
  const content = await readFile(
    new URL(relativePath, import.meta.url),
    'utf8',
  );
  assertString(content, `Skill file ${relativePath} must be a string`);
  invariant(content.length > 0, `Skill file ${relativePath} must not be empty`);
  return content;
}

async function loadSkillPrompts(): Promise<LoadedSkillPrompts> {
  loadedSkillPromptsPromise ??= (async () => {
    const [
      bootstrapSkillText,
      canonicalAgentTtySkillText,
      canonicalDogfoodSkillText,
    ] = await Promise.all([
      readSkillFile('../../skills/agent-tty/SKILL.md'),
      readSkillFile('../../skill-data/agent-tty/SKILL.md'),
      readSkillFile('../../skill-data/dogfood-tui/SKILL.md'),
    ]);

    return {
      selfLoad: [
        'You are answering a plan-mode routing evaluation in the agent-tty skill ecosystem.',
        'Only the bootstrap skill is available at skills/agent-tty/SKILL.md.',
        'If terminal automation or structured TUI QA is appropriate, name the correct skill explicitly and explain the workflow.',
        '',
        'Bootstrap skill text:',
        bootstrapSkillText,
      ].join('\n'),
      preloaded: [
        'You are answering a plan-mode routing evaluation in the agent-tty skill ecosystem.',
        'The canonical skills are already preloaded.',
        'Name the single best routing choice: none, agent-tty, or dogfood-tui.',
        '',
        'Canonical core skill from skill-data/agent-tty/SKILL.md:',
        canonicalAgentTtySkillText,
        '',
        'Canonical QA skill from skill-data/dogfood-tui/SKILL.md:',
        canonicalDogfoodSkillText,
      ].join('\n'),
    };
  })();

  return loadedSkillPromptsPromise;
}

export function getAllPromptCases(): PromptEvalCase[] {
  const allCases = [
    ...TRIGGER_AGENT_TTY_PROMPT_CASES,
    ...TRIGGER_DOGFOOD_TUI_PROMPT_CASES,
    ...SHOULD_NOT_TRIGGER_PROMPT_CASES,
    ...ANTI_PATTERN_PROMPT_CASES,
  ].map(clonePromptCase);

  invariant(
    allCases.length === EXPECTED_PROMPT_CASE_COUNT,
    `Prompt lane must define exactly ${String(EXPECTED_PROMPT_CASE_COUNT)} cases, found ${String(allCases.length)}`,
  );

  const seenIds = new Set<string>();
  for (const evalCase of allCases) {
    invariant(
      !seenIds.has(evalCase.id),
      `Duplicate prompt eval case id: ${evalCase.id}`,
    );
    seenIds.add(evalCase.id);
  }

  return allCases;
}

async function enumeratePromptWorkItemsFromMetadata(
  metadata: RunMetadata,
  options?: PromptWorkItemOptions,
): Promise<PromptWorkItem[]> {
  const allCases = getAllPromptCases();
  const requestedCases = resolveRequestedCases(allCases, options?.caseFilter);
  const requestedConditions = resolveRequestedConditions(
    metadata,
    options?.conditions,
  );
  const loadedSkillPrompts = await loadSkillPrompts();
  const items: PromptWorkItem[] = [];

  for (const evalCase of requestedCases) {
    for (const condition of requestedConditions) {
      const systemPrompt = buildConditionSystemPrompt(
        condition,
        loadedSkillPrompts,
      );

      for (
        let trialIndex = 0;
        trialIndex < metadata.totalTrials;
        trialIndex += 1
      ) {
        const trial = trialIndex + 1;
        const identity: EvalWorkItemIdentity = {
          lane: 'prompt',
          caseId: evalCase.id,
          condition,
          trial,
        };
        items.push({
          ...identity,
          key: buildWorkItemKey(identity),
          evalCase,
          systemPrompt,
        });
      }
    }
  }

  assertUniqueWorkItems(items);
  return items;
}

export async function enumeratePromptWorkItems(
  metadata: RunMetadata,
  options?: PromptWorkItemOptions,
): Promise<PromptWorkItem[]> {
  const parsedMetadata = validatePromptRunMetadata(metadata);
  return enumeratePromptWorkItemsFromMetadata(parsedMetadata, options);
}

export async function executePromptWorkItem(
  provider: EvalProvider,
  metadata: RunMetadata,
  workItem: PromptWorkItem,
): Promise<EvalResult> {
  assertPromptProviderMetadata(provider, metadata);
  assertPromptWorkItem(workItem);

  const request = buildPromptRequest(
    provider,
    metadata,
    workItem.evalCase,
    workItem.condition,
    workItem.trial,
    workItem.systemPrompt,
  );
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();

  try {
    const promptResult = await provider.invokePlanMode(request);
    return buildEvalResult(request, promptResult);
  } catch (error: unknown) {
    const completedAt = new Date().toISOString();
    const durationMs = Math.max(0, Date.now() - startedAtMs);
    return buildErrorEvalResult(
      request,
      error,
      startedAt,
      completedAt,
      durationMs,
    );
  }
}

export async function runPromptLane(
  provider: EvalProvider,
  metadata: RunMetadata,
  options?: PromptLaneOptions,
): Promise<EvalResult[]> {
  const parsedMetadata = validatePromptRunMetadata(metadata);
  assertPromptProviderMetadata(provider, parsedMetadata);

  const items = await enumeratePromptWorkItemsFromMetadata(
    parsedMetadata,
    options,
  );
  const plannedCases = computePlannedCases(items);
  const reporter = options?.reporter;
  const concurrency = options?.concurrency ?? 1;
  const activeReporter =
    reporter !== undefined && items.length > 0 ? reporter : undefined;
  if (activeReporter !== undefined) {
    invariant(
      Number.isInteger(concurrency) && concurrency > 0,
      'options.concurrency must be a positive integer',
    );
  }

  let trackerTimestamp: string | undefined;
  const tracker = new CaseProgressTracker<PromptWorkItem, EvalResult>({
    runId: parsedMetadata.runId,
    lane: 'prompt',
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

  const laneStartedAt =
    activeReporter === undefined ? undefined : getTimestamp();
  if (activeReporter !== undefined && laneStartedAt !== undefined) {
    await activeReporter.dispatch('laneStart', {
      runId: parsedMetadata.runId,
      lane: 'prompt',
      caseIds: Array.from(new Set(items.map((item) => item.caseId))),
      conditions: Array.from(new Set(items.map((item) => item.condition))),
      concurrency,
      plannedItems: items.length,
      startedAt: laneStartedAt.iso,
    });
  }

  const settlements = await runScheduled<PromptWorkItem, EvalResult>(
    items,
    async (item) => executePromptWorkItem(provider, parsedMetadata, item),
    {
      concurrency,
      ...(activeReporter === undefined
        ? {}
        : {
            onItemStart: async (item: PromptWorkItem) => {
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
                runId: parsedMetadata.runId,
                lane: 'prompt',
                caseId: item.caseId,
                condition: item.condition,
                trial: item.trial,
                startedAt: started.iso,
                requestedOutputPath: null,
                requestedArtifactPath: null,
              });
            },
            onItemFinish: async (item: PromptWorkItem, settled) => {
              const started = trialStarts.get(item.key);
              invariant(
                started !== undefined,
                `Missing reporter start state for ${item.key}`,
              );
              const completed = getTimestamp();

              if (settled.status === 'fulfilled') {
                await activeReporter.dispatch('trialFinish', {
                  runId: parsedMetadata.runId,
                  lane: 'prompt',
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
                  runId: parsedMetadata.runId,
                  lane: 'prompt',
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

  const results = settlements.map((settlement) =>
    settlement.status === 'fulfilled'
      ? settlement.value
      : buildRejectedPromptWorkItemEvalResult(
          provider,
          parsedMetadata,
          settlement,
        ),
  );

  await writePromptTokenUsageArtifacts(parsedMetadata, results);

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
      runId: parsedMetadata.runId,
      lane: 'prompt',
      startedAt: laneStartedAt.iso,
      completedAt: completed.iso,
      durationMs: Math.max(0, completed.ms - laneStartedAt.ms),
      total: laneTotals.total,
      passed: laneTotals.passed,
      failed: laneTotals.failed,
      errored: laneTotals.errored,
    });
  }

  return results;
}
