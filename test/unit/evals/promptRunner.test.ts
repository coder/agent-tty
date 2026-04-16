import { describe, expect, it } from 'vitest';

import { SKILL_CONDITIONS } from '../../../evals/lib/matrix.js';
import {
  enumeratePromptWorkItems,
  executePromptWorkItem,
} from '../../../evals/prompt/runner.js';
import type {
  NormalizedProviderOutput,
  ProviderPromptRequest,
  ProviderPromptResult,
  ProviderRuntimeInfo,
  RunMetadata,
  SkillCondition,
} from '../../../evals/lib/types.js';
import type { EvalProvider } from '../../../evals/providers/base.js';

const ALL_CONDITIONS: SkillCondition[] = [...SKILL_CONDITIONS];
const PROMPT_CASE_FILTER = ['session-creation', 'pure-reasoning'];
const PROMPT_TEST_CASE_ID = 'session-creation';
const PROMPT_RUNTIME: ProviderRuntimeInfo = {
  providerId: 'stub',
  available: true,
  detectedAt: '2026-01-01T00:00:00.000Z',
  version: 'test-provider',
  defaultModelId: 'test-model',
  capabilities: {
    supportsDetect: true,
    supportsPlanMode: true,
    supportsAgentMode: false,
    supportsStreaming: false,
    supportsToolCalls: false,
    supportsTranscriptCapture: false,
  },
  notes: ['unit test runtime'],
};

function createRunMetadata(overrides: Partial<RunMetadata> = {}): RunMetadata {
  return {
    runId: 'test-run',
    createdAt: '2026-01-01T00:00:00.000Z',
    repoRoot: '/tmp/test-repo',
    providers:
      overrides.providers === undefined ? ['stub'] : [...overrides.providers],
    models: overrides.models === undefined ? [] : [...overrides.models],
    lanes: overrides.lanes === undefined ? ['prompt'] : [...overrides.lanes],
    conditions:
      overrides.conditions === undefined
        ? [...ALL_CONDITIONS]
        : [...overrides.conditions],
    totalTrials: overrides.totalTrials ?? 2,
    notes: overrides.notes === undefined ? [] : [...overrides.notes],
    ...(overrides.runId === undefined ? {} : { runId: overrides.runId }),
    ...(overrides.createdAt === undefined
      ? {}
      : { createdAt: overrides.createdAt }),
    ...(overrides.repoRoot === undefined ? {} : { repoRoot: overrides.repoRoot }),
  };
}

function createNormalizedOutput(finalText: string): NormalizedProviderOutput {
  return {
    finalText,
    messages: finalText.length === 0 ? [] : [finalText],
    referencedSkills: [],
    toolCalls: [],
  };
}

function createPromptResult(
  request: ProviderPromptRequest,
  finalText: string,
): ProviderPromptResult {
  return {
    request,
    runtime: PROMPT_RUNTIME,
    ok: true,
    exitCode: 0,
    signal: null,
    startedAt: '2026-01-01T00:00:01.000Z',
    completedAt: '2026-01-01T00:00:02.000Z',
    durationMs: 1000,
    rawStdout: finalText,
    rawStderr: '',
    normalized: createNormalizedOutput(finalText),
  };
}

describe('enumeratePromptWorkItems', () => {
  it('returns unique prompt work items with stable keys', async () => {
    const metadata = createRunMetadata();
    const items = await enumeratePromptWorkItems(metadata);
    const seenKeys = new Set<string>();

    expect(items.length).toBeGreaterThan(0);

    for (const item of items) {
      expect(item.lane).toBe('prompt');
      expect(item.caseId.length).toBeGreaterThan(0);
      expect(SKILL_CONDITIONS).toContain(item.condition);
      expect(Number.isInteger(item.trial)).toBe(true);
      expect(item.trial).toBeGreaterThanOrEqual(1);
      expect(item.key.length).toBeGreaterThan(0);
      expect(item.key).toBe(
        `prompt:${item.caseId}:${item.condition}:${String(item.trial)}`,
      );
      expect(seenKeys.has(item.key)).toBe(false);
      seenKeys.add(item.key);
    }

    expect(seenKeys.size).toBe(items.length);
  });

  it('filters prompt work items by case id', async () => {
    const metadata = createRunMetadata({ totalTrials: 1 });
    const items = await enumeratePromptWorkItems(metadata, {
      caseFilter: PROMPT_CASE_FILTER,
    });

    expect(items.length).toBeGreaterThan(0);
    expect([...new Set(items.map((item) => item.caseId))]).toEqual(
      PROMPT_CASE_FILTER,
    );
    for (const item of items) {
      expect(PROMPT_CASE_FILTER.includes(item.caseId)).toBe(true);
    }
  });

  it('filters prompt work items by condition', async () => {
    const requestedConditions: SkillCondition[] = ['none', 'stale'];
    const items = await enumeratePromptWorkItems(createRunMetadata({ totalTrials: 1 }), {
      caseFilter: [PROMPT_TEST_CASE_ID],
      conditions: requestedConditions,
    });

    expect(items).toHaveLength(requestedConditions.length);
    expect(items.map((item) => item.condition)).toEqual(requestedConditions);
    for (const item of items) {
      expect(requestedConditions).toContain(item.condition);
    }
  });
});

describe('executePromptWorkItem', () => {
  it('builds a prompt request and returns the provider result payload', async () => {
    const metadata = createRunMetadata({ conditions: ['none'], totalTrials: 1 });
    const [workItem] = await enumeratePromptWorkItems(metadata, {
      caseFilter: [PROMPT_TEST_CASE_ID],
      conditions: ['none'],
    });
    const responseText = 'Use agent-tty create, wait, and snapshot to validate the task.';
    let receivedRequest: ProviderPromptRequest | undefined;

    expect(workItem).toBeDefined();
    if (workItem === undefined) {
      throw new Error('Expected a prompt work item');
    }

    const provider = {
      id: 'stub',
      detect: async () => PROMPT_RUNTIME,
      invokePlanMode: async (request: ProviderPromptRequest) => {
        receivedRequest = request;
        return createPromptResult(request, responseText);
      },
      invokeAgentMode: async () => {
        throw new Error('invokeAgentMode should not be called in prompt tests');
      },
      parse: (raw: string) => createNormalizedOutput(raw),
    } satisfies EvalProvider;

    const result = await executePromptWorkItem(provider, metadata, workItem);

    expect(receivedRequest).toBeDefined();
    expect(receivedRequest).toMatchObject({
      runId: metadata.runId,
      providerId: provider.id,
      condition: workItem.condition,
      trial: workItem.trial,
      evalCase: {
        id: workItem.caseId,
      },
    });
    expect(receivedRequest?.evalCase.context).toContain(workItem.systemPrompt);
    expect(result).toMatchObject({
      runId: metadata.runId,
      providerId: provider.id,
      lane: 'prompt',
      caseId: workItem.caseId,
      condition: workItem.condition,
      trial: workItem.trial,
      startedAt: '2026-01-01T00:00:01.000Z',
      completedAt: '2026-01-01T00:00:02.000Z',
      durationMs: 1000,
    });
    expect(result.normalizedOutput.finalText).toBe(responseText);
    expect(result.errorClass).toBeUndefined();
    expect(result.errorMessage).toBeUndefined();
  });

  it('converts provider errors into failed eval results', async () => {
    const metadata = createRunMetadata({ conditions: ['none'], totalTrials: 1 });
    const [workItem] = await enumeratePromptWorkItems(metadata, {
      caseFilter: [PROMPT_TEST_CASE_ID],
      conditions: ['none'],
    });

    expect(workItem).toBeDefined();
    if (workItem === undefined) {
      throw new Error('Expected a prompt work item');
    }

    const provider = {
      id: 'stub',
      detect: async () => PROMPT_RUNTIME,
      invokePlanMode: async () => {
        throw new Error('prompt boom');
      },
      invokeAgentMode: async () => {
        throw new Error('invokeAgentMode should not be called in prompt tests');
      },
      parse: (raw: string) => createNormalizedOutput(raw),
    } satisfies EvalProvider;

    const result = await executePromptWorkItem(provider, metadata, workItem);

    expect(result).toMatchObject({
      runId: metadata.runId,
      providerId: provider.id,
      lane: 'prompt',
      caseId: workItem.caseId,
      condition: workItem.condition,
      trial: workItem.trial,
      ok: false,
      errorClass: 'Error',
      errorMessage: 'prompt boom',
    });
    expect(result.normalizedOutput.finalText).toBe('');
    expect(result.normalizedOutput.messages).toEqual(['prompt boom']);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
