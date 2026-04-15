import {
  ALL_EXECUTION_CONDITIONS,
  CREATE_SESSION_PATTERN,
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

export const scrollbackDemoCase = createExecutionCase({
  id: 'scrollback-demo',
  lane: 'execution',
  category: 'tui',
  prompt: executionTaskPrompt(
    'Launch scrollback-demo, wait for the output to fill the buffer, and take a snapshot that proves scrollback content was captured.',
    'scrollback-demo',
  ),
  expectedSkill: 'agent-tty',
  fixture: 'scrollback-demo',
  referenceSteps: 4,
  conditions: [...ALL_EXECUTION_CONDITIONS],
  setup: [
    fixtureSetupStep(
      'launch-scrollback-demo',
      'scrollback-demo',
      'Create an agent-tty session that runs the scrollback-demo fixture.',
    ),
  ],
  verifiers: [
    requiredVerifier(
      'scrollback-snapshot',
      'snapshot',
      'The captured snapshot should include early and late scrollback lines.',
      {
        patterns: [
          String.raw`LINE\s+001`,
          String.raw`LINE\s+080`,
          String.raw`SCROLLBACK COMPLETE`,
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
      'Wait until the scrollback fixture has emitted its full buffer.',
      anyOf(WAIT_PATTERN, String.raw`SCROLLBACK COMPLETE`),
      { dependsOn: ['create'] },
    ),
    workflowCheck(
      'snapshot',
      'Capture a snapshot that includes scrollback evidence.',
      SNAPSHOT_PATTERN,
      { dependsOn: ['wait'] },
    ),
  ],
  antiPatterns: executionAntiPatterns(),
  artifactRequirements: [],
  budgets: executionBudgets({
    timeoutMs: 120_000,
    maxAgentSteps: 10,
    maxWallClockMs: 60_000,
  }),
});
