import { PromptEvalCaseSchema } from '../lib/schemas.js';
import type {
  AntiPatternRule,
  ExpectedSkill,
  PromptEvalCase,
  WorkflowCheck,
} from '../lib/types.js';
import {
  assertCase,
  assertDefined,
  assertNonEmptyArray,
  cloneValue,
  compileAndValidate,
  toPatternSource,
  type PatternInput,
} from './compile.js';
import { WorkflowBuilder } from './workflow.js';

const DEFAULT_PROMPT_TIMEOUT_MS = 30_000;

export class PromptCaseBuilder {
  private readonly id: string;
  private categoryValue?: PromptEvalCase['category'];
  private promptValue?: string;
  private expectedSkillValue?: ExpectedSkill;
  private contextValue?: string;
  private readonly expectedPatternsValue: string[] = [];
  private readonly forbiddenPatternsValue: string[] = [];
  private readonly rubricValue: string[] = [];
  private antiPatternRulesValue: AntiPatternRule[] = [];
  private budgetValue: PromptEvalCase['budgets'] = {
    timeoutMs: DEFAULT_PROMPT_TIMEOUT_MS,
  };
  private readonly workflowBuilder: WorkflowBuilder;
  private workflowUsed = false;

  constructor(id: string) {
    this.id = id;
    this.workflowBuilder = new WorkflowBuilder({
      lane: 'prompt',
      caseId: id,
      defaultRequired: true,
    });
  }

  category(category: PromptEvalCase['category']): this {
    this.categoryValue = category;
    return this;
  }

  prompt(prompt: string): this {
    this.promptValue = prompt;
    return this;
  }

  expectSkill(expectedSkill: ExpectedSkill): this {
    this.expectedSkillValue = expectedSkill;
    return this;
  }

  context(context: string): this {
    this.contextValue = context;
    return this;
  }

  expectedPattern(...patterns: PatternInput[]): this {
    this.expectedPatternsValue.push(
      ...patterns.map((pattern) => toPatternSource(pattern)),
    );
    return this;
  }

  expectedPatterns(patterns: readonly PatternInput[]): this {
    this.expectedPatternsValue.length = 0;
    return this.expectedPattern(...patterns);
  }

  mustMention(...patterns: PatternInput[]): this {
    return this.expectedPattern(...patterns);
  }

  forbiddenPattern(...patterns: PatternInput[]): this {
    this.forbiddenPatternsValue.push(
      ...patterns.map((pattern) => toPatternSource(pattern)),
    );
    return this;
  }

  forbiddenPatterns(patterns: readonly PatternInput[]): this {
    this.forbiddenPatternsValue.length = 0;
    return this.forbiddenPattern(...patterns);
  }

  mustNotMention(...patterns: PatternInput[]): this {
    return this.forbiddenPattern(...patterns);
  }

  rubric(...items: string[]): this {
    this.rubricValue.push(...items);
    return this;
  }

  workflow(callback: (workflow: WorkflowBuilder) => unknown): this {
    this.workflowUsed = true;
    callback(this.workflowBuilder);
    return this;
  }

  rawWorkflowCheck(check: WorkflowCheck): this {
    this.workflowBuilder.rawWorkflowCheck(check);
    return this;
  }

  antiPatterns(...rules: AntiPatternRule[]): this {
    this.antiPatternRulesValue = cloneValue(
      rules,
      'prompt',
      this.id,
      'antiPatterns',
    );
    return this;
  }

  budget(budget: number | PromptEvalCase['budgets']): this {
    this.budgetValue =
      typeof budget === 'number' ? { timeoutMs: budget } : { ...budget };
    return this;
  }

  build(): PromptEvalCase {
    const category = assertDefined(
      this.categoryValue,
      'prompt',
      this.id,
      'category',
      'category is required',
    );
    const prompt = assertDefined(
      this.promptValue,
      'prompt',
      this.id,
      'prompt',
      'prompt is required',
    );
    const expectedSkill = assertDefined(
      this.expectedSkillValue,
      'prompt',
      this.id,
      'expectedSkill',
      'expectedSkill is required',
    );
    assertNonEmptyArray(
      this.expectedPatternsValue,
      'prompt',
      this.id,
      'expectedPatterns',
      'expectedPatterns must include at least one pattern',
    );

    const workflowChecks = this.workflowBuilder.build();
    assertCase(
      !this.workflowUsed || workflowChecks.length > 0,
      'prompt',
      this.id,
      'workflowChecks',
      'workflow() must add at least one workflow check',
    );

    const compiled: PromptEvalCase = {
      id: this.id,
      lane: 'prompt',
      category,
      prompt,
      expectedSkill,
      expectedPatterns: [...this.expectedPatternsValue],
      forbiddenPatterns: [...this.forbiddenPatternsValue],
      rubric: [...this.rubricValue],
      workflowChecks,
      antiPatterns: cloneValue(
        this.antiPatternRulesValue,
        'prompt',
        this.id,
        'antiPatterns',
      ),
      budgets: { ...this.budgetValue },
    };
    if (this.contextValue !== undefined) {
      compiled.context = this.contextValue;
    }

    return compileAndValidate('prompt', this.id, PromptEvalCaseSchema, compiled);
  }
}

export function promptCase(id: string): PromptCaseBuilder {
  return new PromptCaseBuilder(id);
}
