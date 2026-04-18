import type { EvalLane, WorkflowCheck } from '../lib/types.js';
import {
  assertUniqueId,
  cloneValue,
  failCase,
  toPatternSource,
  type PatternInput,
} from './compile.js';

interface WorkflowStepDraft {
  id: string;
  description?: string;
  required: boolean;
  mustMention: string[];
  mustNotMention: string[];
  dependsOn: string[];
  weight?: number;
}

type WorkflowEntry =
  | {
      kind: 'draft';
      draft: WorkflowStepDraft;
    }
  | {
      kind: 'raw';
      check: WorkflowCheck;
    };

export interface WorkflowBuilderOptions {
  lane: EvalLane;
  caseId: string;
  defaultRequired: boolean;
  path?: string;
}

function findPatternContradiction(
  mustMention: readonly string[],
  mustNotMention: readonly string[],
): string | undefined {
  const forbiddenPatterns = new Set(mustNotMention);
  return mustMention.find((pattern) => forbiddenPatterns.has(pattern));
}

function appendUniqueValues(target: string[], values: readonly string[]): void {
  for (const value of values) {
    if (!target.includes(value)) {
      target.push(value);
    }
  }
}

export class WorkflowBuilder {
  private readonly lane: EvalLane;
  private readonly caseId: string;
  private readonly defaultRequired: boolean;
  private readonly path: string;
  private readonly entries: WorkflowEntry[] = [];
  private readonly knownIds = new Set<string>();

  constructor(options: WorkflowBuilderOptions) {
    this.lane = options.lane;
    this.caseId = options.caseId;
    this.defaultRequired = options.defaultRequired;
    this.path = options.path ?? 'workflowChecks';
  }

  step(id: string, description?: string): WorkflowStepBuilder {
    assertUniqueId(
      this.knownIds,
      id,
      this.lane,
      this.caseId,
      this.path,
      'workflow step id',
    );

    const draft: WorkflowStepDraft = {
      id,
      ...(description === undefined ? {} : { description }),
      required: this.defaultRequired,
      mustMention: [],
      mustNotMention: [],
      dependsOn: [],
    };
    this.entries.push({ kind: 'draft', draft });
    return new WorkflowStepBuilder(this, draft);
  }

  raw(check: WorkflowCheck): this {
    assertUniqueId(
      this.knownIds,
      check.id,
      this.lane,
      this.caseId,
      this.path,
      'workflow step id',
    );
    this.assertNoContradiction(
      check.id,
      check.requiredPatterns,
      check.forbiddenPatterns,
    );
    this.entries.push({
      kind: 'raw',
      check: cloneValue(check, this.lane, this.caseId, this.path),
    });
    return this;
  }

  rawWorkflowCheck(check: WorkflowCheck): this {
    return this.raw(check);
  }

  size(): number {
    return this.entries.length;
  }

  build(): WorkflowCheck[] {
    return this.entries.map((entry, index) => {
      if (entry.kind === 'raw') {
        return cloneValue(
          entry.check,
          this.lane,
          this.caseId,
          `${this.path}.${String(index)}`,
        );
      }

      this.assertNoContradiction(
        entry.draft.id,
        entry.draft.mustMention,
        entry.draft.mustNotMention,
      );
      return {
        id: entry.draft.id,
        description: entry.draft.description ?? `Workflow step ${entry.draft.id}`,
        required: entry.draft.required,
        requiredPatterns: [...entry.draft.mustMention],
        forbiddenPatterns: [...entry.draft.mustNotMention],
        dependsOn: [...entry.draft.dependsOn],
        ...(entry.draft.weight === undefined
          ? {}
          : { weight: entry.draft.weight }),
      };
    });
  }

  assertNoContradiction(
    stepId: string,
    mustMention: readonly string[],
    mustNotMention: readonly string[],
  ): void {
    const contradictoryPattern = findPatternContradiction(
      mustMention,
      mustNotMention,
    );
    if (contradictoryPattern === undefined) {
      return;
    }

    failCase(
      this.lane,
      this.caseId,
      this.path,
      `Workflow step "${stepId}" cannot require and forbid the same literal pattern ${JSON.stringify(contradictoryPattern)}`,
    );
  }
}

export class WorkflowStepBuilder {
  private readonly parent: WorkflowBuilder;
  private readonly draft: WorkflowStepDraft;

  constructor(parent: WorkflowBuilder, draft: WorkflowStepDraft) {
    this.parent = parent;
    this.draft = draft;
  }

  description(description: string): this {
    this.draft.description = description;
    return this;
  }

  mustMention(...patterns: PatternInput[]): this {
    appendUniqueValues(
      this.draft.mustMention,
      patterns.map((pattern) => toPatternSource(pattern)),
    );
    this.parent.assertNoContradiction(
      this.draft.id,
      this.draft.mustMention,
      this.draft.mustNotMention,
    );
    return this;
  }

  mustNotMention(...patterns: PatternInput[]): this {
    appendUniqueValues(
      this.draft.mustNotMention,
      patterns.map((pattern) => toPatternSource(pattern)),
    );
    this.parent.assertNoContradiction(
      this.draft.id,
      this.draft.mustMention,
      this.draft.mustNotMention,
    );
    return this;
  }

  dependsOn(...stepIds: string[]): this {
    appendUniqueValues(this.draft.dependsOn, stepIds);
    return this;
  }

  after(...stepIds: string[]): this {
    return this.dependsOn(...stepIds);
  }

  required(required = true): this {
    this.draft.required = required;
    return this;
  }

  optional(): this {
    return this.required(false);
  }

  weight(weight: number): this {
    this.draft.weight = weight;
    return this;
  }

  step(id: string, description?: string): WorkflowStepBuilder {
    return this.parent.step(id, description);
  }

  raw(check: WorkflowCheck): WorkflowBuilder {
    return this.parent.raw(check);
  }

  rawWorkflowCheck(check: WorkflowCheck): WorkflowBuilder {
    return this.parent.rawWorkflowCheck(check);
  }
}
