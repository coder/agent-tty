import { DEFAULT_ANTI_PATTERN_RULES } from '../../lib/antiPatterns.js';
import { SKILL_CONDITIONS } from '../../lib/matrix.js';
import { DogfoodEvalCaseSchema } from '../../lib/schemas.js';
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
    'Validate the resize regression proof bundle with the interactive renderer profile.',
  required: true,
  config: {
    profile: 'interactive-renderer',
  },
};

export const resizeRegressionCase = DogfoodEvalCaseSchema.parse({
  id: 'resize-regression',
  lane: 'dogfood',
  category: 'bug-repro',
  prompt:
    'Triage a potential resize regression: the resize-demo fixture should update SIZE output after terminal resize, but users report stale values. Test resize from 80x24 to 120x40 and back. Capture evidence at each step.',
  expectedSkill: 'dogfood-tui',
  fixture: 'resize-demo',
  bundlePath: 'proof-bundle',
  bundleRequirements: [
    'Produce a resize-regression proof bundle for the resize-demo fixture.',
    'Capture evidence for the initial state, the 120x40 resize, and the return to 80x24.',
    'Document expected and actual SIZE values observed at each step.',
  ],
  conditions: [...SKILL_CONDITIONS],
  validationProfile: 'interactive-renderer',
  artifactRequirements: [
    requiredArtifact(
      'json',
      'Capture snapshots for each resize step.',
      [String.raw`(?:^|/).*snapshot.*\.json$`],
      3,
    ),
    requiredArtifact(
      'screenshot',
      'Capture at least one screenshot of the resize output.',
      [String.raw`\.png$`],
    ),
    requiredArtifact('notes', 'Write regression-triage notes in markdown.', [
      String.raw`(?:^|/)(?:README|NOTES|index|notes)\.md$`,
    ]),
  ],
  reportRequirements: [
    reportRequirement('title', 'Title', 'Regression report title.', [
      String.raw`/(?:^|\n)\s*(?:#{1,3}\s*Title\b|\*\*Title:?\*\*)/im`,
    ]),
    reportRequirement(
      'repro-steps',
      'Reproduction steps',
      'Resize sequence with expected outputs.',
      [
        String.raw`/(?:^|\n)\s*(?:#{1,3}\s*(?:Reproduction steps|Repro(?:duction)? steps|Steps)\b|\*\*(?:Reproduction steps|Repro(?:duction)? steps|Steps):?\*\*)/im`,
        String.raw`/\b(?:80\s*[x×]\s*24|120\s*[x×]\s*40)\b/i`,
      ],
    ),
    reportRequirement(
      'expected-vs-actual',
      'Expected vs actual',
      'Size values before and after each resize.',
      [
        String.raw`/(?:^|\n)\s*(?:#{1,3}\s*Expected vs actual\b|\*\*Expected vs actual:?\*\*)/im`,
        String.raw`/\bSIZE\b/i`,
        String.raw`/\b(?:80\s*[x×]\s*24|120\s*[x×]\s*40)\b/i`,
      ],
    ),
    reportRequirement(
      'evidence',
      'Evidence',
      'Snapshots at each resize step.',
      [
        String.raw`/(?:^|\n)\s*(?:#{1,3}\s*Evidence\b|\*\*Evidence:?\*\*)/im`,
        String.raw`/\.(?:json|png|md)\b/i`,
      ],
    ),
  ],
  verifiers: [verifier],
  workflowChecks: [],
  antiPatterns: [...DEFAULT_ANTI_PATTERN_RULES],
  budgets: {
    timeoutMs: 180000,
    maxWallClockMs: 300000,
  },
});

export default resizeRegressionCase;
