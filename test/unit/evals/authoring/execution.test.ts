import { describe, expect, it } from 'vitest';

import {
  executionCase,
  rawArtifactRequirement,
  rawVerifier,
  rawWorkflowCheck,
} from '../../../../evals/authoring/index.js';
import { ExecutionEvalCaseSchema } from '../../../../evals/lib/schemas.js';
import type {
  ArtifactRequirement,
  VerifierSpec,
  WorkflowCheck,
} from '../../../../evals/lib/types.js';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function executionErrorPattern(
  caseId: string,
  path: string,
  message: string,
): RegExp {
  return new RegExp(
    escapeRegex(`Invalid execution case "${caseId}" at ${path}: ${message}`),
    'u',
  );
}

function createExecutionBuilder(id = 'execution-authoring-happy') {
  return executionCase(id)
    .category('session')
    .task(
      'Launch the hello-prompt fixture, submit input, and capture proof output.',
    )
    .fixture('hello-prompt')
    .target('test/fixtures/apps/hello-prompt/main.ts')
    .workflow((workflow) => {
      workflow
        .createSession({ id: 'create' })
        .input('hello', { id: 'input' })
        .waitFor('world', { id: 'wait' })
        .snapshot({ id: 'snapshot' })
        .destroy({ id: 'destroy' });
    })
    .assertions((assertions) => {
      assertions.snapshotContains('hello', 'world');
    })
    .artifact(
      'screenshot',
      'Capture at least one screenshot artifact.',
      /\.png$/u,
    )
    .budget({ timeoutMs: 90_000, maxAgentSteps: 8, maxWallClockMs: 60_000 })
    .referenceSteps(5);
}

function createRawExecutionWorkflowCheck(id = 'raw-workflow'): WorkflowCheck {
  return {
    id,
    description: 'Keep the raw execution workflow check unchanged.',
    required: true,
    requiredPatterns: ['agent-tty wait'],
    forbiddenPatterns: ['sleep 5'],
    dependsOn: ['create'],
    weight: 4,
  };
}

function createRawExecutionVerifier(id = 'raw-verifier'): VerifierSpec {
  return {
    id,
    kind: 'command',
    description: 'Keep the raw verifier unchanged.',
    required: true,
    config: {
      command: 'node',
      argv: ['scripts/check.js'],
    },
  };
}

function createRawExecutionArtifactRequirement(
  kind: ArtifactRequirement['kind'] = 'json',
): ArtifactRequirement {
  return {
    kind,
    required: true,
    description: 'Keep the raw artifact requirement unchanged.',
    minCount: 1,
    pathPatterns: ['output\\.json$'],
  };
}

function requireDefined<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`${label} must be defined`);
  }
  return value;
}

describe('executionCase authoring facade', () => {
  it('builds an execution case that passes schema validation and preserves key fields', () => {
    const compiled = createExecutionBuilder().build();

    expect(ExecutionEvalCaseSchema.parse(compiled)).toEqual(compiled);
    expect(compiled).toMatchObject({
      id: 'execution-authoring-happy',
      lane: 'execution',
      category: 'session',
      expectedSkill: 'agent-tty',
      fixture: 'hello-prompt',
      target: 'test/fixtures/apps/hello-prompt/main.ts',
      referenceSteps: 5,
      budgets: {
        timeoutMs: 90_000,
        maxAgentSteps: 8,
        maxWallClockMs: 60_000,
      },
    });
    expect(compiled.prompt).toContain('Launch the hello-prompt fixture');
    expect(compiled.prompt).toContain(
      'test/fixtures/apps/hello-prompt/main.ts',
    );
    expect(compiled.setup).toHaveLength(1);
    expect(compiled.setup[0]).toMatchObject({
      id: 'launch-hello-prompt',
      description:
        'Create an agent-tty session that runs the hello-prompt fixture.',
    });
    expect(compiled.workflowChecks.map((check) => check.id)).toEqual([
      'create',
      'input',
      'wait',
      'snapshot',
      'destroy',
    ]);
    const inputCheck = requireDefined(
      compiled.workflowChecks[1],
      'workflowChecks[1]',
    );
    const waitCheck = requireDefined(
      compiled.workflowChecks[2],
      'workflowChecks[2]',
    );
    expect(inputCheck.dependsOn).toEqual(['create']);
    expect(waitCheck.dependsOn).toEqual(['input']);
    expect(compiled.verifiers).toEqual([
      {
        id: 'snapshot-contains',
        kind: 'snapshot',
        description:
          'The snapshot should contain the required content patterns.',
        required: true,
        config: {
          patterns: ['hello', 'world'],
        },
      },
    ]);
    expect(compiled.artifactRequirements).toEqual([
      {
        kind: 'screenshot',
        required: true,
        description: 'Capture at least one screenshot artifact.',
        minCount: 1,
        pathPatterns: ['/\\.png$/u'],
      },
    ]);
  });

  it('includes the case id and field path for missing required fields', () => {
    expect(() =>
      executionCase('execution-missing-task')
        .category('session')
        .target('README.md')
        .verifier(
          'snapshot-check',
          'snapshot',
          'Require a snapshot verifier.',
          {
            patterns: ['ready'],
          },
        )
        .build(),
    ).toThrow(
      executionErrorPattern(
        'execution-missing-task',
        'prompt',
        'task is required',
      ),
    );

    expect(() =>
      executionCase('execution-missing-fixture-or-target')
        .category('session')
        .task('Drive the session.')
        .verifier(
          'snapshot-check',
          'snapshot',
          'Require a snapshot verifier.',
          {
            patterns: ['ready'],
          },
        )
        .build(),
    ).toThrow(
      executionErrorPattern(
        'execution-missing-fixture-or-target',
        'fixture',
        'fixture or target is required',
      ),
    );

    expect(() =>
      executionCase('execution-missing-verifiers')
        .category('session')
        .task('Drive the session.')
        .target('README.md')
        .build(),
    ).toThrow(
      executionErrorPattern(
        'execution-missing-verifiers',
        'verifiers',
        'verifiers must include at least one verifier',
      ),
    );
  });

  it('fails fast for duplicate workflow step ids', () => {
    expect(() =>
      executionCase('execution-duplicate-workflow-step')
        .category('session')
        .task('Drive the session.')
        .target('README.md')
        .workflow((workflow) => {
          workflow.createSession({ id: 'repeat' });
          workflow.waitFor('ready', { id: 'repeat' });
        }),
    ).toThrow(
      executionErrorPattern(
        'execution-duplicate-workflow-step',
        'workflowChecks',
        'Duplicate workflow step id "repeat"',
      ),
    );
  });

  it('fails fast for duplicate verifier ids', () => {
    expect(() =>
      executionCase('execution-duplicate-verifier')
        .category('artifact')
        .task('Check the captured output.')
        .target('README.md')
        .assertions((assertions) => {
          assertions.snapshotContains('ready');
          assertions.snapshotContains('done');
        }),
    ).toThrow(
      executionErrorPattern(
        'execution-duplicate-verifier',
        'verifiers',
        'Duplicate verifier id "snapshot-contains"',
      ),
    );
  });

  it('fails fast when a workflow check both requires and forbids the same literal', () => {
    expect(() =>
      executionCase('execution-contradictory-step')
        .category('session')
        .task('Drive the session.')
        .target('README.md')
        .workflow((workflow) => {
          workflow.createSession({
            id: 'conflict',
            pattern: 'agent-tty create',
            forbiddenPattern: 'agent-tty create',
          });
        }),
    ).toThrow(
      executionErrorPattern(
        'execution-contradictory-step',
        'workflowChecks',
        'Workflow step "conflict" cannot require and forbid the same literal pattern "agent-tty create"',
      ),
    );
  });

  it('fails when workflow() is used but no checks are added', () => {
    expect(() =>
      executionCase('execution-empty-workflow')
        .category('session')
        .task('Drive the session.')
        .target('README.md')
        .verifier(
          'snapshot-check',
          'snapshot',
          'Require a snapshot verifier.',
          {
            patterns: ['ready'],
          },
        )
        .workflow(() => undefined)
        .build(),
    ).toThrow(
      executionErrorPattern(
        'execution-empty-workflow',
        'workflowChecks',
        'workflow() must add at least one workflow check',
      ),
    );
  });

  it('returns deep-equal fresh objects on repeated build() calls', () => {
    const builder = createExecutionBuilder('execution-build-idempotence');

    const first = builder.build();
    const second = builder.build();

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.setup).not.toBe(second.setup);
    expect(first.setup[0]).not.toBe(second.setup[0]);
    expect(first.verifiers).not.toBe(second.verifiers);
    expect(first.verifiers[0]).not.toBe(second.verifiers[0]);
    expect(first.workflowChecks).not.toBe(second.workflowChecks);
    expect(first.artifactRequirements).not.toBe(second.artifactRequirements);
  });

  it('preserves raw workflow, verifier, and artifact fragments unchanged through compilation', () => {
    const rawCheck = rawWorkflowCheck(createRawExecutionWorkflowCheck());
    const rawSpec = rawVerifier(createRawExecutionVerifier());
    const rawArtifact = rawArtifactRequirement(
      createRawExecutionArtifactRequirement(),
    );
    const compiled = executionCase('execution-raw-fragments')
      .category('artifact')
      .task('Compile the raw fragments unchanged.')
      .target('README.md')
      .rawWorkflowCheck(rawCheck)
      .rawVerifier(rawSpec)
      .rawArtifactRequirement(rawArtifact)
      .build();

    expect(ExecutionEvalCaseSchema.parse(compiled)).toEqual(compiled);
    expect(compiled.setup).toEqual([]);
    expect(compiled.workflowChecks).toEqual([rawCheck]);
    expect(compiled.verifiers).toEqual([rawSpec]);
    expect(compiled.artifactRequirements).toEqual([rawArtifact]);
  });
});
