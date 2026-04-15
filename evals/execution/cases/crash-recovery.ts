import {
  ALL_EXECUTION_CONDITIONS,
  CREATE_SESSION_PATTERN,
  DESTROY_SESSION_PATTERN,
  INSPECT_PATTERN,
  createExecutionCase,
  executionAntiPatterns,
  executionBudgets,
  executionTaskPrompt,
  fixtureSetupStep,
  workflowCheck,
} from './shared.js';

export const crashRecoveryCase = createExecutionCase({
  id: 'crash-recovery',
  lane: 'execution',
  category: 'recovery',
  prompt: executionTaskPrompt(
    'Launch crash-demo, wait for it to exit with code 1, inspect the session status, and then destroy or otherwise clean up the crashed session.',
    'crash-demo',
  ),
  expectedSkill: 'agent-tty',
  fixture: 'crash-demo',
  conditions: [...ALL_EXECUTION_CONDITIONS],
  setup: [
    fixtureSetupStep(
      'launch-crash-demo',
      'crash-demo',
      'Create an agent-tty session that runs the crash-demo fixture.',
    ),
  ],
  verifiers: [
    {
      id: 'crash-demo-exit-code',
      kind: 'command',
      description:
        'The crashed fixture should be observed with exit code 1 when the session metadata is available.',
      required: false,
      config: {
        expectedExitCode: 1,
      },
    },
    {
      id: 'crash-demo-status-observed',
      kind: 'snapshot',
      description:
        'The transcript should show that the crashed session status was inspected.',
      required: true,
      config: {
        patterns: [String.raw`exited|failed|exit.code|exitCode|status`],
      },
    },
  ],
  workflowChecks: [
    workflowCheck(
      'create',
      'Create the fixture session.',
      CREATE_SESSION_PATTERN,
    ),
    workflowCheck(
      'inspect',
      'Inspect the crashed session status before cleanup.',
      INSPECT_PATTERN,
      { dependsOn: ['create'] },
    ),
    workflowCheck(
      'destroy',
      'Destroy or clean up the crashed session.',
      DESTROY_SESSION_PATTERN,
      { dependsOn: ['inspect'] },
    ),
  ],
  antiPatterns: executionAntiPatterns(),
  artifactRequirements: [],
  budgets: executionBudgets({
    timeoutMs: 180_000,
    maxAgentSteps: 12,
    maxWallClockMs: 75_000,
  }),
});
