import { describe, expect, it } from 'vitest';

import {
  dogfoodCase,
  rawArtifactRequirement,
  rawReportRequirement,
  rawVerifier,
  rawWorkflowCheck,
} from '../../../../evals/authoring/index.js';
import { DogfoodEvalCaseSchema } from '../../../../evals/lib/schemas.js';
import type {
  ArtifactRequirement,
  ReportRequirement,
  VerifierSpec,
  WorkflowCheck,
} from '../../../../evals/lib/types.js';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dogfoodErrorPattern(
  caseId: string,
  path: string,
  message: string,
): RegExp {
  return new RegExp(
    escapeRegex(`Invalid dogfood case "${caseId}" at ${path}: ${message}`),
    'u',
  );
}

function createDogfoodBuilder(id = 'dogfood-authoring-happy') {
  return dogfoodCase(id)
    .category('qa')
    .task(
      'Exercise the hello-prompt fixture, capture evidence, and summarize findings.',
    )
    .fixture('hello-prompt')
    .bundlePath('dogfood/bundles/hello-prompt')
    .bundleRequirement('Include screenshots, recordings, and written notes.')
    .validationProfile('interactive-renderer')
    .proofBundle((bundle) => {
      bundle.requiresScreenshot();
      bundle.requiresRecording();
    })
    .report((report) => {
      report.title();
      report.reproductionSteps();
    })
    .bundleVerifier()
    .workflow((workflow) => {
      workflow
        .step('launch', 'Launch the workflow.')
        .mustMention('agent-tty create')
        .weight(2)
        .step('evidence', 'Capture reviewer evidence.')
        .mustMention('agent-tty screenshot')
        .after('launch');
    })
    .budget({ timeoutMs: 120_000, maxAgentSteps: 12, maxWallClockMs: 90_000 })
    .referenceSteps(4);
}

function createRawDogfoodWorkflowCheck(id = 'raw-workflow'): WorkflowCheck {
  return {
    id,
    description: 'Keep the raw dogfood workflow check unchanged.',
    required: false,
    requiredPatterns: ['agent-tty screenshot'],
    forbiddenPatterns: ['sleep 10'],
    dependsOn: ['launch'],
    weight: 3,
  };
}

function createRawDogfoodVerifier(id = 'raw-verifier'): VerifierSpec {
  return {
    id,
    kind: 'bundle',
    description: 'Keep the raw dogfood verifier unchanged.',
    required: true,
    config: {
      profile: 'interactive-renderer',
    },
  };
}

function createRawDogfoodArtifactRequirement(): ArtifactRequirement {
  return {
    kind: 'notes',
    required: true,
    description: 'Keep the raw dogfood artifact requirement unchanged.',
    minCount: 1,
    pathPatterns: ['notes\\.md$'],
  };
}

function createRawDogfoodReportRequirement(
  id = 'raw-report',
): ReportRequirement {
  return {
    id,
    description: 'Keep the raw dogfood report requirement unchanged.',
    required: true,
    section: 'Evidence',
    requiredPatterns: ['evidence'],
    forbiddenPatterns: ['TODO'],
  };
}

describe('dogfoodCase authoring facade', () => {
  it('builds a dogfood case that passes schema validation and preserves key fields', () => {
    const compiled = createDogfoodBuilder().build();

    expect(DogfoodEvalCaseSchema.parse(compiled)).toEqual(compiled);
    expect(compiled).toMatchObject({
      id: 'dogfood-authoring-happy',
      lane: 'dogfood',
      category: 'qa',
      expectedSkill: 'dogfood-tui',
      fixture: 'hello-prompt',
      bundlePath: 'dogfood/bundles/hello-prompt',
      bundleRequirements: [
        'Include screenshots, recordings, and written notes.',
      ],
      validationProfile: 'interactive-renderer',
      referenceSteps: 4,
      budgets: {
        timeoutMs: 120_000,
        maxAgentSteps: 12,
        maxWallClockMs: 90_000,
      },
    });
    expect(compiled.prompt).toContain('Exercise the hello-prompt fixture');
    expect(compiled.prompt).toContain(
      'test/fixtures/apps/hello-prompt/main.ts',
    );
    expect(compiled.artifactRequirements).toEqual([
      {
        kind: 'screenshot',
        required: true,
        description: 'Capture at least one screenshot of a noteworthy state.',
        minCount: 1,
        pathPatterns: ['\\.png$'],
      },
      {
        kind: 'recording',
        required: true,
        description: 'Capture at least one terminal recording artifact.',
        minCount: 1,
        pathPatterns: ['\\.cast$'],
      },
    ]);
    expect(
      compiled.reportRequirements.map((requirement) => requirement.id),
    ).toEqual(['title', 'repro-steps']);
    expect(compiled.verifiers).toEqual([
      {
        id: 'bundle-valid',
        kind: 'bundle',
        description:
          'Validate the proof bundle with the selected validation profile.',
        required: true,
        config: {
          profile: 'interactive-renderer',
        },
      },
    ]);
    expect(compiled.workflowChecks).toEqual([
      {
        id: 'launch',
        description: 'Launch the workflow.',
        required: false,
        requiredPatterns: ['agent-tty create'],
        forbiddenPatterns: [],
        dependsOn: [],
        weight: 2,
      },
      {
        id: 'evidence',
        description: 'Capture reviewer evidence.',
        required: false,
        requiredPatterns: ['agent-tty screenshot'],
        forbiddenPatterns: [],
        dependsOn: ['launch'],
      },
    ]);
  });

  it('includes the case id and field path for missing required fields', () => {
    expect(() =>
      dogfoodCase('dogfood-missing-bundle-requirements')
        .category('reporting')
        .task('Inspect the app and write notes.')
        .bundlePath('dogfood/bundles/reporting')
        .validationProfile('contract-reporting')
        .report((report) => {
          report.title();
        })
        .build(),
    ).toThrow(
      dogfoodErrorPattern(
        'dogfood-missing-bundle-requirements',
        'bundleRequirements',
        'bundleRequirements must include at least one requirement',
      ),
    );

    expect(() =>
      dogfoodCase('dogfood-missing-artifact-or-report-requirements')
        .category('qa')
        .task('Inspect the app and write notes.')
        .bundlePath('dogfood/bundles/reporting')
        .bundleRequirement('Produce a complete bundle.')
        .validationProfile('interactive-renderer')
        .build(),
    ).toThrow(
      dogfoodErrorPattern(
        'dogfood-missing-artifact-or-report-requirements',
        'artifactRequirements',
        'artifactRequirements or reportRequirements must include at least one requirement',
      ),
    );

    expect(() =>
      dogfoodCase('dogfood-missing-validation-profile')
        .category('qa')
        .task('Inspect the app and write notes.')
        .bundlePath('dogfood/bundles/reporting')
        .bundleRequirement('Produce a complete bundle.')
        .proofBundle((bundle) => {
          bundle.requiresScreenshot();
        })
        .build(),
    ).toThrow(
      dogfoodErrorPattern(
        'dogfood-missing-validation-profile',
        'validationProfile',
        'validationProfile is required',
      ),
    );
  });

  it('fails fast for duplicate workflow step ids', () => {
    expect(() =>
      dogfoodCase('dogfood-duplicate-workflow-step')
        .category('qa')
        .task('Inspect the app and write notes.')
        .bundlePath('dogfood/bundles/reporting')
        .bundleRequirement('Produce a complete bundle.')
        .validationProfile('interactive-renderer')
        .report((report) => {
          report.title();
        })
        .workflow((workflow) => {
          workflow.step('repeat', 'First step.').mustMention('create');
          workflow.step('repeat', 'Second step.').mustMention('screenshot');
        }),
    ).toThrow(
      dogfoodErrorPattern(
        'dogfood-duplicate-workflow-step',
        'workflowChecks',
        'Duplicate workflow step id "repeat"',
      ),
    );
  });

  it('fails fast for duplicate verifier ids', () => {
    expect(() =>
      dogfoodCase('dogfood-duplicate-verifier')
        .category('qa')
        .task('Inspect the app and write notes.')
        .bundlePath('dogfood/bundles/reporting')
        .bundleRequirement('Produce a complete bundle.')
        .validationProfile('interactive-renderer')
        .report((report) => {
          report.title();
        })
        .bundleVerifier()
        .bundleVerifier(),
    ).toThrow(
      dogfoodErrorPattern(
        'dogfood-duplicate-verifier',
        'verifiers',
        'Duplicate verifier id "bundle-valid"',
      ),
    );
  });

  it('fails fast for duplicate report requirement ids', () => {
    expect(() =>
      dogfoodCase('dogfood-duplicate-report-requirement')
        .category('reporting')
        .task('Inspect the app and write notes.')
        .bundlePath('dogfood/bundles/reporting')
        .bundleRequirement('Produce a complete bundle.')
        .validationProfile('contract-reporting')
        .report((report) => {
          report.section(
            'summary',
            'Summary',
            'Include a short summary section.',
            ['summary'],
          );
          report.section(
            'summary',
            'Summary',
            'Duplicate the same summary section id.',
            ['summary'],
          );
        }),
    ).toThrow(
      dogfoodErrorPattern(
        'dogfood-duplicate-report-requirement',
        'reportRequirements',
        'Duplicate report requirement id "summary"',
      ),
    );
  });

  it('fails fast when a workflow step both requires and forbids the same literal', () => {
    expect(() =>
      dogfoodCase('dogfood-contradictory-step')
        .category('qa')
        .task('Inspect the app and write notes.')
        .bundlePath('dogfood/bundles/reporting')
        .bundleRequirement('Produce a complete bundle.')
        .validationProfile('interactive-renderer')
        .report((report) => {
          report.title();
        })
        .workflow((workflow) => {
          workflow
            .step('conflict', 'Contradictory workflow rule.')
            .mustMention('agent-tty screenshot')
            .mustNotMention('agent-tty screenshot');
        }),
    ).toThrow(
      dogfoodErrorPattern(
        'dogfood-contradictory-step',
        'workflowChecks',
        'Workflow step "conflict" cannot require and forbid the same literal pattern "agent-tty screenshot"',
      ),
    );
  });

  it('fails when workflow() is used but no checks are added', () => {
    expect(() =>
      dogfoodCase('dogfood-empty-workflow')
        .category('qa')
        .task('Inspect the app and write notes.')
        .bundlePath('dogfood/bundles/reporting')
        .bundleRequirement('Produce a complete bundle.')
        .validationProfile('interactive-renderer')
        .report((report) => {
          report.title();
        })
        .workflow(() => undefined)
        .build(),
    ).toThrow(
      dogfoodErrorPattern(
        'dogfood-empty-workflow',
        'workflowChecks',
        'workflow() must add at least one workflow check',
      ),
    );
  });

  it('returns deep-equal fresh objects on repeated build() calls', () => {
    const builder = createDogfoodBuilder('dogfood-build-idempotence');

    const first = builder.build();
    const second = builder.build();

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.artifactRequirements).not.toBe(second.artifactRequirements);
    expect(first.artifactRequirements[0]).not.toBe(
      second.artifactRequirements[0],
    );
    expect(first.reportRequirements).not.toBe(second.reportRequirements);
    expect(first.reportRequirements[0]).not.toBe(second.reportRequirements[0]);
    expect(first.verifiers).not.toBe(second.verifiers);
    expect(first.workflowChecks).not.toBe(second.workflowChecks);
  });

  it('preserves raw workflow, verifier, artifact, and report fragments unchanged through compilation', () => {
    const rawCheck = rawWorkflowCheck(createRawDogfoodWorkflowCheck());
    const rawSpec = rawVerifier(createRawDogfoodVerifier());
    const rawArtifact = rawArtifactRequirement(
      createRawDogfoodArtifactRequirement(),
    );
    const rawReport = rawReportRequirement(createRawDogfoodReportRequirement());
    const compiled = dogfoodCase('dogfood-raw-fragments')
      .category('reporting')
      .task('Compile the raw fragments unchanged.')
      .bundlePath('dogfood/bundles/raw')
      .bundleRequirement('Produce a complete bundle.')
      .validationProfile('interactive-renderer')
      .rawWorkflowCheck(rawCheck)
      .rawVerifier(rawSpec)
      .rawArtifactRequirement(rawArtifact)
      .rawReportRequirement(rawReport)
      .build();

    expect(DogfoodEvalCaseSchema.parse(compiled)).toEqual(compiled);
    expect(compiled.workflowChecks).toEqual([rawCheck]);
    expect(compiled.verifiers).toEqual([rawSpec]);
    expect(compiled.artifactRequirements).toEqual([rawArtifact]);
    expect(compiled.reportRequirements).toEqual([rawReport]);
  });
});
