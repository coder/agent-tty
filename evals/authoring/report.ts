import type { ReportRequirement } from '../lib/types.js';
import {
  assertUniqueId,
  cloneValue,
  toPatternSource,
  type PatternInput,
} from './compile.js';

interface ReportRequirementDraft {
  id: string;
  description: string;
  required: boolean;
  section?: string;
  requiredPatterns: string[];
  forbiddenPatterns: string[];
}

type ReportEntry =
  | {
      kind: 'draft';
      requirement: ReportRequirementDraft;
    }
  | {
      kind: 'raw';
      requirement: ReportRequirement;
    };

const TITLE_PATTERN = String.raw`/(?:^|\n)\s*(?:#{1,3}\s*Title\b|\*\*Title:?\*\*)/im`;
const REPRODUCTION_SECTION_PATTERN = String.raw`/(?:^|\n)\s*(?:#{1,3}\s*(?:Reproduction steps|Repro(?:duction)? steps|Steps)\b|\*\*(?:Reproduction steps|Repro(?:duction)? steps|Steps):?\*\*)/im`;
const FINDINGS_SECTION_PATTERN = String.raw`/(?:^|\n)\s*(?:#{1,3}\s*(?:Findings|Issues)\b|\*\*(?:Findings|Issues):?\*\*)/im`;
const EVIDENCE_SECTION_PATTERN = String.raw`/(?:^|\n)\s*(?:#{1,3}\s*Evidence\b|\*\*Evidence:?\*\*)/im`;
const CLI_REFERENCE_PATTERN = String.raw`/\b(?:agent-tty|npx\s+tsx\s+src\/cli\/main\.ts)\b/i`;
const SEVERITY_PATTERN = String.raw`/\b(?:severity|critical|high|medium|low|info)\b/i`;
const EVIDENCE_REFERENCE_PATTERN = String.raw`/\.(?:png|cast|webm|json|md)\b/i`;

export class ReportBuilder {
  private readonly caseId: string;
  private readonly path: string;
  private readonly entries: ReportEntry[] = [];
  private readonly knownIds = new Set<string>();

  constructor(caseId: string, path = 'reportRequirements') {
    this.caseId = caseId;
    this.path = path;
  }

  section(
    id: string,
    section: string | undefined,
    description: string,
    requiredPatterns: readonly PatternInput[],
    forbiddenPatterns: readonly PatternInput[] = [],
  ): this {
    assertUniqueId(
      this.knownIds,
      id,
      'dogfood',
      this.caseId,
      this.path,
      'report requirement id',
    );
    this.entries.push({
      kind: 'draft',
      requirement: {
        id,
        ...(section === undefined ? {} : { section }),
        description,
        required: true,
        requiredPatterns: requiredPatterns.map((pattern) =>
          toPatternSource(pattern),
        ),
        forbiddenPatterns: forbiddenPatterns.map((pattern) =>
          toPatternSource(pattern),
        ),
      },
    });
    return this;
  }

  title(description = 'Report must have a descriptive title.'): this {
    return this.section('title', 'Title', description, [TITLE_PATTERN]);
  }

  reproductionSteps(
    description = 'Include step-by-step reproduction commands.',
  ): this {
    return this.section('repro-steps', 'Reproduction steps', description, [
      REPRODUCTION_SECTION_PATTERN,
      CLI_REFERENCE_PATTERN,
    ]);
  }

  findingsWithSeverity(
    description = 'List findings with severity classification.',
  ): this {
    return this.section('findings', 'Findings', description, [
      FINDINGS_SECTION_PATTERN,
      SEVERITY_PATTERN,
    ]);
  }

  evidenceReferences(
    description = 'Reference captured artifacts such as screenshots and recordings.',
  ): this {
    return this.section('evidence', 'Evidence', description, [
      EVIDENCE_SECTION_PATTERN,
      EVIDENCE_REFERENCE_PATTERN,
    ]);
  }

  raw(requirement: ReportRequirement): this {
    assertUniqueId(
      this.knownIds,
      requirement.id,
      'dogfood',
      this.caseId,
      this.path,
      'report requirement id',
    );
    this.entries.push({
      kind: 'raw',
      requirement: cloneValue(
        requirement,
        'dogfood',
        this.caseId,
        `${this.path}.${requirement.id}`,
      ),
    });
    return this;
  }

  rawReportRequirement(requirement: ReportRequirement): this {
    return this.raw(requirement);
  }

  size(): number {
    return this.entries.length;
  }

  build(): ReportRequirement[] {
    return this.entries.map((entry, index) => {
      if (entry.kind === 'raw') {
        return cloneValue(
          entry.requirement,
          'dogfood',
          this.caseId,
          `${this.path}.${String(index)}`,
        );
      }

      return {
        id: entry.requirement.id,
        description: entry.requirement.description,
        required: entry.requirement.required,
        ...(entry.requirement.section === undefined
          ? {}
          : { section: entry.requirement.section }),
        requiredPatterns: [...entry.requirement.requiredPatterns],
        forbiddenPatterns: [...entry.requirement.forbiddenPatterns],
      };
    });
  }
}
