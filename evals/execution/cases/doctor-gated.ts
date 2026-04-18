import { executionCase } from '../../authoring/index.js';
import {
  ALL_EXECUTION_CONDITIONS,
  DOCTOR_JSON_PATTERN,
  SCREENSHOT_PATTERN,
  artifactRequirement,
  ordered,
} from './shared.js';

export const doctorGatedCase = executionCase('doctor-gated')
  .category('artifact')
  .task(
    'Before capturing a screenshot, run doctor --json to verify renderer prerequisites and then capture a screenshot of hello-prompt.',
  )
  .fixture('hello-prompt', {
    setupId: 'launch-doctor-gated',
    setupDescription:
      'Create an agent-tty session that runs the hello-prompt fixture.',
  })
  .referenceSteps(5)
  .conditions(...ALL_EXECUTION_CONDITIONS)
  .assertions((assertions) => {
    assertions.screenshot(
      'doctor-gated-screenshot',
      'A screenshot artifact should be produced after the doctor check passes.',
      {
        kind: 'screenshot',
      },
    );
  })
  .workflow((workflow) => {
    workflow
      .createSession()
      .run('doctor --json', {
        id: 'doctor',
        description: 'Run doctor --json before any renderer-dependent capture.',
        pattern: DOCTOR_JSON_PATTERN,
      })
      .screenshot({
        description: 'Capture the screenshot only after the doctor gate.',
        pattern: ordered(DOCTOR_JSON_PATTERN, SCREENSHOT_PATTERN),
      });
  })
  .rawArtifactRequirement(
    artifactRequirement(
      'screenshot',
      'A PNG screenshot should be saved after the doctor check.',
      String.raw`\.png$`,
    ),
  )
  .budget({
    timeoutMs: 180_000,
    maxAgentSteps: 14,
    maxWallClockMs: 75_000,
  })
  .build();
