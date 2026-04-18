import { executionCase } from '../../authoring/index.js';
import { ALL_EXECUTION_CONDITIONS, anyOf } from './shared.js';

const HELLO_WORLD_INPUT_PATTERN = anyOf(
  String.raw`\bagent-tty\b[^\n]*\b(?:run|type)\b[^\n]*hello world`,
  String.raw`\b(?:run|type)(?:ning|s|ned)?\b[^\n]*hello world\b`,
  String.raw`ECHO:\s*hello world`,
);

export const helloPromptCase = executionCase('hello-prompt')
  .category('session')
  .task(
    "Launch the hello-prompt fixture, send 'hello world' as input, wait for the READY> prompt to reappear, take a snapshot to verify the echo, then destroy the session.",
  )
  .fixture('hello-prompt', {
    setupId: 'launch-hello-prompt',
    setupDescription:
      'Create an agent-tty session that runs the hello-prompt fixture.',
  })
  .referenceSteps(5)
  .conditions(...ALL_EXECUTION_CONDITIONS)
  .assertions((assertions) => {
    assertions.snapshot(
      'hello-prompt-snapshot',
      'The transcript snapshot should include the echoed text and the READY prompt.',
      {
        patterns: [String.raw`ECHO:\s*hello world`, String.raw`READY>`],
      },
    );
  })
  .workflow((workflow) => {
    workflow
      .createSession()
      .input('hello world', {
        description: 'Send hello world with run or type.',
        pattern: HELLO_WORLD_INPUT_PATTERN,
      })
      .waitFor(String.raw`ECHO:\s*hello world[\s\S]*READY>`, {
        description: 'Wait for the READY prompt to reappear after the echo.',
      })
      .snapshot()
      .destroy();
  })
  .budget({
    timeoutMs: 120_000,
    maxAgentSteps: 12,
    maxWallClockMs: 60_000,
  })
  .build();
