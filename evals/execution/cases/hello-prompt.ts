import {
  ALL_EXECUTION_CONDITIONS,
  CREATE_SESSION_PATTERN,
  DESTROY_SESSION_PATTERN,
  SNAPSHOT_PATTERN,
  WAIT_PATTERN,
  anyOf,
  createExecutionCase,
  executionAntiPatterns,
  executionBudgets,
  fixtureSetupStep,
  requiredVerifier,
  workflowCheck,
} from './shared.js';

const HELLO_WORLD_INPUT_PATTERN = anyOf(
  String.raw`\bagent-tty\b[^\n]*\b(?:run|type)\b[^\n]*hello world`,
  String.raw`\b(?:run|type)(?:ning|s|ned)?\b[^\n]*hello world\b`,
  String.raw`ECHO:\s*hello world`,
);

export const helloPromptCase = createExecutionCase({
  id: 'hello-prompt',
  lane: 'execution',
  category: 'session',
  prompt:
    "Launch the hello-prompt fixture, send 'hello world' as input, wait for the READY> prompt to reappear, take a snapshot to verify the echo, then destroy the session.",
  expectedSkill: 'agent-tty',
  fixture: 'hello-prompt',
  conditions: [...ALL_EXECUTION_CONDITIONS],
  setup: [
    fixtureSetupStep(
      'launch-hello-prompt',
      'hello-prompt',
      'Create an agent-tty session that runs the hello-prompt fixture.',
    ),
  ],
  verifiers: [
    requiredVerifier(
      'hello-prompt-snapshot',
      'snapshot',
      'The transcript snapshot should include the echoed text and the READY prompt.',
      {
        patterns: [String.raw`ECHO:\s*hello world`, String.raw`READY>`],
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
      'input',
      'Send hello world with run or type.',
      HELLO_WORLD_INPUT_PATTERN,
      { dependsOn: ['create'] },
    ),
    workflowCheck(
      'wait',
      'Wait for the READY prompt to reappear after the echo.',
      anyOf(WAIT_PATTERN, String.raw`ECHO:\s*hello world[\s\S]*READY>`),
      { dependsOn: ['input'] },
    ),
    workflowCheck(
      'snapshot',
      'Capture a snapshot for verification.',
      SNAPSHOT_PATTERN,
      { dependsOn: ['wait'] },
    ),
    workflowCheck(
      'destroy',
      'Destroy the session after verification.',
      DESTROY_SESSION_PATTERN,
      { dependsOn: ['snapshot'] },
    ),
  ],
  antiPatterns: executionAntiPatterns(),
  artifactRequirements: [],
  budgets: executionBudgets({
    timeoutMs: 45_000,
    maxAgentSteps: 12,
    maxWallClockMs: 60_000,
  }),
});
