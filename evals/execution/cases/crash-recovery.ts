import {
  ALL_EXECUTION_CONDITIONS,
  CREATE_SESSION_PATTERN,
  DESTROY_SESSION_PATTERN,
  INSPECT_PATTERN,
  createExecutionCase,
  executionAntiPatterns,
  executionBudgets,
  fixtureSetupStep,
  requiredVerifier,
  workflowCheck,
} from './shared.js';

export const crashRecoveryCase = createExecutionCase({
  id: 'crash-recovery',
  lane: 'execution',
  category: 'recovery',
  prompt:
    'Launch crash-demo, wait for it to exit with code 1, inspect the session status, and then destroy or otherwise clean up the crashed session.',
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
    requiredVerifier(
      'crash-demo-exit-code',
      'command',
      'The crashed fixture should be observed with exit code 1.',
      {
        expectedExitCode: 1,
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
    timeoutMs: 60_000,
    maxAgentSteps: 12,
    maxWallClockMs: 75_000,
  }),
});
