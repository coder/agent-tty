import { dogfoodCase } from '../../authoring/index.js';
import { SKILL_CONDITIONS } from '../../lib/matrix.js';

export const exploratoryQaCase = dogfoodCase('exploratory-qa')
  .category('qa')
  .task(
    'Launch the hello-prompt fixture, test exactly three inputs (`hello world`, a blank line, and `symbols-!@#$%^&*`), capture a snapshot after each input, then send `exit` to verify clean shutdown. Save at least one screenshot and one recording, and write a brief findings report with severity and evidence references.',
  )
  .fixture('hello-prompt')
  .bundlePath('proof-bundle')
  .bundleRequirements([
    'Produce a reviewable proof bundle for an exploratory QA investigation.',
    'Capture renderer-backed evidence for the tested interactions and edge cases.',
    'Write structured notes that summarize findings, severity, and evidence references.',
  ])
  .conditions(...SKILL_CONDITIONS)
  .validationProfile('interactive-renderer')
  .proofBundle((bundle) => {
    bundle.requiresScreenshot();
    bundle.requiresRecording();
    bundle.requiresNotes();
  })
  .report((report) => {
    report.title();
    report.reproductionSteps();
    report.findingsWithSeverity();
    report.evidenceReferences();
  })
  .bundleVerifier(
    'bundle-valid',
    'Validate the exploratory QA proof bundle with the interactive renderer profile.',
  )
  .budget({
    timeoutMs: 600_000,
    maxAgentSteps: 30,
    maxWallClockMs: 600_000,
  })
  .workspace('agent-tty-smoke')
  .build();

export default exploratoryQaCase;
