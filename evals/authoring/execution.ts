import type { ArtifactKind } from '../../src/tools/review-bundle.js';
import {
  ALL_EXECUTION_CONDITIONS,
  CREATE_SESSION_PATTERN,
  DESTROY_SESSION_PATTERN,
  RUN_PATTERN,
  SCREENSHOT_PATTERN,
  SNAPSHOT_PATTERN,
  TYPE_PATTERN,
  WAIT_PATTERN,
  anyOf,
  artifactRequirement,
  customVerifier,
  executionAntiPatterns,
  executionBudgets,
  executionTaskPrompt,
  fixtureSetupStep,
  requiredVerifier,
  workflowCheck,
} from '../execution/cases/shared.js';
import { ExecutionEvalCaseSchema } from '../lib/schemas.js';
import type {
  AntiPatternRule,
  ArtifactRequirement,
  ExecutionEvalCase,
  SkillCondition,
  VerifierKind,
  VerifierSpec,
  WorkflowCheck,
} from '../lib/types.js';
import {
  assertCase,
  assertDefined,
  assertUniqueId,
  cloneValue,
  compileAndValidate,
  toPatternSource,
  type PatternInput,
} from './compile.js';
import { WorkflowBuilder } from './workflow.js';

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\\$&`);
}

function describePatternInput(value: PatternInput): string {
  return typeof value === 'string'
    ? JSON.stringify(value)
    : 'the expected pattern';
}

interface FixtureOptions {
  setupId?: string;
  setupDescription?: string;
  timeoutMs?: number;
}

interface ExecutionWorkflowStepOptions {
  id?: string;
  description?: string;
  dependsOn?: string[];
  required?: boolean;
  weight?: number;
  forbiddenPattern?: PatternInput;
  pattern?: PatternInput;
}

type ExecutionActionStepOptions = ExecutionWorkflowStepOptions;

interface ExecutionFixtureDraft {
  fixture: string;
  setupId: string;
  setupDescription: string;
  timeoutMs?: number;
}

function defaultInputPattern(text: string): string {
  const escapedText = escapeRegexLiteral(text);
  return anyOf(
    String.raw`\bagent-tty\b[^\n]*\b(?:run|type)\b[^\n]*${escapedText}`,
    String.raw`\b(?:run|type)(?:ning|s|ned)?\b[^\n]*${escapedText}\b`,
  );
}

function defaultRunPattern(command: string): string {
  const escapedCommand = escapeRegexLiteral(command);
  return anyOf(
    String.raw`\bagent-tty\b[^\n]*\brun\b[^\n]*${escapedCommand}`,
    String.raw`\brun(?:ning|s|ned)?\b[^\n]*${escapedCommand}\b`,
  );
}

function resolveCommandPattern(
  value: PatternInput,
  builder: (text: string) => string,
  override?: PatternInput,
): string {
  if (override !== undefined) {
    return toPatternSource(override);
  }

  if (value instanceof RegExp) {
    return toPatternSource(value);
  }

  return builder(value);
}

function resolveDependsOn(
  previousStepId: string | undefined,
  dependsOn: readonly string[] | undefined,
): string[] | undefined {
  if (dependsOn !== undefined) {
    return [...dependsOn];
  }

  return previousStepId === undefined ? undefined : [previousStepId];
}

export class ExecutionWorkflowBuilder {
  private readonly workflowBuilder: WorkflowBuilder;
  private lastStepId: string | undefined;

  constructor(workflowBuilder: WorkflowBuilder) {
    this.workflowBuilder = workflowBuilder;
  }

  createSession(options: ExecutionWorkflowStepOptions = {}): this {
    return this.appendCheck(
      options.id ?? 'create',
      options.description ?? 'Create the fixture session.',
      options.pattern === undefined
        ? CREATE_SESSION_PATTERN
        : toPatternSource(options.pattern),
      options,
    );
  }

  input(value: PatternInput, options: ExecutionActionStepOptions = {}): this {
    return this.appendCheck(
      options.id ?? 'input',
      options.description ??
        `Send ${describePatternInput(value)} with run or type.`,
      resolveCommandPattern(value, defaultInputPattern, options.pattern),
      options,
    );
  }

  run(value: PatternInput, options: ExecutionActionStepOptions = {}): this {
    return this.appendCheck(
      options.id ?? 'run',
      options.description ?? `Run ${describePatternInput(value)}.`,
      resolveCommandPattern(value, defaultRunPattern, options.pattern),
      options,
    );
  }

  waitFor(
    value?: PatternInput,
    options: ExecutionWorkflowStepOptions = {},
  ): this {
    const requiredPattern =
      options.pattern !== undefined
        ? toPatternSource(options.pattern)
        : value === undefined
          ? WAIT_PATTERN
          : anyOf(WAIT_PATTERN, toPatternSource(value));
    return this.appendCheck(
      options.id ?? 'wait',
      options.description ?? 'Wait for the expected output before continuing.',
      requiredPattern,
      options,
    );
  }

  snapshot(options: ExecutionWorkflowStepOptions = {}): this {
    return this.appendCheck(
      options.id ?? 'snapshot',
      options.description ?? 'Capture a snapshot for verification.',
      options.pattern === undefined
        ? SNAPSHOT_PATTERN
        : toPatternSource(options.pattern),
      options,
    );
  }

  screenshot(options: ExecutionWorkflowStepOptions = {}): this {
    return this.appendCheck(
      options.id ?? 'screenshot',
      options.description ?? 'Capture a screenshot for verification.',
      options.pattern === undefined
        ? SCREENSHOT_PATTERN
        : toPatternSource(options.pattern),
      options,
    );
  }

  destroy(options: ExecutionWorkflowStepOptions = {}): this {
    return this.appendCheck(
      options.id ?? 'destroy',
      options.description ?? 'Destroy the session after verification.',
      options.pattern === undefined
        ? DESTROY_SESSION_PATTERN
        : toPatternSource(options.pattern),
      options,
    );
  }

  raw(check: WorkflowCheck): this {
    this.workflowBuilder.raw(check);
    this.lastStepId = check.id;
    return this;
  }

  rawWorkflowCheck(check: WorkflowCheck): this {
    return this.raw(check);
  }

  private appendCheck(
    id: string,
    description: string,
    requiredPattern: string,
    options: ExecutionWorkflowStepOptions,
  ): this {
    const dependsOn = resolveDependsOn(this.lastStepId, options.dependsOn);
    this.workflowBuilder.raw(
      workflowCheck(id, description, requiredPattern, {
        ...(dependsOn === undefined ? {} : { dependsOn }),
        ...(options.required === undefined
          ? {}
          : { required: options.required }),
        ...(options.weight === undefined ? {} : { weight: options.weight }),
        ...(options.forbiddenPattern === undefined
          ? {}
          : { forbiddenPattern: toPatternSource(options.forbiddenPattern) }),
      }),
    );
    this.lastStepId = id;
    return this;
  }
}

export class ExecutionAssertionBuilder {
  private readonly addVerifier: (verifier: VerifierSpec) => void;

  constructor(addVerifier: (verifier: VerifierSpec) => void) {
    this.addVerifier = addVerifier;
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

  snapshot(
    id: string,
    description: string,
    config: Record<string, unknown>,
  ): this {
    return this.verifier(id, 'snapshot', description, config);
  }

  screenshot(
    id: string,
    description: string,
    config: Record<string, unknown>,
  ): this {
    return this.verifier(id, 'screenshot', description, config);
  }

  eventLog(
    id: string,
    description: string,
    config: Record<string, unknown>,
  ): this {
    return this.verifier(id, 'event-log', description, config);
  }

  json(id: string, description: string, config: Record<string, unknown>): this {
    return this.verifier(id, 'json', description, config);
  }

  command(
    id: string,
    description: string,
    config: Record<string, unknown>,
  ): this {
    return this.verifier(id, 'command', description, config);
  }

  custom(
    id: string,
    description: string,
    validator: string,
    config: Record<string, unknown>,
  ): this {
    this.addVerifier(customVerifier(id, description, validator, config));
    return this;
  }

  snapshotContains(...patterns: PatternInput[]): this {
    return this.snapshot(
      'snapshot-contains',
      'The snapshot should contain the required content patterns.',
      {
        patterns: patterns.map((pattern) => toPatternSource(pattern)),
      },
    );
  }

  raw(verifier: VerifierSpec): this {
    this.addVerifier(verifier);
    return this;
  }

  rawVerifier(verifier: VerifierSpec): this {
    return this.raw(verifier);
  }
}

export class ExecutionCaseBuilder {
  private readonly id: string;
  private categoryValue?: ExecutionEvalCase['category'];
  private taskValue?: string;
  private fixtureValue?: ExecutionFixtureDraft;
  private targetValue?: string;
  private conditionsValue: SkillCondition[] = [...ALL_EXECUTION_CONDITIONS];
  private referenceStepsValue?: number;
  private readonly workflowBuilder: WorkflowBuilder;
  private readonly executionWorkflowBuilder: ExecutionWorkflowBuilder;
  private readonly verifiersValue: VerifierSpec[] = [];
  private readonly verifierIds = new Set<string>();
  private readonly artifactRequirementsValue: ArtifactRequirement[] = [];
  private antiPatternExtraRulesValue: AntiPatternRule[] = [];
  private budgetOverridesValue: Partial<ExecutionEvalCase['budgets']> = {};
  private workflowUsed = false;

  constructor(id: string) {
    this.id = id;
    this.workflowBuilder = new WorkflowBuilder({
      lane: 'execution',
      caseId: id,
      defaultRequired: false,
    });
    this.executionWorkflowBuilder = new ExecutionWorkflowBuilder(
      this.workflowBuilder,
    );
  }

  category(category: ExecutionEvalCase['category']): this {
    this.categoryValue = category;
    return this;
  }

  fixture(fixture: string, options: FixtureOptions = {}): this {
    this.fixtureValue = {
      fixture,
      setupId: options.setupId ?? `launch-${fixture}`,
      setupDescription:
        options.setupDescription ??
        `Create an agent-tty session that runs the ${fixture} fixture.`,
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
    };
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

  conditions(...conditions: SkillCondition[]): this {
    this.conditionsValue = [...conditions];
    return this;
  }

  referenceSteps(referenceSteps: number): this {
    this.referenceStepsValue = referenceSteps;
    return this;
  }

  workflow(callback: (workflow: ExecutionWorkflowBuilder) => unknown): this {
    this.workflowUsed = true;
    callback(this.executionWorkflowBuilder);
    return this;
  }

  rawWorkflowCheck(check: WorkflowCheck): this {
    this.executionWorkflowBuilder.rawWorkflowCheck(check);
    return this;
  }

  assertions(
    callback: (assertions: ExecutionAssertionBuilder) => unknown,
  ): this {
    callback(
      new ExecutionAssertionBuilder((verifier) => this.addVerifier(verifier)),
    );
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

  rawVerifier(verifier: VerifierSpec): this {
    this.addVerifier(verifier);
    return this;
  }

  artifact(
    kind: ArtifactKind,
    description: string,
    pathPattern: PatternInput,
    minCount = 1,
  ): this {
    this.artifactRequirementsValue.push(
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
    this.artifactRequirementsValue.push(
      cloneValue(requirement, 'execution', this.id, 'artifactRequirements'),
    );
    return this;
  }

  antiPatterns(...extraRules: AntiPatternRule[]): this {
    this.antiPatternExtraRulesValue = cloneValue(
      extraRules,
      'execution',
      this.id,
      'antiPatterns',
    );
    return this;
  }

  budget(overrides: Partial<ExecutionEvalCase['budgets']>): this {
    this.budgetOverridesValue = {
      ...this.budgetOverridesValue,
      ...overrides,
    };
    return this;
  }

  build(): ExecutionEvalCase {
    const category = assertDefined(
      this.categoryValue,
      'execution',
      this.id,
      'category',
      'category is required',
    );
    const task = assertDefined(
      this.taskValue,
      'execution',
      this.id,
      'prompt',
      'task is required',
    );
    assertCase(
      this.fixtureValue !== undefined || this.targetValue !== undefined,
      'execution',
      this.id,
      'fixture',
      'fixture or target is required',
    );
    assertCase(
      this.conditionsValue.length > 0,
      'execution',
      this.id,
      'conditions',
      'conditions must include at least one skill condition',
    );
    assertCase(
      this.verifiersValue.length > 0,
      'execution',
      this.id,
      'verifiers',
      'verifiers must include at least one verifier',
    );

    const workflowChecks = this.workflowBuilder.build();
    assertCase(
      !this.workflowUsed || workflowChecks.length > 0,
      'execution',
      this.id,
      'workflowChecks',
      'workflow() must add at least one workflow check',
    );

    const setup =
      this.fixtureValue === undefined
        ? []
        : [
            fixtureSetupStep(
              this.fixtureValue.setupId,
              this.fixtureValue.fixture,
              this.fixtureValue.setupDescription,
              this.fixtureValue.timeoutMs,
            ),
          ];

    const compiled: ExecutionEvalCase = {
      id: this.id,
      lane: 'execution',
      category,
      prompt: executionTaskPrompt(task, this.fixtureValue?.fixture),
      expectedSkill: 'agent-tty',
      conditions: [...this.conditionsValue],
      setup,
      verifiers: cloneValue(
        this.verifiersValue,
        'execution',
        this.id,
        'verifiers',
      ),
      workflowChecks,
      antiPatterns: executionAntiPatterns(...this.antiPatternExtraRulesValue),
      artifactRequirements: cloneValue(
        this.artifactRequirementsValue,
        'execution',
        this.id,
        'artifactRequirements',
      ),
      budgets: executionBudgets(this.budgetOverridesValue),
    };
    if (this.fixtureValue !== undefined) {
      compiled.fixture = this.fixtureValue.fixture;
    }
    if (this.targetValue !== undefined) {
      compiled.target = this.targetValue;
    }
    if (this.referenceStepsValue !== undefined) {
      compiled.referenceSteps = this.referenceStepsValue;
    }

    return compileAndValidate(
      'execution',
      this.id,
      ExecutionEvalCaseSchema,
      compiled,
    );
  }

  private addVerifier(verifier: VerifierSpec): void {
    assertUniqueId(
      this.verifierIds,
      verifier.id,
      'execution',
      this.id,
      'verifiers',
      'verifier id',
    );
    this.verifiersValue.push(
      cloneValue(verifier, 'execution', this.id, `verifiers.${verifier.id}`),
    );
  }
}

export function executionCase(id: string): ExecutionCaseBuilder {
  return new ExecutionCaseBuilder(id);
}

export {
  ALL_EXECUTION_CONDITIONS,
  CREATE_SESSION_PATTERN,
  DESTROY_SESSION_PATTERN,
  RUN_PATTERN,
  SCREENSHOT_PATTERN,
  SNAPSHOT_PATTERN,
  TYPE_PATTERN,
  WAIT_PATTERN,
  anyOf,
};
