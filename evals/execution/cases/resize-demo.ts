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

const RESIZE_TO_TARGET_PATTERN = anyOf(
  String.raw`\bagent-tty\b[^\n]*\bresize\b[^\n]*100[^\n]*30`,
  String.raw`\bresize(?:d|ing)?\b[^\n]*100[^\n]*30`,
  String.raw`SIZE:\s*100x30`,
);

export const resizeDemoCase = createExecutionCase({
  id: 'resize-demo',
  lane: 'execution',
  category: 'tui',
  prompt: executionTaskPrompt(
    'Launch resize-demo, verify the initial size, resize the session to 100x30, wait for the SIZE output to update, and take a snapshot to confirm the change.',
    'resize-demo',
  ),
  expectedSkill: 'agent-tty',
  fixture: 'resize-demo',
  conditions: [...ALL_EXECUTION_CONDITIONS],
  setup: [
    fixtureSetupStep(
      'launch-resize-demo',
      'resize-demo',
      'Create an agent-tty session that runs the resize-demo fixture.',
    ),
  ],
  verifiers: [
    requiredVerifier(
      'resize-demo-snapshot',
      'snapshot',
      'The transcript snapshot should confirm the resized terminal dimensions.',
      {
        patterns: [String.raw`SIZE:\s*(?:100x30|100.*30)`],
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
      'resize',
      'Resize the terminal to 100 columns by 30 rows.',
      RESIZE_TO_TARGET_PATTERN,
      { dependsOn: ['create'] },
    ),
    workflowCheck(
      'wait',
      'Wait for the fixture to report the resized terminal dimensions.',
      anyOf(WAIT_PATTERN, String.raw`SIZE:\s*100x30`),
      { dependsOn: ['resize'] },
    ),
    workflowCheck(
      'snapshot',
      'Capture a snapshot after the resize settles.',
      SNAPSHOT_PATTERN,
      { dependsOn: ['wait'] },
    ),
  ],
  antiPatterns: executionAntiPatterns(),
  artifactRequirements: [],
  budgets: executionBudgets({
    timeoutMs: 120_000,
    maxAgentSteps: 12,
    maxWallClockMs: 60_000,
  }),
});
