import type { ArtifactKind } from '../../src/tools/review-bundle.js';
import { DEFAULT_ANTI_PATTERN_RULES } from '../lib/antiPatterns.js';
import { SKILL_CONDITIONS } from '../lib/matrix.js';
import { DogfoodEvalCaseSchema } from '../lib/schemas.js';
import type {
  AntiPatternRule,
  ArtifactRequirement,
  DogfoodEvalCase,
  ReportRequirement,
  SkillCondition,
  VerifierKind,
  VerifierSpec,
  WorkflowCheck,
} from '../lib/types.js';
import { dogfoodTaskPrompt } from '../dogfood/cases/shared.js';
import { artifactRequirement, requiredVerifier } from '../execution/cases/shared.js';
import {
  assertCase,
  assertDefined,
  assertUniqueId,
  cloneValue,
  compileAndValidate,
  toPatternSource,
  type PatternInput,
} from './compile.js';
import { ReportBuilder } from './report.js';
import { WorkflowBuilder } from './workflow.js';

const DEFAULT_DOGFOOD_BUDGETS: DogfoodEvalCase['budgets'] = {
  timeoutMs: 600_000,
  maxAgentSteps: 30,
  maxWallClockMs: 600_000,
};
const SCREENSHOT_BUNDLE_PATH_PATTERN = String.raw`\.png$`;
const RECORDING_BUNDLE_PATH_PATTERN = String.raw`\.cast$`;
const NOTES_BUNDLE_PATH_PATTERN =
  String.raw`(?:^|/)(?:README|NOTES|index|notes)\.md$`;

function cloneAntiPatternRule(rule: AntiPatternRule): AntiPatternRule {
  return cloneValue(rule, 'dogfood', 'defaults', 'antiPatterns');
}

export class DogfoodProofBundleBuilder {
  private readonly addRequirement: (requirement: ArtifactRequirement) => void;

  constructor(addRequirement: (requirement: ArtifactRequirement) => void) {
    this.addRequirement = addRequirement;
  }

  requiresScreenshot(
    description = 'Capture at least one screenshot of a noteworthy state.',
    pathPattern: PatternInput = SCREENSHOT_BUNDLE_PATH_PATTERN,
    minCount = 1,
  ): this {
    this.addRequirement(
      artifactRequirement(
        'screenshot',
        description,
        toPatternSource(pathPattern),
        minCount,
      ),
    );
    return this;
  }

  requiresRecording(
    description = 'Capture at least one terminal recording artifact.',
    pathPattern: PatternInput = RECORDING_BUNDLE_PATH_PATTERN,
    minCount = 1,
  ): this {
    this.addRequirement(
      artifactRequirement(
        'recording',
        description,
        toPatternSource(pathPattern),
        minCount,
      ),
    );
    return this;
  }

  requiresNotes(
    description = 'Write exploratory QA notes in a markdown report.',
    pathPattern: PatternInput = NOTES_BUNDLE_PATH_PATTERN,
    minCount = 1,
  ): this {
    this.addRequirement(
      artifactRequirement(
        'notes',
        description,
        toPatternSource(pathPattern),
        minCount,
      ),
    );
    return this;
  }

  raw(requirement: ArtifactRequirement): this {
    this.addRequirement(requirement);
    return this;
  }

  rawArtifactRequirement(requirement: ArtifactRequirement): this {
    return this.raw(requirement);
  }
}

export class DogfoodCaseBuilder {
  private readonly id: string;
  private categoryValue?: DogfoodEvalCase['category'];
  private taskValue?: string;
  private fixtureValue?: string;
  private targetValue?: string;
  private bundlePathValue?: string;
  private readonly bundleRequirementsValue: string[] = [];
  private conditionsValue: SkillCondition[] = [...SKILL_CONDITIONS];
  private validationProfileValue?: DogfoodEvalCase['validationProfile'];
  private readonly artifactRequirementsValue: ArtifactRequirement[] = [];
  private readonly reportBuilder: ReportBuilder;
  private readonly verifiersValue: VerifierSpec[] = [];
  private readonly verifierIds = new Set<string>();
  private readonly workflowBuilder: WorkflowBuilder;
  private antiPatternRulesValue: AntiPatternRule[] | undefined;
  private budgetOverridesValue: Partial<DogfoodEvalCase['budgets']> = {};
  private referenceStepsValue?: number;
  private workflowUsed = false;

  constructor(id: string) {
    this.id = id;
    this.reportBuilder = new ReportBuilder(id);
    this.workflowBuilder = new WorkflowBuilder({
      lane: 'dogfood',
      caseId: id,
      defaultRequired: false,
    });
  }

  category(category: DogfoodEvalCase['category']): this {
    this.categoryValue = category;
    return this;
  }

  fixture(fixture: string): this {
    this.fixtureValue = fixture;
    return this;
  }

  target(target: string): this {
    this.targetValue = target;
    return this;
  }

  task(task: string): this {
    this.taskValue = task;
    return this;
  }

  bundlePath(bundlePath: string): this {
    this.bundlePathValue = bundlePath;
    return this;
  }

  bundleRequirement(...requirements: string[]): this {
    this.bundleRequirementsValue.push(...requirements);
    return this;
  }

  bundleRequirements(requirements: readonly string[]): this {
    this.bundleRequirementsValue.length = 0;
    return this.bundleRequirement(...requirements);
  }

  conditions(...conditions: SkillCondition[]): this {
    this.conditionsValue = [...conditions];
    return this;
  }

  proofBundle(
    callback: (bundle: DogfoodProofBundleBuilder) => unknown,
  ): this {
    callback(
      new DogfoodProofBundleBuilder((requirement) =>
        this.addArtifactRequirement(requirement),
      ),
    );
    return this;
  }

  artifact(
    kind: ArtifactKind,
    description: string,
    pathPattern: PatternInput,
    minCount = 1,
  ): this {
    this.addArtifactRequirement(
      artifactRequirement(
        kind,
        description,
        toPatternSource(pathPattern),
        minCount,
      ),
    );
    return this;
  }

  rawArtifactRequirement(requirement: ArtifactRequirement): this {
    this.addArtifactRequirement(requirement);
    return this;
  }

  report(callback: (report: ReportBuilder) => unknown): this {
    callback(this.reportBuilder);
    return this;
  }

  rawReportRequirement(requirement: ReportRequirement): this {
    this.reportBuilder.rawReportRequirement(requirement);
    return this;
  }

  validationProfile(
    validationProfile: DogfoodEvalCase['validationProfile'],
  ): this {
    this.validationProfileValue = validationProfile;
    return this;
  }

  verifier(
    id: string,
    kind: VerifierKind,
    description: string,
    config: Record<string, unknown>,
  ): this {
    this.addVerifier(requiredVerifier(id, kind, description, config));
    return this;
  }

  bundleVerifier(
    id = 'bundle-valid',
    description = 'Validate the proof bundle with the selected validation profile.',
    config: Record<string, unknown> = {},
  ): this {
    const profile = config.profile ?? this.validationProfileValue;
    assertCase(
      profile !== undefined,
      'dogfood',
      this.id,
      'validationProfile',
      'validationProfile must be set before bundleVerifier() unless config.profile is provided',
    );
    this.addVerifier(
      requiredVerifier(id, 'bundle', description, {
        ...config,
        profile,
      }),
    );
    return this;
  }

  rawVerifier(verifier: VerifierSpec): this {
    this.addVerifier(verifier);
    return this;
  }

  workflow(callback: (workflow: WorkflowBuilder) => unknown): this {
    this.workflowUsed = true;
    callback(this.workflowBuilder);
    return this;
  }

  rawWorkflowCheck(check: WorkflowCheck): this {
    this.workflowBuilder.rawWorkflowCheck(check);
    return this;
  }

  antiPatterns(...rules: AntiPatternRule[]): this {
    this.antiPatternRulesValue = cloneValue(
      rules,
      'dogfood',
      this.id,
      'antiPatterns',
    );
    return this;
  }

  budget(overrides: Partial<DogfoodEvalCase['budgets']>): this {
    this.budgetOverridesValue = {
      ...this.budgetOverridesValue,
      ...overrides,
    };
    return this;
  }

  referenceSteps(referenceSteps: number): this {
    this.referenceStepsValue = referenceSteps;
    return this;
  }

  build(): DogfoodEvalCase {
    const category = assertDefined(
      this.categoryValue,
      'dogfood',
      this.id,
      'category',
      'category is required',
    );
    const task = assertDefined(
      this.taskValue,
      'dogfood',
      this.id,
      'prompt',
      'task is required',
    );
    const bundlePath = assertDefined(
      this.bundlePathValue,
      'dogfood',
      this.id,
      'bundlePath',
      'bundlePath is required',
    );
    const validationProfile = assertDefined(
      this.validationProfileValue,
      'dogfood',
      this.id,
      'validationProfile',
      'validationProfile is required',
    );
    assertCase(
      this.bundleRequirementsValue.length > 0,
      'dogfood',
      this.id,
      'bundleRequirements',
      'bundleRequirements must include at least one requirement',
    );
    assertCase(
      this.conditionsValue.length > 0,
      'dogfood',
      this.id,
      'conditions',
      'conditions must include at least one skill condition',
    );

    const workflowChecks = this.workflowBuilder.build();
    assertCase(
      !this.workflowUsed || workflowChecks.length > 0,
      'dogfood',
      this.id,
      'workflowChecks',
      'workflow() must add at least one workflow check',
    );

    const antiPatterns =
      this.antiPatternRulesValue === undefined
        ? DEFAULT_ANTI_PATTERN_RULES.map((rule) => cloneAntiPatternRule(rule))
        : cloneValue(
            this.antiPatternRulesValue,
            'dogfood',
            this.id,
            'antiPatterns',
          );

    const compiled: DogfoodEvalCase = {
      id: this.id,
      lane: 'dogfood',
      category,
      prompt: dogfoodTaskPrompt(task, this.fixtureValue),
      expectedSkill: 'dogfood-tui',
      bundlePath,
      bundleRequirements: [...this.bundleRequirementsValue],
      conditions: [...this.conditionsValue],
      validationProfile,
      artifactRequirements: cloneValue(
        this.artifactRequirementsValue,
        'dogfood',
        this.id,
        'artifactRequirements',
      ),
      reportRequirements: this.reportBuilder.build(),
      verifiers: cloneValue(this.verifiersValue, 'dogfood', this.id, 'verifiers'),
      workflowChecks,
      antiPatterns,
      budgets: {
        ...DEFAULT_DOGFOOD_BUDGETS,
        ...this.budgetOverridesValue,
      },
    };
    if (this.fixtureValue !== undefined) {
      compiled.fixture = this.fixtureValue;
    }
    if (this.targetValue !== undefined) {
      compiled.target = this.targetValue;
    }
    if (this.referenceStepsValue !== undefined) {
      compiled.referenceSteps = this.referenceStepsValue;
    }

    return compileAndValidate('dogfood', this.id, DogfoodEvalCaseSchema, compiled);
  }

  private addArtifactRequirement(requirement: ArtifactRequirement): void {
    this.artifactRequirementsValue.push(
      cloneValue(
        requirement,
        'dogfood',
        this.id,
        'artifactRequirements',
      ),
    );
  }

  private addVerifier(verifier: VerifierSpec): void {
    assertUniqueId(
      this.verifierIds,
      verifier.id,
      'dogfood',
      this.id,
      'verifiers',
      'verifier id',
    );
    this.verifiersValue.push(
      cloneValue(verifier, 'dogfood', this.id, `verifiers.${verifier.id}`),
    );
  }
}

export function dogfoodCase(id: string): DogfoodCaseBuilder {
  return new DogfoodCaseBuilder(id);
}
