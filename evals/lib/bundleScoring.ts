import { stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import {
  classifyBundlePath,
  scanBundleArtifacts,
} from '../../src/tools/review-bundle.js';
import type { BundleArtifact } from '../../src/tools/review-bundle.js';
import {
  MAX_JSON_FILE_BYTES,
  validateBundle,
} from '../../src/tools/validate-bundle.js';
import type {
  BundleValidationCheck,
  BundleValidationProfile,
} from '../../src/tools/validate-bundle.js';
import { invariant } from '../../src/util/assert.js';
import type {
  BundleCompletenessScore,
  EvidenceQualityScore,
  ForbiddenPatternResult,
  PatternMatchResult,
  ReportCompletenessScore,
  ScoreComponent,
} from './types.js';

const DEFAULT_BUNDLE_COMPLETENESS_PROFILE: BundleValidationProfile =
  'contract-reporting';
const DEFAULT_REPORT_SECTIONS = [
  'Summary',
  'Setup',
  'Steps',
  'Results',
  'Evidence',
  'Issues',
] as const;
const EXPECTED_MODALITY_COUNT = 4;
const FILE_DIVERSITY_BASELINE = 4;

type ReportCompletenessResult = ReportCompletenessScore & {
  evidenceRefsFound: number;
  details: Array<{
    section: string;
    found: boolean;
    required: boolean;
  }>;
};

type EvidenceQualityResult = EvidenceQualityScore & {
  modalityCoverage: number;
  fileDiversity: number;
  manifestSanity: number;
  details: Array<{
    dimension: string;
    score: number;
    notes?: string;
  }>;
};

type BundleArtifactInventory = {
  screenshotCount: number;
  videoCount: number;
  recordingCount: number;
  noteCount: number;
  jsonCount: number;
  manifestCount: number;
  hasNonZeroManifest: boolean;
  distinctKinds: Set<string>;
  oversizedJsonCount: number;
};

function clampUnitInterval(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function clampScore(value: number, maxScore: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(maxScore, Math.max(0, value));
}

function buildCheck(
  name: string,
  ok: boolean,
  message: string,
): BundleValidationCheck {
  return {
    name,
    ok,
    message,
  };
}

function buildScoreComponent(
  name: string,
  score: number,
  maxScore: number,
  reason: string,
): ScoreComponent {
  return {
    name,
    score,
    maxScore,
    reason,
  };
}

function normalizeText(text: string): string {
  return text.replaceAll('\r\n', '\n');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatCount(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${String(count)} ${count === 1 ? singular : plural}`;
}

function appendErrorContext(
  message: string,
  errorMessage: string | undefined,
): string {
  if (errorMessage === undefined) {
    return message;
  }
  return `${message} (${errorMessage})`;
}

function isManifestArtifact(artifact: BundleArtifact): boolean {
  return basename(artifact.relativePath).toLowerCase() === 'manifest.json';
}

async function readFileSizeIfPresent(
  filePath: string,
): Promise<number | undefined> {
  try {
    const fileStats = await stat(filePath);
    return fileStats.isFile() ? fileStats.size : undefined;
  } catch {
    return undefined;
  }
}

function summarizeBundleArtifacts(
  artifacts: BundleArtifact[],
  reviewPageSizeBytes: number | undefined,
): BundleArtifactInventory {
  const distinctKinds = new Set<string>();
  let screenshotCount = 0;
  let videoCount = 0;
  let recordingCount = 0;
  let noteCount = 0;
  let jsonCount = 0;
  let manifestCount = 0;
  let oversizedJsonCount = 0;
  let hasNonZeroManifest = false;

  for (const artifact of artifacts) {
    invariant(
      artifact.relativePath.trim().length > 0,
      'bundle artifact relative path must not be empty',
    );

    const normalizedKind = classifyBundlePath(artifact.relativePath);
    distinctKinds.add(normalizedKind);

    if (normalizedKind === 'screenshot') {
      screenshotCount += 1;
    } else if (normalizedKind === 'video') {
      videoCount += 1;
    } else if (normalizedKind === 'recording') {
      recordingCount += 1;
    } else if (normalizedKind === 'notes') {
      noteCount += 1;
    } else if (normalizedKind === 'json') {
      jsonCount += 1;
      if (artifact.sizeBytes > MAX_JSON_FILE_BYTES) {
        oversizedJsonCount += 1;
      }
    }

    if (isManifestArtifact(artifact)) {
      manifestCount += 1;
      distinctKinds.add('manifest');
      if (artifact.sizeBytes > 0) {
        hasNonZeroManifest = true;
      }
    }
  }

  if (reviewPageSizeBytes !== undefined) {
    distinctKinds.add('review-page');
  }

  return {
    screenshotCount,
    videoCount,
    recordingCount,
    noteCount,
    jsonCount,
    manifestCount,
    hasNonZeroManifest,
    distinctKinds,
    oversizedJsonCount,
  };
}

function buildBundleArtifactChecks(
  inventory: BundleArtifactInventory,
  reviewPageSizeBytes: number | undefined,
  artifactScanError: string | undefined,
): BundleValidationCheck[] {
  return [
    buildCheck(
      'artifact-screenshot',
      inventory.screenshotCount > 0,
      inventory.screenshotCount > 0
        ? `Found ${formatCount(inventory.screenshotCount, 'screenshot artifact')}.`
        : appendErrorContext(
            'Expected at least one screenshot artifact.',
            artifactScanError,
          ),
    ),
    buildCheck(
      'artifact-video-or-recording',
      inventory.videoCount + inventory.recordingCount > 0,
      inventory.videoCount + inventory.recordingCount > 0
        ? `Found ${formatCount(inventory.videoCount, 'video artifact')} and ${formatCount(inventory.recordingCount, 'recording artifact')}.`
        : appendErrorContext(
            'Expected at least one video or recording artifact.',
            artifactScanError,
          ),
    ),
    buildCheck(
      'artifact-notes',
      inventory.noteCount > 0,
      inventory.noteCount > 0
        ? `Found ${formatCount(inventory.noteCount, 'notes artifact')}.`
        : appendErrorContext(
            'Expected at least one notes artifact.',
            artifactScanError,
          ),
    ),
    buildCheck(
      'artifact-manifest',
      inventory.manifestCount > 0,
      inventory.manifestCount > 0
        ? `Found ${formatCount(inventory.manifestCount, 'manifest artifact')}.`
        : appendErrorContext(
            'Expected at least one manifest artifact.',
            artifactScanError,
          ),
    ),
    buildCheck(
      'artifact-review-page',
      reviewPageSizeBytes !== undefined,
      reviewPageSizeBytes !== undefined
        ? `Found bundle review page index.html (${String(reviewPageSizeBytes)} bytes).`
        : appendErrorContext(
            'Expected a generated bundle review page index.html.',
            artifactScanError,
          ),
    ),
  ];
}

function createZeroBundleCompleteness(
  profile: BundleValidationProfile,
  message: string,
): BundleCompletenessScore {
  const details: BundleValidationCheck[] = [
    buildCheck('bundle-validation', false, message),
    buildCheck(
      'artifact-screenshot',
      false,
      'Skipped artifact inventory because bundle validation failed.',
    ),
    buildCheck(
      'artifact-video-or-recording',
      false,
      'Skipped artifact inventory because bundle validation failed.',
    ),
    buildCheck(
      'artifact-notes',
      false,
      'Skipped artifact inventory because bundle validation failed.',
    ),
    buildCheck(
      'artifact-manifest',
      false,
      'Skipped artifact inventory because bundle validation failed.',
    ),
    buildCheck(
      'artifact-review-page',
      false,
      'Skipped artifact inventory because bundle validation failed.',
    ),
  ];

  return {
    profile,
    totalChecks: details.length,
    passed: 0,
    failed: details.length,
    score: 0,
    details,
  };
}

function buildSectionHeadingPattern(section: string): RegExp {
  const escapedSection = escapeRegExp(section);
  return new RegExp(
    `^\\s*(?:#{1,3}\\s*${escapedSection}(?:\\b|\\s*:)|\\*\\*${escapedSection}(?::)?\\*\\*(?::)?)`,
    'i',
  );
}

function collectPatternMatchResult(
  text: string,
  patternLabel: string,
  pattern: RegExp,
): PatternMatchResult {
  const lines = normalizeText(text).split('\n');
  const matchedTexts: string[] = [];
  const lineNumbers: number[] = [];

  for (const [index, line] of lines.entries()) {
    if (pattern.test(line)) {
      matchedTexts.push(line.trim());
      lineNumbers.push(index + 1);
    }
  }

  return {
    pattern: patternLabel,
    matched: matchedTexts.length > 0,
    matchedTexts,
    lineNumbers,
    matchCount: matchedTexts.length,
  };
}

function normalizeEvidenceReference(reference: string): string {
  return reference.trim().replace(/[),.;:]+$/u, '');
}

function collectEvidenceReferences(reportText: string): string[] {
  const references = new Set<string>();
  const normalizedText = normalizeText(reportText);
  const patterns: Array<{ pattern: RegExp; captureGroup?: number }> = [
    { pattern: /!\[[^\]]*\]\(([^)\s]+)\)/g, captureGroup: 1 },
    { pattern: /\[[^\]]+\]\(([^)\s]+)\)/g, captureGroup: 1 },
    { pattern: /https?:\/\/[^\s)]+/g },
    {
      pattern:
        /\b(?:\.{0,2}\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.(?:png|jpe?g|gif|webp|webm|cast|json|md|html|txt|tsv|log)\b/gi,
    },
  ];

  for (const { pattern, captureGroup } of patterns) {
    for (const match of normalizedText.matchAll(pattern)) {
      const rawMatch =
        captureGroup === undefined ? match[0] : (match[captureGroup] ?? '');
      const normalizedReference = normalizeEvidenceReference(rawMatch);
      if (normalizedReference.length > 0) {
        references.add(normalizedReference);
      }
    }
  }

  return [...references];
}

function findLineNumbersContainingReferences(
  reportText: string,
  references: string[],
): number[] {
  if (references.length === 0) {
    return [];
  }

  const lines = normalizeText(reportText).split('\n');
  const lineNumbers: number[] = [];

  for (const [index, line] of lines.entries()) {
    if (references.some((reference) => line.includes(reference))) {
      lineNumbers.push(index + 1);
    }
  }

  return lineNumbers;
}

function createZeroEvidenceQuality(note: string): EvidenceQualityResult {
  const details = [
    {
      dimension: 'modalityCoverage',
      score: 0,
      notes: 'No artifact modalities could be scored.',
    },
    {
      dimension: 'fileDiversity',
      score: 0,
      notes: 'No artifact kinds could be scored.',
    },
    {
      dimension: 'manifestSanity',
      score: 0,
      notes: 'Manifest and review-page sanity could not be evaluated.',
    },
  ];
  const breakdown = {
    total: 0,
    maxPossible: 1,
    items: [
      buildScoreComponent('modalityCoverage', 0, 0.4, 'No modalities scored.'),
      buildScoreComponent('fileDiversity', 0, 0.3, 'No artifact kinds scored.'),
      buildScoreComponent(
        'manifestSanity',
        0,
        0.3,
        'No manifest sanity scored.',
      ),
    ],
  };

  return {
    score: 0,
    artifactCoverage: 0,
    modalityCoverage: 0,
    fileDiversity: 0,
    manifestSanity: 0,
    breakdown,
    notes: [note],
    details,
  };
}

/**
 * Scores bundle completeness by combining `validateBundle()` checks with a
 * review-bundle artifact inventory. The default profile uses the repo's current
 * baseline proof-bundle validator profile, `contract-reporting`.
 */
export async function scoreBundleCompleteness(
  bundleDir: string,
  profile: BundleValidationProfile = DEFAULT_BUNDLE_COMPLETENESS_PROFILE,
): Promise<BundleCompletenessScore> {
  invariant(typeof bundleDir === 'string', 'bundle directory must be a string');
  invariant(bundleDir.trim().length > 0, 'bundle directory must not be empty');

  let validationResult;
  try {
    validationResult = await validateBundle(bundleDir, profile);
  } catch (error) {
    return createZeroBundleCompleteness(
      profile,
      `Bundle validation failed: ${String(error)}`,
    );
  }

  let artifacts: BundleArtifact[] = [];
  let artifactScanError: string | undefined;
  try {
    artifacts = await scanBundleArtifacts(bundleDir);
  } catch (error) {
    artifactScanError = `artifact scan failed: ${String(error)}`;
  }

  const reviewPageSizeBytes = await readFileSizeIfPresent(
    join(resolve(bundleDir), 'index.html'),
  );
  const inventory = summarizeBundleArtifacts(artifacts, reviewPageSizeBytes);
  const details = [
    ...validationResult.checks,
    ...buildBundleArtifactChecks(
      inventory,
      reviewPageSizeBytes,
      artifactScanError,
    ),
  ];
  const totalChecks = details.length;
  const passed = details.filter((detail) => detail.ok).length;
  const failed = totalChecks - passed;

  return {
    profile: validationResult.profile,
    totalChecks,
    passed,
    failed,
    score: clampUnitInterval(passed / totalChecks),
    details,
  };
}

/**
 * Scores whether a dogfood report includes the expected sections plus concrete
 * evidence references such as file paths, URLs, or markdown links.
 */
export function scoreReportCompleteness(
  reportText: string,
  expectedSections: string[] = [...DEFAULT_REPORT_SECTIONS],
): ReportCompletenessScore & {
  evidenceRefsFound: number;
  details: Array<{
    section: string;
    found: boolean;
    required: boolean;
  }>;
} {
  invariant(typeof reportText === 'string', 'report text must be a string');
  invariant(
    Array.isArray(expectedSections),
    'expected sections must be an array',
  );

  const normalizedExpectedSections = [...new Set(expectedSections)].map(
    (section) => {
      invariant(
        typeof section === 'string',
        'expected section must be a string',
      );
      const trimmedSection = section.trim();
      invariant(
        trimmedSection.length > 0,
        'expected section names must not be empty',
      );
      return trimmedSection;
    },
  );
  const sectionMatches = normalizedExpectedSections.map((section) =>
    collectPatternMatchResult(
      reportText,
      `section:${section}`,
      buildSectionHeadingPattern(section),
    ),
  );
  const details = normalizedExpectedSections.map((section, index) => ({
    section,
    found: sectionMatches[index]?.matched ?? false,
    required: true,
  }));
  const sectionsFound = details.filter((detail) => detail.found).length;
  const missingSections = details
    .filter((detail) => !detail.found)
    .map((detail) => detail.section);
  const evidenceReferences = collectEvidenceReferences(reportText);
  const evidenceRefsFound = evidenceReferences.length;
  const evidenceRequirement: PatternMatchResult = {
    pattern: 'evidence-reference',
    matched: evidenceRefsFound > 0,
    matchedTexts: evidenceReferences,
    lineNumbers: findLineNumbersContainingReferences(
      reportText,
      evidenceReferences,
    ),
    matchCount: evidenceRefsFound,
  };
  const matchedRequirements = [...sectionMatches, evidenceRequirement];
  const forbiddenFindings: ForbiddenPatternResult[] = [];
  const sectionCoverage =
    normalizedExpectedSections.length === 0
      ? 1
      : sectionsFound / normalizedExpectedSections.length;
  const score = clampUnitInterval(
    sectionCoverage * 0.7 + clampUnitInterval(evidenceRefsFound / 3) * 0.3,
  );
  const result: ReportCompletenessResult = {
    sectionsExpected: normalizedExpectedSections.length,
    sectionsFound,
    evidenceRefsFound,
    score,
    details,
    missingSections,
    matchedRequirements,
    forbiddenFindings,
  };

  return result;
}

/**
 * Scores evidence quality from the scanned proof-bundle artifacts without using
 * any subjective or model-based judging.
 */
export async function scoreEvidenceQuality(bundleDir: string): Promise<
  EvidenceQualityScore & {
    modalityCoverage: number;
    fileDiversity: number;
    manifestSanity: number;
    details: Array<{
      dimension: string;
      score: number;
      notes?: string;
    }>;
  }
> {
  invariant(typeof bundleDir === 'string', 'bundle directory must be a string');
  invariant(bundleDir.trim().length > 0, 'bundle directory must not be empty');

  let artifacts: BundleArtifact[];
  try {
    artifacts = await scanBundleArtifacts(bundleDir);
  } catch (error) {
    return createZeroEvidenceQuality(`Artifact scan failed: ${String(error)}`);
  }

  const reviewPageSizeBytes = await readFileSizeIfPresent(
    join(resolve(bundleDir), 'index.html'),
  );
  const inventory = summarizeBundleArtifacts(artifacts, reviewPageSizeBytes);
  const coveredModalities = [
    inventory.screenshotCount > 0,
    inventory.videoCount + inventory.recordingCount > 0,
    inventory.noteCount > 0,
    inventory.jsonCount > 0 || inventory.manifestCount > 0,
  ].filter(Boolean).length;
  const modalityCoverage = clampUnitInterval(
    coveredModalities / EXPECTED_MODALITY_COUNT,
  );
  const fileDiversity = clampUnitInterval(
    inventory.distinctKinds.size / FILE_DIVERSITY_BASELINE,
  );
  const hasManifestOrReviewPage =
    inventory.manifestCount > 0 || reviewPageSizeBytes !== undefined;
  const hasNonZeroManifestOrReviewPage =
    inventory.hasNonZeroManifest || (reviewPageSizeBytes ?? 0) > 0;
  const manifestSanity = hasNonZeroManifestOrReviewPage
    ? 1
    : hasManifestOrReviewPage
      ? 0.5
      : 0;

  const modalityNotes =
    coveredModalities > 0
      ? `${String(coveredModalities)} of ${String(EXPECTED_MODALITY_COUNT)} expected modalities were covered.`
      : 'Expected screenshots, video/recordings, notes, and structured data.';
  const diversityNotes =
    inventory.distinctKinds.size > 0
      ? `Observed ${String(inventory.distinctKinds.size)} distinct artifact kinds: ${[...inventory.distinctKinds].sort().join(', ')}.`
      : 'No artifacts were available to measure file diversity.';
  const manifestNotes = hasNonZeroManifestOrReviewPage
    ? inventory.oversizedJsonCount > 0
      ? `Manifest or review-page artifacts are present and non-empty. ${formatCount(inventory.oversizedJsonCount, 'JSON artifact')} exceed the ${String(MAX_JSON_FILE_BYTES)} byte validator limit.`
      : 'Manifest or review-page artifacts are present and non-empty.'
    : hasManifestOrReviewPage
      ? 'Manifest or review-page artifacts are present, but at least one appears empty.'
      : 'Expected a manifest.json artifact or generated review page.';
  const overallScore = clampUnitInterval(
    modalityCoverage * 0.4 + fileDiversity * 0.3 + manifestSanity * 0.3,
  );
  const breakdownItems: ScoreComponent[] = [
    buildScoreComponent(
      'modalityCoverage',
      clampScore(modalityCoverage * 0.4, 0.4),
      0.4,
      modalityNotes,
    ),
    buildScoreComponent(
      'fileDiversity',
      clampScore(fileDiversity * 0.3, 0.3),
      0.3,
      diversityNotes,
    ),
    buildScoreComponent(
      'manifestSanity',
      clampScore(manifestSanity * 0.3, 0.3),
      0.3,
      manifestNotes,
    ),
  ];
  const result: EvidenceQualityResult = {
    score: overallScore,
    artifactCoverage: modalityCoverage,
    modalityCoverage,
    fileDiversity,
    manifestSanity,
    breakdown: {
      total: overallScore,
      maxPossible: 1,
      items: breakdownItems,
    },
    notes: [modalityNotes, diversityNotes, manifestNotes],
    details: [
      {
        dimension: 'modalityCoverage',
        score: modalityCoverage,
        notes: modalityNotes,
      },
      {
        dimension: 'fileDiversity',
        score: fileDiversity,
        notes: diversityNotes,
      },
      {
        dimension: 'manifestSanity',
        score: manifestSanity,
        notes: manifestNotes,
      },
    ],
  };

  return result;
}
