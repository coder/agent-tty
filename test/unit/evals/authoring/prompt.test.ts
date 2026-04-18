import { describe, expect, it } from 'vitest';

import {
  promptCase,
  rawWorkflowCheck,
} from '../../../../evals/authoring/index.js';
import { PromptEvalCaseSchema } from '../../../../evals/lib/schemas.js';
import type { WorkflowCheck } from '../../../../evals/lib/types.js';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function promptErrorPattern(
  caseId: string,
  path: string,
  message: string,
): RegExp {
  return new RegExp(
    escapeRegex(`Invalid prompt case "${caseId}" at ${path}: ${message}`),
    'u',
  );
}

function createPromptBuilder(id = 'prompt-authoring-happy') {
  return promptCase(id)
    .category('workflow')
    .prompt('Use agent-tty to create a session and capture a snapshot.')
    .expectSkill('agent-tty')
    .context('Use the isolated AGENT_TTY_HOME for this eval.')
    .expectedPattern(/agent-tty\b/u, 'snapshot')
    .mustNotMention('tmux')
    .rubric('Uses agent-tty commands instead of only describing the workflow.');
}

function createRawWorkflowStep(id = 'raw-check'): WorkflowCheck {
  return {
    id,
    description: 'Use the raw workflow check unchanged.',
    required: true,
    requiredPatterns: ['raw required pattern'],
    forbiddenPatterns: ['raw forbidden pattern'],
    dependsOn: ['setup'],
    weight: 2,
  };
}

describe('promptCase authoring facade', () => {
  it('builds a prompt case that passes schema validation and preserves key fields', () => {
    const compiled = createPromptBuilder()
      .workflow((workflow) => {
        workflow
          .step('create', 'Create the session first.')
          .mustMention('agent-tty create')
          .weight(2)
          .step('snapshot', 'Capture a verification snapshot.')
          .mustMention(/snapshot\b/u)
          .after('create');
      })
      .budget({ timeoutMs: 45_000 })
      .build();

    expect(PromptEvalCaseSchema.parse(compiled)).toEqual(compiled);
    expect(compiled).toMatchObject({
      id: 'prompt-authoring-happy',
      lane: 'prompt',
      category: 'workflow',
      expectedSkill: 'agent-tty',
      budgets: { timeoutMs: 45_000 },
      expectedPatterns: ['/agent-tty\\b/u', 'snapshot'],
      forbiddenPatterns: ['tmux'],
      rubric: [
        'Uses agent-tty commands instead of only describing the workflow.',
      ],
    });
    expect(compiled.context).toContain('AGENT_TTY_HOME');
    expect(compiled.workflowChecks).toEqual([
      {
        id: 'create',
        description: 'Create the session first.',
        required: true,
        requiredPatterns: ['agent-tty create'],
        forbiddenPatterns: [],
        dependsOn: [],
        weight: 2,
      },
      {
        id: 'snapshot',
        description: 'Capture a verification snapshot.',
        required: true,
        requiredPatterns: ['/snapshot\\b/u'],
        forbiddenPatterns: [],
        dependsOn: ['create'],
      },
    ]);
  });

  it('includes the case id and field path for missing required fields', () => {
    expect(() =>
      promptCase('prompt-missing-category')
        .prompt('Use agent-tty.')
        .expectSkill('agent-tty')
        .expectedPattern('agent-tty')
        .build(),
    ).toThrow(
      promptErrorPattern(
        'prompt-missing-category',
        'category',
        'category is required',
      ),
    );

    expect(() =>
      promptCase('prompt-missing-prompt')
        .category('trigger')
        .expectSkill('agent-tty')
        .expectedPattern('agent-tty')
        .build(),
    ).toThrow(
      promptErrorPattern(
        'prompt-missing-prompt',
        'prompt',
        'prompt is required',
      ),
    );

    expect(() =>
      promptCase('prompt-missing-expected-patterns')
        .category('selection')
        .prompt('Use agent-tty.')
        .expectSkill('agent-tty')
        .build(),
    ).toThrow(
      promptErrorPattern(
        'prompt-missing-expected-patterns',
        'expectedPatterns',
        'expectedPatterns must include at least one pattern',
      ),
    );
  });

  it('fails fast for duplicate workflow step ids', () => {
    expect(() =>
      createPromptBuilder('prompt-duplicate-workflow-step').workflow(
        (workflow) => {
          workflow
            .step('collect', 'Collect the first signal.')
            .mustMention('create');
          workflow
            .step('collect', 'Collect the second signal.')
            .mustMention('wait');
        },
      ),
    ).toThrow(
      promptErrorPattern(
        'prompt-duplicate-workflow-step',
        'workflowChecks',
        'Duplicate workflow step id "collect"',
      ),
    );
  });

  it('fails fast when a workflow step both requires and forbids the same literal', () => {
    expect(() =>
      createPromptBuilder('prompt-contradictory-step').workflow((workflow) => {
        workflow
          .step('conflict', 'Contradictory workflow rule.')
          .mustMention('agent-tty wait')
          .mustNotMention('agent-tty wait');
      }),
    ).toThrow(
      promptErrorPattern(
        'prompt-contradictory-step',
        'workflowChecks',
        'Workflow step "conflict" cannot require and forbid the same literal pattern "agent-tty wait"',
      ),
    );
  });

  it('fails when workflow() is used but no checks are added', () => {
    expect(() =>
      createPromptBuilder('prompt-empty-workflow')
        .workflow(() => undefined)
        .build(),
    ).toThrow(
      promptErrorPattern(
        'prompt-empty-workflow',
        'workflowChecks',
        'workflow() must add at least one workflow check',
      ),
    );
  });

  it('returns deep-equal fresh objects on repeated build() calls', () => {
    const builder = createPromptBuilder('prompt-build-idempotence').workflow(
      (workflow) => {
        workflow
          .step('create', 'Create the session first.')
          .mustMention('agent-tty create')
          .step('snapshot', 'Capture the snapshot second.')
          .mustMention('agent-tty snapshot')
          .after('create');
      },
    );

    const first = builder.build();
    const second = builder.build();

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.workflowChecks).not.toBe(second.workflowChecks);
    expect(first.workflowChecks[0]).not.toBe(second.workflowChecks[0]);
    expect(first.budgets).not.toBe(second.budgets);
  });

  it('preserves rawWorkflowCheck fragments unchanged through compilation', () => {
    const rawCheck = rawWorkflowCheck(createRawWorkflowStep());
    const compiled = promptCase('prompt-raw-fragments')
      .category('selection')
      .prompt('Reach for the raw workflow check helper when needed.')
      .expectSkill('agent-tty')
      .expectedPattern('raw workflow')
      .rawWorkflowCheck(rawCheck)
      .build();

    expect(PromptEvalCaseSchema.parse(compiled)).toEqual(compiled);
    expect(compiled.workflowChecks).toEqual([rawCheck]);
  });
});
