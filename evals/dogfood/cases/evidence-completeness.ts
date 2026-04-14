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
    'Validate the evidence-completeness bundle with the interactive renderer profile.',
  required: true,
  config: {
    profile: 'interactive-renderer',
  },
};

export const evidenceCompletenessCase = DogfoodEvalCaseSchema.parse({
  id: 'evidence-completeness',
  lane: 'dogfood',
  category: 'reporting',
  prompt:
    'Test the scrollback-demo fixture and produce the most complete evidence bundle possible: screenshots, recordings, WebM exports, snapshots, notes, and a structured report following the full evidence checklist.',
  expectedSkill: 'dogfood-tui',
  fixture: 'scrollback-demo',
  bundlePath: 'proof-bundle',
  bundleRequirements: [
    'Produce the most complete proof bundle possible for the scrollback-demo fixture.',
    'Include screenshots, recordings, WebM exports, snapshots, and notes in one reviewable bundle.',
    'Follow the full evidence checklist, including commands, dimensions, and cleanup notes.',
  ],
  conditions: [...SKILL_CONDITIONS],
  validationProfile: 'interactive-renderer',
  artifactRequirements: [
    requiredArtifact(
      'screenshot',
      'Capture at least one screenshot artifact.',
      [String.raw`\.png$`],
    ),
    requiredArtifact('video', 'Export at least one WebM review artifact.', [
      String.raw`\.webm$`,
    ]),
    requiredArtifact(
      'recording',
      'Capture at least one terminal recording artifact.',
      [String.raw`\.cast$`],
    ),
    requiredArtifact(
      'json',
      'Capture at least one snapshot artifact for searchable evidence.',
      [String.raw`(?:^|/).*snapshot.*\.json$`],
    ),
    requiredArtifact(
      'notes',
      'Write the evidence checklist report in markdown.',
      [String.raw`(?:^|/)(?:README|NOTES|index|notes)\.md$`],
    ),
  ],
  reportRequirements: [
    reportRequirement('title', 'Title', 'Test report title.', [
      String.raw`/(?:^|\n)\s*(?:#{1,3}\s*Title\b|\*\*Title:?\*\*)/im`,
    ]),
    reportRequirement('commands', 'Commands', 'All commands executed.', [
      String.raw`/(?:^|\n)\s*(?:#{1,3}\s*Commands\b|\*\*Commands:?\*\*)/im`,
      String.raw`/\b(?:agent-tty|npx\s+tsx\s+src\/cli\/main\.ts)\b/i`,
    ]),
    reportRequirement('dimensions', 'Dimensions', 'Terminal dimensions used.', [
      String.raw`/(?:^|\n)\s*(?:#{1,3}\s*Dimensions\b|\*\*Dimensions:?\*\*)/im`,
      String.raw`/\b(?:\d+\s*[x×]\s*\d+|columns|rows|terminal dimensions)\b/i`,
    ]),
    reportRequirement(
      'evidence-checklist',
      'Evidence checklist',
      'Complete evidence checklist.',
      [
        String.raw`/(?:^|\n)\s*(?:#{1,3}\s*Evidence checklist\b|\*\*Evidence checklist:?\*\*)/im`,
        String.raw`/\b(?:screenshot|webm|recording|snapshot|notes)\b/i`,
      ],
    ),
    reportRequirement('cleanup', 'Cleanup', 'Session cleanup confirmation.', [
      String.raw`/(?:^|\n)\s*(?:#{1,3}\s*Cleanup\b|\*\*Cleanup:?\*\*)/im`,
      String.raw`/\b(?:destroy|cleanup|cleaned up|session cleanup)\b/i`,
    ]),
  ],
  verifiers: [verifier],
  workflowChecks: [],
  antiPatterns: [...DEFAULT_ANTI_PATTERN_RULES],
  budgets: {
    timeoutMs: 180000,
    maxWallClockMs: 300000,
  },
});

export default evidenceCompletenessCase;
