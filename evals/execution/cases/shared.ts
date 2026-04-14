import type { ArtifactKind } from '../../../src/tools/review-bundle.js';
import { invariant } from '../../../src/util/assert.js';
import { DEFAULT_ANTI_PATTERN_RULES } from '../../lib/antiPatterns.js';
import { fixtureCommand } from '../../lib/cliHarness.js';
import { SKILL_CONDITIONS } from '../../lib/matrix.js';
import { ExecutionEvalCaseSchema } from '../../lib/schemas.js';
import type {
  AntiPatternRule,
  ArtifactRequirement,
  ExecutionEvalCase,
  SetupStep,
  SkillCondition,
  VerifierKind,
  VerifierSpec,
  WorkflowCheck,
} from '../../lib/types.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_AGENT_STEPS = 16;
const DEFAULT_MAX_WALL_CLOCK_MS = 90_000;

export const ALL_EXECUTION_CONDITIONS: SkillCondition[] = [...SKILL_CONDITIONS];

export function anyOf(...patterns: string[]): string {
  invariant(patterns.length > 0, 'anyOf() requires at least one pattern');
  return `(?:${patterns.join('|')})`;
}

export function ordered(...patterns: string[]): string {
  invariant(patterns.length > 0, 'ordered() requires at least one pattern');
  return patterns.map((pattern) => `(?:${pattern})`).join('[\\s\\S]*?');
}

export const CREATE_SESSION_PATTERN = anyOf(
  String.raw`\bagent-tty\b[^\n]*\bcreate\b`,
  String.raw`\bcreate(?:d|ing)?\b[^\n]*\bsession\b`,
);
export const DESTROY_SESSION_PATTERN = anyOf(
  String.raw`\bagent-tty\b[^\n]*\b(?:destroy|kill)\b`,
  String.raw`\b(?:destroy|kill|cleanup)(?:ed|ing)?\b[^\n]*\bsession\b`,
);
export const WAIT_PATTERN = anyOf(
  String.raw`\bagent-tty\b[^\n]*\bwait\b`,
  String.raw`\bwait(?:ed|ing)?\b`,
);
export const SNAPSHOT_PATTERN = anyOf(
  String.raw`\bagent-tty\b[^\n]*\bsnapshot\b`,
  String.raw`\bsnapshot(?:ed|ting)?\b`,
);
export const SCREENSHOT_PATTERN = anyOf(
  String.raw`\bagent-tty\b[^\n]*\bscreenshot\b`,
  String.raw`\bscreenshot(?:ed|ting)?\b`,
);
export const RESIZE_PATTERN = anyOf(
  String.raw`\bagent-tty\b[^\n]*\bresize\b`,
  String.raw`\bresize(?:d|ing)?\b`,
);
export const INSPECT_PATTERN = anyOf(
  String.raw`\bagent-tty\b[^\n]*\binspect\b`,
  String.raw`\binspect(?:ed|ing)?\b[^\n]*\bsession\b`,
  String.raw`\bsession\b[^\n]*\bstatus\b`,
);
export const RUN_PATTERN = anyOf(
  String.raw`\bagent-tty\b[^\n]*\brun\b`,
  String.raw`\brun(?:ning|s|ned)?\b`,
);
export const TYPE_PATTERN = anyOf(
  String.raw`\bagent-tty\b[^\n]*\btype\b`,
  String.raw`\btype(?:d|ing)?\b`,
  String.raw`\bsend-keys\b`,
);
export const RECORD_EXPORT_PATTERN = anyOf(
  String.raw`\bagent-tty\b[^\n]*\brecord\b[^\n]*\bexport\b`,
  String.raw`\brecord(?:ing)?\b[^\n]*\bexport\b`,
);
export const DOCTOR_JSON_PATTERN = anyOf(
  String.raw`\bagent-tty\b[^\n]*\bdoctor\b[^\n]*--json\b`,
  String.raw`\bdoctor\b[^\n]*--json\b`,
);

interface WorkflowCheckOptions {
  forbiddenPattern?: string;
  dependsOn?: string[];
  weight?: number;
  required?: boolean;
}

function cloneAntiPatternRule(rule: AntiPatternRule): AntiPatternRule {
  return {
    ...rule,
    ...(rule.lanes === undefined ? {} : { lanes: [...rule.lanes] }),
  };
}

export function executionAntiPatterns(
  ...extraRules: AntiPatternRule[]
): AntiPatternRule[] {
  return [
    ...DEFAULT_ANTI_PATTERN_RULES.map((rule) => cloneAntiPatternRule(rule)),
    ...extraRules.map((rule) => cloneAntiPatternRule(rule)),
  ];
}

export function fixtureSetupStep(
  id: string,
  fixture: string,
  description: string,
  timeoutMs = 30_000,
): SetupStep {
  const fixtureCommandSegments = fixtureCommand(fixture);
  const [command, ...argv] = fixtureCommandSegments;

  invariant(
    command !== undefined,
    `fixtureCommand(${fixture}) must include a command`,
  );

  return {
    id,
    description,
    command,
    argv,
    timeoutMs,
  };
}

export function requiredVerifier(
  id: string,
  kind: VerifierKind,
  description: string,
  config: Record<string, unknown>,
): VerifierSpec {
  return {
    id,
    kind,
    description,
    required: true,
    config,
  };
}

export function customVerifier(
  id: string,
  description: string,
  validator: string,
  config: Record<string, unknown>,
): VerifierSpec {
  return requiredVerifier(id, 'custom', description, {
    validator,
    ...config,
  });
}

export function workflowCheck(
  id: string,
  description: string,
  requiredPattern: string,
  options: WorkflowCheckOptions = {},
): WorkflowCheck {
  return {
    id,
    description,
    required: options.required ?? true,
    requiredPatterns: [requiredPattern],
    forbiddenPatterns:
      options.forbiddenPattern === undefined ? [] : [options.forbiddenPattern],
    dependsOn: [...(options.dependsOn ?? [])],
    ...(options.weight === undefined ? {} : { weight: options.weight }),
  };
}

export function artifactRequirement(
  kind: ArtifactKind,
  description: string,
  pathPattern: string,
  minCount = 1,
): ArtifactRequirement {
  return {
    kind,
    required: true,
    description,
    minCount,
    pathPatterns: [pathPattern],
  };
}

export function executionBudgets(
  overrides: Partial<ExecutionEvalCase['budgets']> = {},
): ExecutionEvalCase['budgets'] {
  return {
    timeoutMs: overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxAgentSteps: overrides.maxAgentSteps ?? DEFAULT_MAX_AGENT_STEPS,
    maxWallClockMs: overrides.maxWallClockMs ?? DEFAULT_MAX_WALL_CLOCK_MS,
  };
}

export function createExecutionCase(
  definition: ExecutionEvalCase,
): ExecutionEvalCase {
  ExecutionEvalCaseSchema.parse(definition);
  return definition;
}
