import {
  ALL_EXECUTION_CONDITIONS,
  CREATE_SESSION_PATTERN,
  SCREENSHOT_PATTERN,
  WAIT_PATTERN,
  anyOf,
  artifactRequirement,
  createExecutionCase,
  executionAntiPatterns,
  executionBudgets,
  executionTaskPrompt,
  fixtureSetupStep,
  requiredVerifier,
  workflowCheck,
} from './shared.js';

export const colorGridCase = createExecutionCase({
  id: 'color-grid',
  lane: 'execution',
  category: 'artifact',
  prompt: executionTaskPrompt(
    'Launch color-grid, wait for the fixture to render, and capture a screenshot of the color output for review.',
    'color-grid',
  ),
  expectedSkill: 'agent-tty',
  fixture: 'color-grid',
  conditions: [...ALL_EXECUTION_CONDITIONS],
  setup: [
    fixtureSetupStep(
      'launch-color-grid',
      'color-grid',
      'Create an agent-tty session that runs the color-grid fixture.',
    ),
  ],
  verifiers: [
    requiredVerifier(
      'color-grid-screenshot',
      'screenshot',
      'A screenshot artifact should exist for the rendered color grid.',
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
      'wait',
      'Wait for the color fixture to finish rendering before capture.',
      anyOf(WAIT_PATTERN, String.raw`COLOR GRID COMPLETE`),
      { dependsOn: ['create'] },
    ),
    workflowCheck(
      'screenshot',
      'Capture a screenshot of the rendered color grid.',
      SCREENSHOT_PATTERN,
      { dependsOn: ['wait'] },
    ),
  ],
  antiPatterns: executionAntiPatterns(),
  artifactRequirements: [
    artifactRequirement(
      'screenshot',
      'A PNG screenshot should be saved for reviewer inspection.',
      String.raw`\.png$`,
    ),
  ],
  budgets: executionBudgets({
    timeoutMs: 180_000,
    maxAgentSteps: 10,
    maxWallClockMs: 60_000,
  }),
});
