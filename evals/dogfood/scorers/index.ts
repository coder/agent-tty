import { invariant } from '../../../src/util/assert.js';
import {
  scoreBundleCompleteness,
  scoreEvidenceQuality,
  scoreReportCompleteness,
} from '../../lib/bundleScoring.js';
import { checkForbiddenPatterns, matchPatterns } from '../../lib/scoring.js';
import type { DogfoodEvalCase, ReportRequirement } from '../../lib/types.js';

const DOGFOOD_SCORE_WEIGHTS = Object.freeze({
  bundleCompleteness: 0.2,
  reportCompleteness: 0.2,
  evidenceQuality: 0.2,
  taxonomyUsage: 0.2,
  reproducibility: 0.2,
});

const TAXONOMY_PATTERNS = [
  String.raw`/\brendering corruption\b/i`,
  String.raw`/\bresize\s*\/\s*layout\b/i`,
  String.raw`/\bfocus\s*\/\s*input\b/i`,
  String.raw`/\bscrollback\b/i`,
  String.raw`/\balt-screen\b/i`,
  String.raw`/\bcopy\s*\/\s*paste\b/i`,
  String.raw`/\bperformance\s*\/\s*startup\b/i`,
  String.raw`/\bcrash\s*\/\s*recovery(?:\s*\/\s*state loss)?\b/i`,
] as const;

type NormalizedReportRequirement = {
  id: string;
  section?: string;
  required: boolean;
  requiredPatterns: string[];
  forbiddenPatterns: string[];
};

export interface DogfoodScore {
  bundleCompleteness: number;
  reportCompleteness: number;
  evidenceQuality: number;
  taxonomyUsage: number;
  reproducibility: number;
  overallScore: number;
}

function assertStringInput(
  value: unknown,
  label: string,
): asserts value is string {
  invariant(typeof value === 'string', `${label} must be a string`);
}

function clampUnitInterval(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSectionPattern(section: string): string {
  const escapedSection = escapeRegExp(section.trim());
  return String.raw`/(?:^|\n)\s*(?:#{1,3}\s*${escapedSection}(?:\b|\s*:)|\*\*${escapedSection}(?::)?\*\*(?::)?)/im`;
}

function average(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }

  let total = 0;
  for (const value of values) {
    total += clampUnitInterval(value);
  }
  return clampUnitInterval(total / values.length);
}

export function scoreTaxonomyUsage(reportText: string): number {
  assertStringInput(reportText, 'reportText');
  if (reportText.trim().length === 0) {
    return 0;
  }

  const matches = matchPatterns(reportText, [...TAXONOMY_PATTERNS]);
  return matches.some((match) => match.matched) ? 1 : 0;
}

export function scoreReproducibility(reportText: string): number {
  assertStringInput(reportText, 'reportText');
  if (reportText.trim().length === 0) {
    return 0;
  }

  const hasReproSection = matchPatterns(reportText, [
    String.raw`/(?:^|\n)\s*(?:#{1,3}\s*(?:Reproduction steps|Repro(?:duction)? steps|Steps)\b|\*\*(?:Reproduction steps|Repro(?:duction)? steps|Steps):?\*\*)/im`,
  ]).some((match) => match.matched);
  const numberedSteps = reportText.match(/(?:^|\n)\s*\d+\.\s+/gmu) ?? [];
  const bulletSteps = reportText.match(/(?:^|\n)\s*[-*]\s+/gmu) ?? [];
  const hasStructuredSteps =
    numberedSteps.length >= 2 || bulletSteps.length >= 2;
  const hasCommandEvidence = matchPatterns(reportText, [
    String.raw`/\b(?:agent-tty|npx\s+tsx\s+src\/cli\/main\.ts|send-keys|snapshot|screenshot|record\s+export|doctor\s+--json)\b/i`,
  ]).some((match) => match.matched);
  const hasOutcomeStatement =
    (matchPatterns(reportText, [String.raw`/\bexpected\b/i`]).some(
      (match) => match.matched,
    ) &&
      matchPatterns(reportText, [String.raw`/\bactual\b/i`]).some(
        (match) => match.matched,
      )) ||
    matchPatterns(reportText, [
      String.raw`/\b(?:reproduces consistently|reproduces intermittently|consisten(?:t|cy)|intermittent(?:ly)?)\b/i`,
    ]).some((match) => match.matched);

  return average([
    hasReproSection ? 1 : 0,
    hasStructuredSteps ? 1 : 0,
    hasCommandEvidence ? 1 : 0,
    hasOutcomeStatement ? 1 : 0,
  ]);
}

export function scoreReportRequirements(
  reportText: string,
  requirements: readonly ReportRequirement[],
): { score: number; details: { section: string; found: boolean }[] } {
  assertStringInput(reportText, 'reportText');

  const normalizedRequirements =
    requirements as readonly NormalizedReportRequirement[];
  if (normalizedRequirements.length === 0) {
    return {
      score: 1,
      details: [],
    };
  }

  let weightedMatches = 0;
  let weightedTotal = 0;
  const details: Array<{ section: string; found: boolean }> = [];

  for (const requirement of normalizedRequirements) {
    invariant(
      requirement.id.trim().length > 0,
      'report requirement id must not be empty',
    );
    const section = requirement.section?.trim() || requirement.id;
    const requiredPatterns = [
      ...(requirement.section === undefined
        ? []
        : [buildSectionPattern(section)]),
      ...requirement.requiredPatterns,
    ];
    const requiredMatches = matchPatterns(reportText, requiredPatterns);
    const forbiddenMatches = checkForbiddenPatterns(
      reportText,
      requirement.forbiddenPatterns,
    );
    const found =
      requiredMatches.every((match) => match.matched) &&
      forbiddenMatches.every((match) => !match.violated);
    const weight = requirement.required ? 1 : 0.5;

    weightedTotal += weight;
    if (found) {
      weightedMatches += weight;
    }
    details.push({
      section,
      found,
    });
  }

  return {
    score:
      weightedTotal === 0
        ? 1
        : clampUnitInterval(weightedMatches / weightedTotal),
    details,
  };
}

export async function scoreDogfoodRun(
  bundleDir: string | undefined,
  reportText: string | undefined,
  transcript: string,
  evalCase: DogfoodEvalCase,
): Promise<DogfoodScore> {
  assertStringInput(transcript, 'transcript');

  const safeReportText = reportText ?? '';
  const reportSections = evalCase.reportRequirements
    .map((requirement) => requirement.section)
    .filter(
      (section): section is string =>
        typeof section === 'string' && section.trim().length > 0,
    );
  const bundleCompleteness =
    bundleDir === undefined
      ? 0
      : (await scoreBundleCompleteness(bundleDir, evalCase.validationProfile))
          .score;
  const evidenceQuality =
    bundleDir === undefined ? 0 : (await scoreEvidenceQuality(bundleDir)).score;
  const genericReportCompleteness = scoreReportCompleteness(
    safeReportText,
    reportSections,
  ).score;
  const caseSpecificReportCompleteness = scoreReportRequirements(
    safeReportText,
    evalCase.reportRequirements,
  ).score;
  const reportCompleteness = average([
    genericReportCompleteness,
    caseSpecificReportCompleteness,
  ]);
  const fallbackNarrative =
    safeReportText.trim().length > 0 ? safeReportText : transcript;
  const taxonomyUsage = scoreTaxonomyUsage(fallbackNarrative);
  const reproducibility = scoreReproducibility(fallbackNarrative);
  const overallScore = clampUnitInterval(
    bundleCompleteness * DOGFOOD_SCORE_WEIGHTS.bundleCompleteness +
      reportCompleteness * DOGFOOD_SCORE_WEIGHTS.reportCompleteness +
      evidenceQuality * DOGFOOD_SCORE_WEIGHTS.evidenceQuality +
      taxonomyUsage * DOGFOOD_SCORE_WEIGHTS.taxonomyUsage +
      reproducibility * DOGFOOD_SCORE_WEIGHTS.reproducibility,
  );

  return {
    bundleCompleteness,
    reportCompleteness,
    evidenceQuality,
    taxonomyUsage,
    reproducibility,
    overallScore,
  };
}
