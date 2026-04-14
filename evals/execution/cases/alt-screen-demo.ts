import {
  ALL_EXECUTION_CONDITIONS,
  CREATE_SESSION_PATTERN,
  DESTROY_SESSION_PATTERN,
  SNAPSHOT_PATTERN,
  createExecutionCase,
  executionAntiPatterns,
  executionBudgets,
  executionTaskPrompt,
  fixtureSetupStep,
  requiredVerifier,
  workflowCheck,
} from './shared.js';

export const altScreenDemoCase = createExecutionCase({
  id: 'alt-screen-demo',
  lane: 'execution',
  category: 'tui',
  prompt: executionTaskPrompt(
    'Launch alt-screen-demo, observe the alt-screen transition, and capture snapshots at each stage so the main-screen restore is documented before destroying the session.',
    'alt-screen-demo',
  ),
  expectedSkill: 'agent-tty',
  fixture: 'alt-screen-demo',
  conditions: [...ALL_EXECUTION_CONDITIONS],
  setup: [
    fixtureSetupStep(
      'launch-alt-screen-demo',
      'alt-screen-demo',
      'Create an agent-tty session that runs the alt-screen-demo fixture.',
    ),
  ],
  verifiers: [
    requiredVerifier(
      'alt-screen-events',
      'event-log',
      'The event log should capture the output that enters the alt screen and returns to the main screen.',
      {
        requiredEventTypes: ['output'],
        requiredOutputPatterns: [
          String.raw`MAIN SCREEN READY`,
          String.raw`ALT SCREEN ACTIVE`,
          String.raw`BACK ON MAIN SCREEN`,
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
      'snapshot',
      'Capture snapshot evidence across the alt-screen flow.',
      SNAPSHOT_PATTERN,
      { dependsOn: ['create'] },
    ),
    workflowCheck(
      'destroy',
      'Destroy the session after collecting evidence.',
      DESTROY_SESSION_PATTERN,
      { dependsOn: ['snapshot'] },
    ),
  ],
  antiPatterns: executionAntiPatterns(),
  artifactRequirements: [],
  budgets: executionBudgets({
    timeoutMs: 60_000,
    maxAgentSteps: 14,
    maxWallClockMs: 75_000,
  }),
});
