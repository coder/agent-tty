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

function optionalArtifact(
  kind: ArtifactRequirement['kind'],
  description: string,
  pathPatterns: string[],
): ArtifactRequirement {
  return {
    kind,
    required: false,
    description,
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
    'Validate the release-readiness proof bundle with the interactive renderer profile.',
  required: true,
  config: {
    profile: 'interactive-renderer',
  },
};

export const releaseReadinessCase = DogfoodEvalCaseSchema.parse({
  id: 'release-readiness',
  lane: 'dogfood',
  category: 'release-readiness',
  prompt: dogfoodTaskPrompt(
    'Perform a release-readiness check on the color-grid fixture. Verify color rendering across all modes (3-bit, 8-bit, 24-bit), capture visual evidence, and produce a release-readiness report.',
    'color-grid',
  ),
  expectedSkill: 'dogfood-tui',
  fixture: 'color-grid',
  bundlePath: 'proof-bundle',
  bundleRequirements: [
    'Produce a release-readiness proof bundle for the color-grid fixture.',
    'Capture visual evidence across 3-bit, 8-bit, and 24-bit color modes.',
    'Summarize readiness status with a ship-or-hold recommendation backed by evidence.',
  ],
  conditions: [...SKILL_CONDITIONS],
  validationProfile: 'interactive-renderer',
  artifactRequirements: [
    requiredArtifact(
      'screenshot',
      'Capture screenshots for each rendering mode under evaluation.',
      [String.raw`\.png$`],
      3,
    ),
    requiredArtifact('notes', 'Write a release-readiness report in markdown.', [
      String.raw`(?:^|/)(?:README|NOTES|index|notes)\.md$`,
    ]),
    optionalArtifact(
      'recording',
      'Optionally capture a terminal recording of mode switching or navigation.',
      [String.raw`\.cast$`],
    ),
  ],
  reportRequirements: [
    reportRequirement('title', 'Title', 'Release readiness report title.', [
      String.raw`/(?:^|\n)\s*(?:#{1,3}\s*Title\b|\*\*Title:?\*\*)/im`,
    ]),
    reportRequirement(
      'checklist',
      'Checklist',
      'Readiness checklist with pass/fail items.',
      [
        String.raw`/(?:^|\n)\s*(?:#{1,3}\s*Checklist\b|\*\*Checklist:?\*\*)/im`,
        String.raw`/\b(?:pass|fail)\b/i`,
      ],
    ),
    reportRequirement(
      'visual-evidence',
      'Visual evidence',
      'Screenshot evidence for each rendering mode.',
      [
        String.raw`/(?:^|\n)\s*(?:#{1,3}\s*Visual evidence\b|\*\*Visual evidence:?\*\*)/im`,
        String.raw`/\.(?:png|webm|cast)\b/i`,
      ],
    ),
    reportRequirement(
      'recommendation',
      'Recommendation',
      'Ship or hold recommendation with rationale.',
      [
        String.raw`/(?:^|\n)\s*(?:#{1,3}\s*Recommendation\b|\*\*Recommendation:?\*\*)/im`,
        String.raw`/\b(?:ship|hold)\b/i`,
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

export default releaseReadinessCase;
