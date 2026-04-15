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
    'Validate the rendering bug reproduction proof bundle with the interactive renderer profile.',
  required: true,
  config: {
    profile: 'interactive-renderer',
  },
};

export const renderingBugReproCase = DogfoodEvalCaseSchema.parse({
  id: 'rendering-bug-repro',
  lane: 'dogfood',
  category: 'bug-repro',
  prompt: dogfoodTaskPrompt(
    'Reproduce a reported rendering issue: the unicode-grid fixture displays combining characters incorrectly when the terminal is narrower than 80 columns. Capture before/after evidence and write a bug report.',
    'unicode-grid',
  ),
  expectedSkill: 'dogfood-tui',
  fixture: 'unicode-grid',
  bundlePath: 'proof-bundle',
  bundleRequirements: [
    'Produce a reproducible bug-report bundle for the unicode-grid rendering issue.',
    'Capture before-and-after evidence for the narrow-terminal rendering problem.',
    'Document expected versus actual behavior with artifact references.',
  ],
  conditions: [...SKILL_CONDITIONS],
  validationProfile: 'interactive-renderer',
  artifactRequirements: [
    requiredArtifact(
      'screenshot',
      'Capture before-and-after screenshots of the rendering issue.',
      [String.raw`\.png$`],
      2,
    ),
    requiredArtifact(
      'json',
      'Capture at least one snapshot artifact for searchable evidence.',
      [String.raw`(?:^|/).*snapshot.*\.json$`],
    ),
    requiredArtifact('notes', 'Write the bug report in markdown notes.', [
      String.raw`(?:^|/)(?:README|NOTES|index|notes)\.md$`,
    ]),
  ],
  reportRequirements: [
    reportRequirement('title', 'Title', 'Bug report title with taxonomy.', [
      String.raw`/(?:^|\n)\s*(?:#{1,3}\s*Title\b|\*\*Title:?\*\*)/im`,
      String.raw`/\b(?:rendering corruption|rendering)\b/i`,
    ]),
    reportRequirement(
      'repro-steps',
      'Reproduction steps',
      'Exact reproduction steps.',
      [
        String.raw`/(?:^|\n)\s*(?:#{1,3}\s*(?:Reproduction steps|Repro(?:duction)? steps|Steps)\b|\*\*(?:Reproduction steps|Repro(?:duction)? steps|Steps):?\*\*)/im`,
        String.raw`/\b(?:80\s*[x×]\s*\d+|narrower than 80|80 columns)\b/i`,
      ],
    ),
    reportRequirement(
      'expected-vs-actual',
      'Expected vs actual',
      'Expected vs actual behavior.',
      [
        String.raw`/(?:^|\n)\s*(?:#{1,3}\s*Expected vs actual\b|\*\*Expected vs actual:?\*\*)/im`,
        String.raw`/\bexpected\b/i`,
        String.raw`/\bactual\b/i`,
      ],
    ),
    reportRequirement(
      'evidence',
      'Evidence',
      'Before and after screenshots or snapshots.',
      [
        String.raw`/(?:^|\n)\s*(?:#{1,3}\s*Evidence\b|\*\*Evidence:?\*\*)/im`,
        String.raw`/\.(?:png|json|md)\b/i`,
      ],
    ),
  ],
  verifiers: [verifier],
  workflowChecks: [],
  antiPatterns: [...DEFAULT_ANTI_PATTERN_RULES],
  budgets: {
    timeoutMs: 600_000,
    maxAgentSteps: 30,
    maxWallClockMs: 600_000,
  },
});

export default renderingBugReproCase;
