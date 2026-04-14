import {
  ALL_EXECUTION_CONDITIONS,
  CREATE_SESSION_PATTERN,
  DOCTOR_JSON_PATTERN,
  SCREENSHOT_PATTERN,
  artifactRequirement,
  createExecutionCase,
  executionAntiPatterns,
  executionBudgets,
  executionTaskPrompt,
  fixtureSetupStep,
  ordered,
  requiredVerifier,
  workflowCheck,
} from './shared.js';

export const doctorGatedCase = createExecutionCase({
  id: 'doctor-gated',
  lane: 'execution',
  category: 'artifact',
  prompt: executionTaskPrompt(
    'Before capturing a screenshot, run doctor --json to verify renderer prerequisites and then capture a screenshot of hello-prompt.',
    'hello-prompt',
  ),
  expectedSkill: 'agent-tty',
  fixture: 'hello-prompt',
  conditions: [...ALL_EXECUTION_CONDITIONS],
  setup: [
    fixtureSetupStep(
      'launch-doctor-gated',
      'hello-prompt',
      'Create an agent-tty session that runs the hello-prompt fixture.',
    ),
  ],
  verifiers: [
    requiredVerifier(
      'doctor-gated-screenshot',
      'screenshot',
      'A screenshot artifact should be produced after the doctor check passes.',
      {
        kind: 'screenshot',
      },
    ),
  ],
  workflowChecks: [
    workflowCheck(
      'create',
      'Create the fixture session.',
      CREATE_SESSION_PATTERN,
    ),
    workflowCheck(
      'doctor',
      'Run doctor --json before any renderer-dependent capture.',
      DOCTOR_JSON_PATTERN,
      { dependsOn: ['create'] },
    ),
    workflowCheck(
      'screenshot',
      'Capture the screenshot only after the doctor gate.',
      ordered(DOCTOR_JSON_PATTERN, SCREENSHOT_PATTERN),
      { dependsOn: ['doctor'] },
    ),
  ],
  antiPatterns: executionAntiPatterns(),
  artifactRequirements: [
    artifactRequirement(
      'screenshot',
      'A PNG screenshot should be saved after the doctor check.',
      String.raw`\.png$`,
    ),
  ],
  budgets: executionBudgets({
    timeoutMs: 60_000,
    maxAgentSteps: 14,
    maxWallClockMs: 75_000,
  }),
});
