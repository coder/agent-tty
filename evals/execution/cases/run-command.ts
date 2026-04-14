import type { AntiPatternRule } from '../../lib/types.js';

import {
  ALL_EXECUTION_CONDITIONS,
  CREATE_SESSION_PATTERN,
  SNAPSHOT_PATTERN,
  TYPE_PATTERN,
  WAIT_PATTERN,
  anyOf,
  createExecutionCase,
  executionAntiPatterns,
  executionBudgets,
  fixtureSetupStep,
  requiredVerifier,
  workflowCheck,
} from './shared.js';

const NO_SIMULATED_TYPING_RULE: AntiPatternRule = {
  id: 'no-simulated-typing',
  severity: 'error',
  description:
    'Detected simulated typing instead of agent-tty run for the run-command execution case.',
  patterns: [TYPE_PATTERN],
  suggestedFix:
    'Use agent-tty run to send the command payload instead of typing it character-by-character.',
  lanes: ['execution'],
};

const RUN_COMMAND_PATTERN = anyOf(
  String.raw`\bagent-tty\b[^\n]*\brun\b[^\n]*echo test`,
  String.raw`\brun(?:ning|s|ned)?\b[^\n]*echo test\b`,
  String.raw`ECHO:\s*echo test`,
);

export const runCommandCase = createExecutionCase({
  id: 'run-command',
  lane: 'execution',
  category: 'session',
  prompt:
    "Launch hello-prompt, use the 'run' command to send 'echo test' instead of typing, wait for the output, and capture a snapshot.",
  expectedSkill: 'agent-tty',
  fixture: 'hello-prompt',
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
      'Use agent-tty run instead of typing the command.',
      RUN_COMMAND_PATTERN,
      {
        dependsOn: ['create'],
        forbiddenPattern: TYPE_PATTERN,
      },
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
  antiPatterns: executionAntiPatterns(NO_SIMULATED_TYPING_RULE),
  artifactRequirements: [],
  budgets: executionBudgets({
    timeoutMs: 45_000,
    maxAgentSteps: 12,
    maxWallClockMs: 60_000,
  }),
});
