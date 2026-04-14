import {
  ALL_EXECUTION_CONDITIONS,
  CREATE_SESSION_PATTERN,
  DESTROY_SESSION_PATTERN,
  SNAPSHOT_PATTERN,
  createExecutionCase,
  executionAntiPatterns,
  executionBudgets,
  fixtureSetupStep,
  requiredVerifier,
  workflowCheck,
} from './shared.js';

export const unicodeGridCase = createExecutionCase({
  id: 'unicode-grid',
  lane: 'execution',
  category: 'artifact',
  prompt:
    'Launch unicode-grid, capture a semantic snapshot to verify Unicode rendering, then destroy the session.',
  expectedSkill: 'agent-tty',
  fixture: 'unicode-grid',
  conditions: [...ALL_EXECUTION_CONDITIONS],
  setup: [
    fixtureSetupStep(
      'launch-unicode-grid',
      'unicode-grid',
      'Create an agent-tty session that runs the unicode-grid fixture.',
    ),
  ],
  verifiers: [
    requiredVerifier(
      'unicode-grid-snapshot',
      'snapshot',
      'The semantic snapshot should preserve the Unicode fixture markers and glyphs.',
      {
        patterns: [
          String.raw`UNICODE GRID FIXTURE`,
          String.raw`┌─┐`,
          String.raw`漢字`,
          String.raw`UNICODE GRID COMPLETE`,
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
      'Capture a semantic snapshot of the Unicode fixture.',
      SNAPSHOT_PATTERN,
      { dependsOn: ['create'] },
    ),
    workflowCheck(
      'destroy',
      'Destroy the session after snapshot verification.',
      DESTROY_SESSION_PATTERN,
      { dependsOn: ['snapshot'] },
    ),
  ],
  antiPatterns: executionAntiPatterns(),
  artifactRequirements: [],
  budgets: executionBudgets({
    timeoutMs: 45_000,
    maxAgentSteps: 10,
    maxWallClockMs: 60_000,
  }),
});
