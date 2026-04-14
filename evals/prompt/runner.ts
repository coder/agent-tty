import { readFile } from 'node:fs/promises';

import { assertString, invariant } from '../../src/util/assert.js';
import { detectAntiPatterns } from '../lib/antiPatterns.js';
import { SKILL_CONDITIONS } from '../lib/matrix.js';
import {
  EvalResultSchema,
  PromptEvalCaseSchema,
  ProviderPromptRequestSchema,
  RunMetadataSchema,
} from '../lib/schemas.js';
import { scorePromptCase } from '../lib/scoring.js';
import type {
  AntiPatternFinding,
  EvalResult,
  PromptCaseScore,
  PromptEvalCase,
  ProviderPromptRequest,
  ProviderPromptResult,
  RunMetadata,
  SkillCondition,
} from '../lib/types.js';
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

function sanitizePatternMatch(
  match: PromptCaseScore['patternMatches'][number],
): PromptCaseScore['patternMatches'][number] {
  return {
    pattern: match.pattern,
    matched: match.matched,
    matchedTexts: [...match.matchedTexts],
    lineNumbers: [...match.lineNumbers],
    matchCount: match.matchCount,
  };
}

function sanitizeForbiddenPatternMatch(
  match: PromptCaseScore['forbiddenPatternMatches'][number],
): PromptCaseScore['forbiddenPatternMatches'][number] {
  return {
    pattern: match.pattern,
    violated: match.violated,
    matchedTexts: [...match.matchedTexts],
    lineNumbers: [...match.lineNumbers],
    matchCount: match.matchCount,
  };
}

function sanitizePromptCaseScore(
  promptScore: PromptCaseScore,
): PromptCaseScore {
  return {
    expectedSkillCorrect: promptScore.expectedSkillCorrect,
    patternMatches: promptScore.patternMatches.map(sanitizePatternMatch),
    forbiddenPatternMatches: promptScore.forbiddenPatternMatches.map(
      sanitizeForbiddenPatternMatch,
    ),
    workflowChecks: promptScore.workflowChecks.map((check) => ({
      checkId: check.checkId,
      passed: check.passed,
      ...(check.message === undefined ? {} : { message: check.message }),
      matches: check.matches.map(sanitizePatternMatch),
      forbiddenMatches: check.forbiddenMatches.map(
        sanitizeForbiddenPatternMatch,
      ),
    })),
    antiPatternFindings: promptScore.antiPatternFindings.map((finding) => ({
      ...finding,
    })),
    breakdown: {
      total: promptScore.breakdown.total,
      maxPossible: promptScore.breakdown.maxPossible,
      items: promptScore.breakdown.items.map((item) => ({
        name: item.name,
        score: item.score,
        maxScore: item.maxScore,
        ...(item.reason === undefined ? {} : { reason: item.reason }),
      })),
    },
    passed: promptScore.passed,
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
  const promptScore = sanitizePromptCaseScore(
    scorePromptCase(responseText, request.evalCase),
  );
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
  const promptScore: PromptCaseScore = sanitizePromptCaseScore(
    scorePromptCase('', request.evalCase),
  );
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

export async function runPromptLane(
  provider: EvalProvider,
  metadata: RunMetadata,
  options?: { conditions?: SkillCondition[]; caseFilter?: string[] },
): Promise<EvalResult[]> {
  const parsedMetadata = RunMetadataSchema.parse(metadata) as RunMetadata;
  invariant(
    parsedMetadata.lanes.includes('prompt'),
    'Run metadata must include the prompt lane',
  );
  invariant(
    parsedMetadata.providers.includes(provider.id),
    `Run metadata providers must include ${provider.id}`,
  );
  invariant(
    parsedMetadata.totalTrials > 0,
    'Run metadata totalTrials must be positive for prompt-lane runs',
  );

  const allCases = getAllPromptCases();
  const requestedCases = resolveRequestedCases(allCases, options?.caseFilter);
  const requestedConditions = resolveRequestedConditions(
    parsedMetadata,
    options?.conditions,
  );
  const loadedSkillPrompts = await loadSkillPrompts();
  const results: EvalResult[] = [];

  for (const evalCase of requestedCases) {
    for (const condition of requestedConditions) {
      const systemPrompt = buildConditionSystemPrompt(
        condition,
        loadedSkillPrompts,
      );

      for (
        let trialIndex = 0;
        trialIndex < parsedMetadata.totalTrials;
        trialIndex += 1
      ) {
        const trial = trialIndex + 1;
        const request = buildPromptRequest(
          provider,
          parsedMetadata,
          evalCase,
          condition,
          trial,
          systemPrompt,
        );
        const startedAt = new Date().toISOString();
        const startedAtMs = Date.now();

        try {
          const promptResult = (await provider.invokePlanMode(
            request,
          )) as ProviderPromptResult;
          results.push(buildEvalResult(request, promptResult));
        } catch (error: unknown) {
          const completedAt = new Date().toISOString();
          const durationMs = Math.max(0, Date.now() - startedAtMs);
          results.push(
            buildErrorEvalResult(
              request,
              error,
              startedAt,
              completedAt,
              durationMs,
            ),
          );
        }
      }
    }
  }

  return results;
}
