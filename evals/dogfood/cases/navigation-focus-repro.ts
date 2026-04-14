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
    'Validate the navigation or focus issue bundle with the contract reporting profile.',
  required: true,
  config: {
    profile: 'contract-reporting',
  },
};

export const navigationFocusReproCase = DogfoodEvalCaseSchema.parse({
  id: 'navigation-focus-repro',
  lane: 'dogfood',
  category: 'bug-repro',
  prompt:
    'Investigate a reported focus/input issue: the hello-prompt fixture may not respond to paste input in certain sequences. Reproduce, capture evidence, and write a structured report.',
  expectedSkill: 'dogfood-tui',
  fixture: 'hello-prompt',
  bundlePath: 'proof-bundle',
  bundleRequirements: [
    'Produce a structured issue-reproduction bundle for the suspected focus or input defect.',
    'Capture searchable evidence and optional motion proof for paste or focus handling.',
    'Classify the issue using the dogfood taxonomy and document exact reproduction steps.',
  ],
  conditions: [...SKILL_CONDITIONS],
  validationProfile: 'contract-reporting',
  artifactRequirements: [
    requiredArtifact(
      'json',
      'Capture at least one snapshot artifact showing the focus or paste state.',
      [String.raw`(?:^|/).*snapshot.*\.json$`],
    ),
    optionalArtifact(
      'recording',
      'Optionally capture a terminal recording of the problematic input sequence.',
      [String.raw`\.cast$`],
    ),
    requiredArtifact(
      'notes',
      'Write a structured focus or input report in markdown.',
      [String.raw`(?:^|/)(?:README|NOTES|index|notes)\.md$`],
    ),
  ],
  reportRequirements: [
    reportRequirement('title', 'Title', 'Issue title.', [
      String.raw`/(?:^|\n)\s*(?:#{1,3}\s*Title\b|\*\*Title:?\*\*)/im`,
    ]),
    reportRequirement(
      'repro-steps',
      'Reproduction steps',
      'Step-by-step reproduction.',
      [
        String.raw`/(?:^|\n)\s*(?:#{1,3}\s*(?:Reproduction steps|Repro(?:duction)? steps|Steps)\b|\*\*(?:Reproduction steps|Repro(?:duction)? steps|Steps):?\*\*)/im`,
        String.raw`/\b(?:paste|Ctrl\+V|send-keys|type)\b/i`,
      ],
    ),
    reportRequirement(
      'taxonomy',
      'Taxonomy',
      'Classify using issue taxonomy (focus/input).',
      [
        String.raw`/(?:^|\n)\s*(?:#{1,3}\s*(?:Taxonomy|Classification)\b|\*\*(?:Taxonomy|Classification):?\*\*)/im`,
        String.raw`/\bfocus\/input\b/i`,
      ],
    ),
    reportRequirement(
      'evidence',
      'Evidence',
      'Snapshot or recording evidence.',
      [
        String.raw`/(?:^|\n)\s*(?:#{1,3}\s*Evidence\b|\*\*Evidence:?\*\*)/im`,
        String.raw`/\.(?:json|cast|md)\b/i`,
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

export default navigationFocusReproCase;
