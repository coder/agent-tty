import { DEFAULT_ANTI_PATTERN_RULES } from '../../lib/antiPatterns.js';
import { SKILL_CONDITIONS } from '../../lib/matrix.js';
import { DogfoodEvalCaseSchema } from '../../lib/schemas.js';
import { dogfoodTaskPrompt } from './shared.js';
import type {
  ArtifactRequirement,
  ReportRequirement,
  VerifierSpec,
} from '../../lib/types.js';

function requiredArtifact(
  kind: ArtifactRequirement['kind'],
  description: string,
  pathPatterns: string[],
  minCount = 1,
): ArtifactRequirement {
  return {
    kind,
    required: true,
    description,
    minCount,
    pathPatterns,
  };
}

function reportRequirement(
  id: string,
  section: string,
  description: string,
  requiredPatterns: string[],
): ReportRequirement {
  return {
    id,
    section,
    description,
    required: true,
    requiredPatterns,
    forbiddenPatterns: [],
  };
}

const verifier: VerifierSpec = {
  id: 'bundle-valid',
  kind: 'bundle',
  description:
    'Validate the exploratory QA proof bundle with the interactive renderer profile.',
  required: true,
  config: {
    profile: 'interactive-renderer',
  },
};

export const exploratoryQaCase = DogfoodEvalCaseSchema.parse({
  id: 'exploratory-qa',
  lane: 'dogfood',
  category: 'qa',
  prompt: dogfoodTaskPrompt(
    'Perform exploratory QA testing on the hello-prompt fixture app. Test input handling, exit behavior, error codes, and edge cases. Produce a proof bundle with screenshots, recordings, and a structured report of findings.',
    'hello-prompt',
  ),
  expectedSkill: 'dogfood-tui',
  fixture: 'hello-prompt',
  bundlePath: 'proof-bundle',
  bundleRequirements: [
    'Produce a reviewable proof bundle for an exploratory QA investigation.',
    'Capture renderer-backed evidence for the tested interactions and edge cases.',
    'Write structured notes that summarize findings, severity, and evidence references.',
  ],
  conditions: [...SKILL_CONDITIONS],
  validationProfile: 'interactive-renderer',
  artifactRequirements: [
    requiredArtifact(
      'screenshot',
      'Capture at least one screenshot of a noteworthy state.',
      [String.raw`\.png$`],
    ),
    requiredArtifact(
      'recording',
      'Capture at least one terminal recording artifact.',
      [String.raw`\.cast$`],
    ),
    requiredArtifact(
      'notes',
      'Write exploratory QA notes in a markdown report.',
      [String.raw`(?:^|/)(?:README|NOTES|index|notes)\.md$`],
    ),
  ],
  reportRequirements: [
    reportRequirement(
      'title',
      'Title',
      'Report must have a descriptive title.',
      [String.raw`/(?:^|\n)\s*(?:#{1,3}\s*Title\b|\*\*Title:?\*\*)/im`],
    ),
    reportRequirement(
      'repro-steps',
      'Reproduction steps',
      'Include step-by-step reproduction commands.',
      [
        String.raw`/(?:^|\n)\s*(?:#{1,3}\s*(?:Reproduction steps|Repro(?:duction)? steps|Steps)\b|\*\*(?:Reproduction steps|Repro(?:duction)? steps|Steps):?\*\*)/im`,
        String.raw`/\b(?:agent-tty|npx\s+tsx\s+src\/cli\/main\.ts)\b/i`,
      ],
    ),
    reportRequirement(
      'findings',
      'Findings',
      'List findings with severity classification.',
      [
        String.raw`/(?:^|\n)\s*(?:#{1,3}\s*(?:Findings|Issues)\b|\*\*(?:Findings|Issues):?\*\*)/im`,
        String.raw`/\b(?:severity|critical|high|medium|low|info)\b/i`,
      ],
    ),
    reportRequirement(
      'evidence',
      'Evidence',
      'Reference captured artifacts such as screenshots and recordings.',
      [
        String.raw`/(?:^|\n)\s*(?:#{1,3}\s*Evidence\b|\*\*Evidence:?\*\*)/im`,
        String.raw`/\.(?:png|cast|webm|json|md)\b/i`,
      ],
    ),
  ],
  verifiers: [verifier],
  workflowChecks: [],
  antiPatterns: [...DEFAULT_ANTI_PATTERN_RULES],
  budgets: {
    timeoutMs: 300_000,
    maxWallClockMs: 300000,
  },
});

export default exploratoryQaCase;
