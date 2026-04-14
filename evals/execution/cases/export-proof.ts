import {
  ALL_EXECUTION_CONDITIONS,
  CREATE_SESSION_PATTERN,
  RECORD_EXPORT_PATTERN,
  artifactRequirement,
  createExecutionCase,
  executionAntiPatterns,
  executionBudgets,
  fixtureSetupStep,
  customVerifier,
  workflowCheck,
} from './shared.js';

export const exportProofCase = createExecutionCase({
  id: 'export-proof',
  lane: 'execution',
  category: 'artifact',
  prompt:
    'Launch hello-prompt, interact briefly, and then export the session recording as both asciicast and WebM formats.',
  expectedSkill: 'agent-tty',
  fixture: 'hello-prompt',
  conditions: [...ALL_EXECUTION_CONDITIONS],
  setup: [
    fixtureSetupStep(
      'launch-export-proof',
      'hello-prompt',
      'Create an agent-tty session that runs the hello-prompt fixture.',
    ),
  ],
  verifiers: [
    customVerifier(
      'export-proof-artifacts',
      'Both recording and video artifacts should be exported.',
      'artifact-exists',
      {
        kinds: ['recording', 'video'],
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
      'record-export',
      'Export both recording formats from the session.',
      RECORD_EXPORT_PATTERN,
      { dependsOn: ['create'] },
    ),
  ],
  antiPatterns: executionAntiPatterns(),
  artifactRequirements: [
    artifactRequirement(
      'recording',
      'An asciicast recording should be exported for replay.',
      String.raw`\.cast$`,
    ),
    artifactRequirement(
      'video',
      'A WebM video should be exported for reviewer playback.',
      String.raw`\.webm$`,
    ),
  ],
  budgets: executionBudgets({
    timeoutMs: 90_000,
    maxAgentSteps: 18,
    maxWallClockMs: 120_000,
  }),
});
