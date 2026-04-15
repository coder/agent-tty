import {
  ALL_EXECUTION_CONDITIONS,
  CREATE_SESSION_PATTERN,
  SCREENSHOT_PATTERN,
  SNAPSHOT_PATTERN,
  WAIT_PATTERN,
  anyOf,
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
    'Launch color-grid, wait for the fixture to render, and capture either a screenshot or a text snapshot of the color output for review.',
    'color-grid',
  ),
  expectedSkill: 'agent-tty',
  fixture: 'color-grid',
  referenceSteps: 4,
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
      'color-grid-evidence',
      'snapshot',
      'The transcript should contain either screenshot evidence or a text snapshot of the rendered color grid.',
      {
        patterns: [
          String.raw`(?:${SCREENSHOT_PATTERN}|(?:${SNAPSHOT_PATTERN}[\s\S]*?(?:COLOR GRID FIXTURE|Basic background colors|Bright background colors|256-color sample backgrounds|Truecolor sample backgrounds|Foreground sample labels|COLOR GRID COMPLETE)))`,
        ],
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
      'capture-evidence',
      'Capture either a screenshot or a text snapshot of the rendered color grid.',
      anyOf(SCREENSHOT_PATTERN, SNAPSHOT_PATTERN),
      { dependsOn: ['wait'] },
    ),
  ],
  antiPatterns: executionAntiPatterns(),
  artifactRequirements: [
    {
      kind: 'screenshot',
      required: false,
      description:
        'A PNG screenshot should be saved for reviewer inspection when renderer support is available.',
      minCount: 1,
      pathPatterns: [String.raw`\.png$`],
    },
  ],
  budgets: executionBudgets({
    timeoutMs: 180_000,
    maxAgentSteps: 10,
    maxWallClockMs: 60_000,
  }),
});
