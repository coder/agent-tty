import { describe, expect, it } from 'vitest';

import { promptCase } from '../../../../evals/authoring/prompt.js';
import { caseFingerprint } from '../../../../evals/snapshots/fingerprint.js';
import type {
  AntiPatternRule,
  PromptEvalCase,
  WorkflowCheck,
} from '../../../../evals/lib/types.js';

const CREATE_WORKFLOW_CHECK: WorkflowCheck = {
  id: 'create',
  description: 'Create the session.',
  required: true,
  requiredPatterns: ['create session'],
  forbiddenPatterns: [],
  dependsOn: [],
};

const WAIT_WORKFLOW_CHECK: WorkflowCheck = {
  id: 'wait',
  description: 'Wait for the expected output.',
  required: true,
  requiredPatterns: ['wait for output'],
  forbiddenPatterns: [],
  dependsOn: ['create'],
};

const DEFAULT_WORKFLOW_CHECKS: WorkflowCheck[] = [
  CREATE_WORKFLOW_CHECK,
  WAIT_WORKFLOW_CHECK,
];

const DEFAULT_ANTI_PATTERN: AntiPatternRule = {
  id: 'sleep',
  description: 'Avoid fixed sleeps.',
  severity: 'warning',
  patterns: ['\\bsleep\\b'],
  suggestedFix: 'Use wait instead.',
  lanes: ['prompt'],
};

const DEFAULT_ANTI_PATTERNS: AntiPatternRule[] = [DEFAULT_ANTI_PATTERN];

function reorderObjectKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => reorderObjectKeysDeep(item));
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([key, entryValue]) => [key, reorderObjectKeysDeep(entryValue)]),
    );
  }

  return value;
}

function createPromptEvalCase(
  overrides: {
    prompt?: string;
    expectedPatterns?: string[];
    forbiddenPatterns?: string[];
    workflowChecks?: WorkflowCheck[];
    antiPatterns?: AntiPatternRule[];
    budgetMs?: number;
  } = {},
): PromptEvalCase {
  const builder = promptCase('snapshot-case')
    .category('workflow')
    .prompt(
      overrides.prompt ?? 'Use agent-tty to collect a snapshot of the app.',
    )
    .expectSkill('agent-tty')
    .budget(overrides.budgetMs ?? 30_000)
    .antiPatterns(...(overrides.antiPatterns ?? DEFAULT_ANTI_PATTERNS));

  for (const pattern of overrides.expectedPatterns ?? [
    'agent-tty',
    'snapshot',
  ]) {
    builder.expectedPattern(pattern);
  }
  for (const pattern of overrides.forbiddenPatterns ?? ['tmux']) {
    builder.forbiddenPattern(pattern);
  }
  for (const check of overrides.workflowChecks ?? DEFAULT_WORKFLOW_CHECKS) {
    builder.rawWorkflowCheck(check);
  }

  return builder.build();
}

describe('caseFingerprint', () => {
  it('is stable across repeated builds and ignores excluded compiled fields', () => {
    const defaultCase = createPromptEvalCase();
    const rebuiltCase = createPromptEvalCase();
    const differentBudgetCase = createPromptEvalCase({ budgetMs: 60_000 });

    expect(caseFingerprint(defaultCase)).toBe(caseFingerprint(rebuiltCase));
    expect(caseFingerprint(defaultCase)).toBe(
      caseFingerprint(differentBudgetCase),
    );
  });

  it('ignores object key insertion order when serializing semantic fields', () => {
    const compiledCase = createPromptEvalCase();
    const reorderedCase = reorderObjectKeysDeep(compiledCase) as PromptEvalCase;

    expect(caseFingerprint(compiledCase)).toBe(caseFingerprint(reorderedCase));
  });

  it('changes when the prompt text changes', () => {
    const baselineCase = createPromptEvalCase();
    const changedPromptCase = createPromptEvalCase({
      prompt: 'Use agent-tty to capture a screenshot of the app instead.',
    });

    expect(caseFingerprint(changedPromptCase)).not.toBe(
      caseFingerprint(baselineCase),
    );
  });

  it('changes when anti-pattern semantics change', () => {
    const baselineCase = createPromptEvalCase();
    const changedAntiPatternCase = createPromptEvalCase({
      antiPatterns: [
        {
          ...DEFAULT_ANTI_PATTERN,
          patterns: ['\\bsleep\\b', '\\bsetTimeout\\b'],
        },
      ],
    });

    expect(caseFingerprint(changedAntiPatternCase)).not.toBe(
      caseFingerprint(baselineCase),
    );
  });

  it('changes when workflow step order changes', () => {
    const baselineCase = createPromptEvalCase();
    const reorderedWorkflowCase = createPromptEvalCase({
      workflowChecks: [WAIT_WORKFLOW_CHECK, CREATE_WORKFLOW_CHECK],
    });

    expect(caseFingerprint(reorderedWorkflowCase)).not.toBe(
      caseFingerprint(baselineCase),
    );
  });
});
