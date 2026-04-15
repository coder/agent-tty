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

const RUN_COMMAND_PATTERN = anyOf(
  String.raw`\bagent-tty\b[^\n]*\b(?:run|type|send-keys|paste)\b[^\n]*echo test`,
  String.raw`\b(?:run|type|send-keys|paste)(?:ning|s|ned|d|ing)?\b[^\n]*echo test\b`,
  String.raw`ECHO:\s*echo test`,
);

export const runCommandCase = createExecutionCase({
  id: 'run-command',
  lane: 'execution',
  category: 'session',
  prompt: executionTaskPrompt(
    "Launch hello-prompt, use the 'run' command to send 'echo test' instead of typing, wait for the output, and capture a snapshot.",
    'hello-prompt',
  ),
  expectedSkill: 'agent-tty',
  fixture: 'hello-prompt',
  referenceSteps: 5,
  conditions: [...ALL_EXECUTION_CONDITIONS],
  setup: [
    fixtureSetupStep(
      'launch-run-command',
      'hello-prompt',
      'Create an agent-tty session that runs the hello-prompt fixture.',
    ),
  ],
  verifiers: [
    requiredVerifier(
      'run-command-snapshot',
      'snapshot',
      'The transcript snapshot should show the literal run payload echoed back by the fixture.',
      {
        patterns: [String.raw`ECHO:\s*echo test`, String.raw`READY>`],
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
      'run',
      'Send the command payload via any programmatic method.',
      RUN_COMMAND_PATTERN,
      { dependsOn: ['create'] },
    ),
    workflowCheck(
      'wait',
      'Wait for the run payload to be echoed.',
      anyOf(WAIT_PATTERN, String.raw`ECHO:\s*echo test[\s\S]*READY>`),
      { dependsOn: ['run'] },
    ),
    workflowCheck(
      'snapshot',
      'Capture a snapshot for verification.',
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
