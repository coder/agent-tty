import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';

type JsonSchema = {
  type?: unknown;
  enum?: readonly string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  __optional?: boolean;
};

type Issue = {
  number: number;
  title: string;
  url: string;
  state: string;
  body: string;
  author: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  labelNames: string[];
};

type AgentSpec = {
  id: string;
  title?: string;
  agentId?: string;
  isolation?: string;
  prompt: string;
  outputSchema: unknown;
};

type AgentResult = {
  structuredOutput: unknown;
};

type AnalysisOutput = {
  issue: number;
  status: 'ready' | 'deferred' | 'skipped_done';
  reason: string;
  triageReport: string | null;
  publishableComment: string | null;
  recommendedLabels: string[];
  reproductionStatus:
    | 'reproduced'
    | 'not_reproduced'
    | 'not_applicable'
    | 'deferred';
  commandsRun: string[];
  observedBehavior: string | null;
  expectedBehavior: string | null;
  rootCause: string | null;
  prototypeSummary: string | null;
  confidence: 'high' | 'medium' | 'low';
  labelNames: string[];
  summary: string;
};

type WorkflowReturn = {
  reportMarkdown: string;
  structuredOutput: {
    drafted: Array<{
      issue: number;
      title: string;
      url: string;
      triageReport: string;
      publishableComment: string;
      recommendedLabels: string[];
      rejectedLabels: string[];
      labelsToAdd: string[];
      labelsToRemove: string[];
      reproductionStatus: string;
      commandsRun: string[];
      observedBehavior: string | null;
      expectedBehavior: string | null;
      rootCause: string | null;
      prototypeSummary: string | null;
      confidence: string;
      summary: string;
    }>;
    deferred: Array<{
      issue?: number;
      reason: string;
      fetchedCount?: number;
      eligibleCount?: number;
      returnedCount?: number;
    }>;
    skippedDone: number[];
    skippedOngoing: number[];
    skippedIneligible: Array<{
      issue: number;
      reason: string;
      labelNames: string[];
    }>;
    truncated: boolean;
    publishMode: string;
  };
};

type ListedFilterOverrides = {
  state?: string;
  includeLabels?: string[];
  excludeLabels?: string[];
  limit?: number;
  fetchLimit?: number;
};

type WorkflowModule = {
  workflow: (context: {
    args: Record<string, unknown>;
    phase: (name: string, details?: unknown) => void;
    log: (message: string, data?: unknown) => void;
    agent: (spec: AgentSpec) => AgentResult;
    parallelAgents: (
      specs: AgentSpec[],
      options: { maxParallel: number },
    ) => AgentResult[];
  }) => WorkflowReturn;
  metadata: unknown;
};

const workflowUrl = new URL(
  '../../../.mux/workflows/github-issue-triage.js',
  import.meta.url,
);

function loadWorkflow(): WorkflowModule {
  const source = readFileSync(workflowUrl, 'utf8');
  const transformed = source
    .replace('export const metadata =', 'const metadata =')
    .replace('export default function workflow', 'function workflow');

  const script = new Script(transformed + '\n;({ workflow, metadata });', {
    filename: workflowUrl.pathname,
  });
  return script.runInNewContext({
    mux: { schema: fakeSchema },
  }) as WorkflowModule;
}

const fakeSchema = {
  string: () => ({ type: 'string' }),
  integer: () => ({ type: 'integer' }),
  boolean: () => ({ type: 'boolean' }),
  enum: (values: readonly string[]) => ({ enum: values }),
  array: (items: JsonSchema) => ({ type: 'array', items }),
  nullable: (inner: JsonSchema) => ({ ...inner, type: [inner.type, 'null'] }),
  optional: (inner: JsonSchema) => ({ ...inner, __optional: true }),
  object: (
    properties: Record<string, JsonSchema>,
    options?: { additionalProperties?: boolean },
  ) => ({
    type: 'object',
    properties,
    required: Object.entries(properties)
      .filter(([, schema]) => !schema.__optional)
      .map(([key]) => key),
    additionalProperties: options?.additionalProperties ?? false,
  }),
};

function resultFor(spec: AgentSpec, structuredOutput: unknown): AgentResult {
  validateSchema(spec.outputSchema as JsonSchema, structuredOutput, spec.id);
  return { structuredOutput };
}

function validateSchema(
  schema: JsonSchema,
  value: unknown,
  path: string,
): void {
  if (schema.enum) {
    if (!schema.enum.includes(value as string)) {
      throw new Error(path + ' must be one of ' + schema.enum.join(', '));
    }
    return;
  }

  const type = schema.type;
  if (Array.isArray(type) && type.includes('null') && value === null) return;

  if (type === 'string' && typeof value !== 'string') {
    throw new Error(path + ' must be string');
  }
  if (type === 'integer' && !Number.isInteger(value)) {
    throw new Error(path + ' must be integer');
  }
  if (type === 'boolean' && typeof value !== 'boolean') {
    throw new Error(path + ' must be boolean');
  }
  if (type === 'array') {
    if (!Array.isArray(value)) throw new Error(path + ' must be array');
    for (let index = 0; index < value.length; index += 1) {
      validateSchema(
        schema.items as JsonSchema,
        value[index],
        `${path}[${index}]`,
      );
    }
  }
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(path + ' must be object');
    }
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) throw new Error(path + '.' + key + ' is required');
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in record) validateSchema(child, record[key], path + '.' + key);
    }
  }
}

function runWorkflow(options: {
  args?: Record<string, unknown>;
  issues?: Issue[];
  analyses?: Record<number, AnalysisOutput>;
  listed?: {
    repository?: string;
    fetchedCount?: number;
    eligibleCount?: number;
    truncated?: boolean;
    filters?: ListedFilterOverrides;
  };
}) {
  const module = loadWorkflow();
  const workflowArgs = options.args ?? { repository: 'coder/agent-tty' };
  const issues = options.issues ?? [];
  const agentSpecs: AgentSpec[] = [];
  const parallelSpecs: AgentSpec[] = [];

  const result = module.workflow({
    args: workflowArgs,
    phase: () => {},
    log: () => {},
    agent: (spec) => {
      agentSpecs.push(spec);
      if (spec.id === 'resolve-context') {
        return resultFor(spec, {
          cwd: null,
          gitRoot: null,
          repository: 'coder/agent-tty',
          repositorySource: 'test',
        });
      }
      if (spec.id === 'fetch-issues') {
        return resultFor(spec, {
          repository: options.listed?.repository ?? 'coder/agent-tty',
          filters: listedFilters(workflowArgs, options.listed?.filters),
          fetchedCount: options.listed?.fetchedCount ?? issues.length,
          eligibleCount: options.listed?.eligibleCount ?? issues.length,
          truncated: options.listed?.truncated ?? false,
          issues,
        });
      }
      throw new Error('unexpected agent spec: ' + spec.id);
    },
    parallelAgents: (specs, options) => {
      expect(options.maxParallel).toBe(8);
      parallelSpecs.push(...specs);
      return specs.map((spec) => {
        const issue = Number(spec.id.match(/issue-(\d+)/)?.[1]);
        return resultFor(spec, optionsByIssue(options, issue));
      });
    },
  });

  return {
    result: JSON.parse(JSON.stringify(result)) as WorkflowReturn,
    agentSpecs,
    parallelSpecs,
  };

  function optionsByIssue(
    _parallelOptions: { maxParallel: number },
    issue: number,
  ): AnalysisOutput {
    return options.analyses?.[issue] ?? analysisOutput(issue);
  }
}

function listedFilters(
  args: Record<string, unknown>,
  overrides: ListedFilterOverrides | undefined,
) {
  return {
    state:
      overrides?.state ??
      (typeof args.state === 'string' ? args.state.toLowerCase() : 'open'),
    includeLabels:
      overrides?.includeLabels ??
      stringList(args.includeLabels, ['needs-triage']),
    excludeLabels:
      overrides?.excludeLabels ?? stringList(args.excludeLabels, []),
    limit:
      overrides?.limit ?? (typeof args.limit === 'number' ? args.limit : 1000),
    fetchLimit: overrides?.fetchLimit ?? 1000,
  };
}

function stringList(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? value.filter(isString) : fallback;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function analysisOutput(
  issue: number,
  overrides: Partial<AnalysisOutput> = {},
): AnalysisOutput {
  return {
    issue,
    status: 'ready',
    reason: '',
    triageReport: `Draft report for #${issue}`,
    publishableComment: `Public comment for #${issue}`,
    recommendedLabels: ['ready-for-agent'],
    reproductionStatus: 'reproduced',
    commandsRun: ['npm test -- example'],
    observedBehavior: 'Observed behavior.',
    expectedBehavior: 'Expected behavior.',
    rootCause: 'Likely root cause.',
    prototypeSummary: null,
    confidence: 'high',
    labelNames: ['needs-triage'],
    summary: `Drafted #${issue}`,
    ...overrides,
  };
}

function issue(
  number: number,
  labelNames: string[],
  state = 'open',
  body = '',
): Issue {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/coder/agent-tty/issues/${number}`,
    state,
    body,
    author: 'octocat',
    createdAt: null,
    updatedAt: null,
    labelNames,
  };
}

describe('github issue triage workflow', () => {
  it('skips context resolution when repository args are explicit', () => {
    const explicitRepository = runWorkflow({
      args: { repository: 'coder/agent-tty' },
    });

    expect(explicitRepository.agentSpecs.map((spec) => spec.id)).toEqual([
      'fetch-issues',
    ]);

    const explicitOwnerRepo = runWorkflow({
      args: { owner: 'coder', repo: 'agent-tty' },
    });

    expect(explicitOwnerRepo.agentSpecs.map((spec) => spec.id)).toEqual([
      'fetch-issues',
    ]);
  });

  it('resolves context when repository args are missing', () => {
    const { agentSpecs } = runWorkflow({ args: {} });

    expect(agentSpecs.map((spec) => spec.id)).toEqual([
      'resolve-context',
      'fetch-issues',
    ]);
  });

  it('rejects issue listings whose filters do not match the request', () => {
    expect(() =>
      runWorkflow({
        args: { repository: 'coder/agent-tty', excludeLabels: ['blocked'] },
        listed: { filters: { excludeLabels: [] } },
        issues: [issue(1, ['needs-triage'])],
      }),
    ).toThrow(/issue listing filters mismatch: excludeLabels/);
  });

  it('re-filters model-listed issues before drafting reports', () => {
    const { result, parallelSpecs } = runWorkflow({
      args: {
        repository: 'coder/agent-tty',
        excludeLabels: ['blocked'],
      },
      issues: [
        issue(1, []),
        issue(2, ['needs-triage']),
        issue(3, ['needs-triage', 'triage:done']),
        issue(4, ['needs-triage', 'triage:ongoing']),
        issue(5, ['needs-triage', 'blocked']),
        issue(6, ['needs-triage'], 'closed'),
      ],
    });

    expect(parallelSpecs).toHaveLength(1);
    expect(parallelSpecs[0]?.agentId).toBe('exec');
    expect(parallelSpecs[0]?.isolation).toBe('fork');
    expect(parallelSpecs[0]?.prompt).not.toMatch(
      /gh issue (edit|comment)|--add-label|--remove-label/,
    );

    expect(result.structuredOutput.drafted.map((item) => item.issue)).toEqual([
      2,
    ]);
    expect(result.structuredOutput.skippedDone).toEqual([3]);
    expect(result.structuredOutput.skippedOngoing).toEqual([4]);
    expect(
      result.structuredOutput.skippedIneligible.map((item) => [
        item.issue,
        item.reason,
      ]),
    ).toEqual([
      [1, 'missing-include-label'],
      [5, 'excluded-label-present'],
      [6, 'state-filter-mismatch'],
    ]);
  });

  it('handles GitHub repository, state, and label casing', () => {
    const { result, parallelSpecs } = runWorkflow({
      args: {
        repository: 'Coder/Agent-TTY',
        state: 'OPEN',
        excludeLabels: ['blocked'],
      },
      listed: { repository: 'coder/agent-tty' },
      issues: [
        issue(1, ['Needs-Triage'], 'OPEN'),
        issue(2, ['Needs-Triage', 'Triage:Done'], 'OPEN'),
        issue(3, ['Needs-Triage', 'TRIAGE:ONGOING'], 'OPEN'),
        issue(4, ['Needs-Triage', 'Blocked'], 'OPEN'),
      ],
    });

    expect(parallelSpecs.map((spec) => spec.id)).toEqual([
      'analyze-issue-1-v1',
    ]);
    expect(result.structuredOutput.drafted.map((item) => item.issue)).toEqual([
      1,
    ]);
    expect(result.structuredOutput.skippedDone).toEqual([2]);
    expect(result.structuredOutput.skippedOngoing).toEqual([3]);
    expect(result.structuredOutput.skippedIneligible).toEqual([
      {
        issue: 4,
        reason: 'excluded-label-present',
        labelNames: ['Needs-Triage', 'Blocked'],
      },
    ]);
  });

  it('sorts and caps eligible issues in workflow code', () => {
    const { result, parallelSpecs } = runWorkflow({
      args: { repository: 'coder/agent-tty', limit: 1 },
      issues: [issue(2, ['needs-triage']), issue(1, ['needs-triage'])],
    });

    expect(parallelSpecs.map((spec) => spec.id)).toEqual([
      'analyze-issue-1-v1',
    ]);
    expect(result.structuredOutput.drafted.map((item) => item.issue)).toEqual([
      1,
    ]);
    expect(
      result.structuredOutput.skippedIneligible.map((item) => [
        item.issue,
        item.reason,
      ]),
    ).toEqual([[2, 'over-limit']]);
  });

  it('flags fetch-limit exhaustion while still drafting returned candidates', () => {
    const { result, parallelSpecs } = runWorkflow({
      args: {
        repository: 'coder/agent-tty',
        excludeLabels: ['blocked'],
      },
      issues: [issue(1, ['needs-triage'])],
      listed: { fetchedCount: 1000, truncated: false },
    });

    expect(parallelSpecs.map((spec) => spec.id)).toEqual([
      'analyze-issue-1-v1',
    ]);
    expect(result.structuredOutput.drafted.map((item) => item.issue)).toEqual([
      1,
    ]);
    expect(result.structuredOutput.truncated).toBe(true);
    expect(result.structuredOutput.deferred).toEqual([
      {
        reason: 'issue-listing-truncated',
        fetchedCount: 1000,
        eligibleCount: 1,
        returnedCount: 1,
      },
    ]);
  });

  it('applies the draft limit after done and ongoing filtering', () => {
    const { result, parallelSpecs } = runWorkflow({
      args: {
        repository: 'coder/agent-tty',
        excludeLabels: ['blocked'],
        limit: 1,
      },
      issues: [
        issue(1, ['needs-triage', 'triage:done']),
        issue(2, ['needs-triage', 'triage:ongoing']),
        issue(3, ['needs-triage']),
      ],
    });

    expect(parallelSpecs.map((spec) => spec.id)).toEqual([
      'analyze-issue-3-v1',
    ]);
    expect(result.structuredOutput.drafted.map((item) => item.issue)).toEqual([
      3,
    ]);
    expect(result.structuredOutput.skippedDone).toEqual([1]);
    expect(result.structuredOutput.skippedOngoing).toEqual([2]);
  });

  it('enforces final labels reported by the analysis agent', () => {
    const { result } = runWorkflow({
      args: { repository: 'coder/agent-tty' },
      issues: [
        issue(1, ['needs-triage']),
        issue(2, ['needs-triage']),
        issue(3, ['needs-triage']),
        issue(4, ['needs-triage']),
      ],
      analyses: {
        1: analysisOutput(1, {
          triageReport: 'Should be skipped.',
          labelNames: ['needs-triage', 'TRIAGE:DONE'],
          summary: 'Done after final read.',
        }),
        2: analysisOutput(2, {
          triageReport: 'Should be deferred.',
          labelNames: ['needs-triage', 'TRIAGE:ONGOING'],
          summary: 'Ongoing after final read.',
        }),
        3: analysisOutput(3, {
          triageReport: 'Ready draft.',
          labelNames: ['needs-triage'],
          summary: 'Still ready.',
        }),
        4: analysisOutput(4, {
          status: 'skipped_done',
          triageReport: null,
          labelNames: ['needs-triage'],
          summary: 'Mismatched skipped done.',
        }),
      },
    });

    expect(result.structuredOutput.drafted.map((item) => item.issue)).toEqual([
      3,
    ]);
    expect(result.structuredOutput.skippedDone).toEqual([1]);
    expect(result.structuredOutput.deferred).toEqual([
      { issue: 2, reason: 'ongoing-label-present' },
      { issue: 4, reason: 'analysis-skipped-done-label-missing' },
    ]);
  });

  it('keeps issue list fetch body-free', () => {
    const { agentSpecs } = runWorkflow({
      args: { repository: 'coder/agent-tty' },
      issues: [issue(1, ['needs-triage'])],
    });

    const fetchPrompt = agentSpecs.find(
      (spec) => spec.id === 'fetch-issues',
    )?.prompt;
    expect(fetchPrompt).toContain(
      'number,title,url,state,labels,author,createdAt,updatedAt',
    );
    expect(fetchPrompt).not.toContain(
      'number,title,url,state,labels,author,createdAt,updatedAt,body',
    );
  });

  it('truncates issue bodies before embedding analysis prompts', () => {
    const longBody = 'z'.repeat(2505);
    const { parallelSpecs } = runWorkflow({
      args: { repository: 'coder/agent-tty' },
      issues: [issue(1, ['needs-triage'], 'open', longBody)],
    });

    expect(parallelSpecs).toHaveLength(1);
    expect(parallelSpecs[0]?.prompt).not.toContain(longBody);
    expect(parallelSpecs[0]?.prompt).toContain('[truncated 505 chars]');
    expect(parallelSpecs[0]?.prompt).toContain('"--jq"');
    expect(parallelSpecs[0]?.prompt).toContain('[0:20]');
    expect(parallelSpecs[0]?.prompt).not.toContain('deep-research');
  });

  it('rejects unsafe label and agent configuration before analysis', () => {
    expect(() =>
      runWorkflow({
        args: {
          repository: 'coder/agent-tty',
          doneLabel: 'bad\nlabel',
          excludeLabels: ['blocked'],
        },
      }),
    ).toThrow(/label values must be single-line/);

    expect(() =>
      runWorkflow({
        args: { repository: 'coder/agent-tty', agentId: 'desktop' },
      }),
    ).toThrow(/agentId must be explore or exec/);

    expect(() =>
      runWorkflow({
        args: {
          repository: 'coder/agent-tty',
          agentId: 'explore',
          investigationMode: 'prototype',
        },
      }),
    ).toThrow(/prototype investigation requires agentId exec/);
  });

  it('rejects unsupported publish modes before analysis', () => {
    expect(() =>
      runWorkflow({
        args: { repository: 'coder/agent-tty', publishMode: 'auto' },
      }),
    ).toThrow(/publishMode must be draft or plan/);

    expect(() =>
      runWorkflow({
        args: { repository: 'coder/agent-tty', publishMode: 'publish' },
      }),
    ).toThrow(/publishMode must be draft or plan/);
  });

  it('rejects contradictory label filters', () => {
    expect(() =>
      runWorkflow({
        args: {
          repository: 'coder/agent-tty',
          doneLabel: 'triage:done',
          ongoingLabel: 'TRIAGE:DONE',
        },
      }),
    ).toThrow(/doneLabel and ongoingLabel must be different labels/);

    expect(() =>
      runWorkflow({
        args: {
          repository: 'coder/agent-tty',
          includeLabels: ['triage:done'],
        },
      }),
    ).toThrow(/includeLabels must not include doneLabel/);

    expect(() =>
      runWorkflow({
        args: {
          repository: 'coder/agent-tty',
          includeLabels: ['triage:ongoing'],
        },
      }),
    ).toThrow(/includeLabels must not include ongoingLabel/);

    expect(() =>
      runWorkflow({
        args: {
          repository: 'coder/agent-tty',
          includeLabels: ['blocked'],
          excludeLabels: ['blocked'],
        },
      }),
    ).toThrow(/includeLabels and excludeLabels must not overlap/);
  });

  it('keeps draft mode non-publishing while preserving publish plans', () => {
    const { result, parallelSpecs } = runWorkflow({
      args: { repository: 'coder/agent-tty' },
      issues: [issue(1, ['needs-triage'])],
    });

    expect(parallelSpecs.map((spec) => spec.id)).toEqual([
      'analyze-issue-1-v1',
    ]);
    expect(result.structuredOutput.publishMode).toBe('draft');
    expect(result.structuredOutput.drafted[0]).toMatchObject({
      issue: 1,
      recommendedLabels: ['ready-for-agent'],
      labelsToAdd: ['ready-for-agent', 'triage:done'],
      labelsToRemove: [],
      reproductionStatus: 'reproduced',
      confidence: 'high',
    });
    expect(result.structuredOutput.drafted[0]?.publishableComment).toContain(
      'This triage report is AI-generated using Mux',
    );
  });

  it('flags labels outside the allowlist in the publish plan', () => {
    const { result, parallelSpecs } = runWorkflow({
      args: { repository: 'coder/agent-tty' },
      issues: [issue(1, ['needs-triage'])],
      analyses: {
        1: analysisOutput(1, {
          triageReport: 'Ready draft.',
          publishableComment: 'Ready public comment.',
          recommendedLabels: ['security-review'],
          reproductionStatus: 'not_applicable',
          commandsRun: [],
          observedBehavior: null,
          expectedBehavior: null,
          rootCause: null,
          confidence: 'medium',
          summary: 'Ready with disallowed label.',
        }),
      },
    });

    expect(parallelSpecs.map((spec) => spec.id)).toEqual([
      'analyze-issue-1-v1',
    ]);
    expect(result.structuredOutput.drafted[0]?.rejectedLabels).toEqual([
      'security-review',
    ]);
    expect(result.structuredOutput.drafted[0]?.labelsToAdd).toEqual([
      'triage:done',
    ]);
  });

  it('keeps mutation commands out of investigation prompts', () => {
    const { parallelSpecs } = runWorkflow({
      args: { repository: 'coder/agent-tty' },
      issues: [issue(1, ['needs-triage'])],
    });

    expect(parallelSpecs[0]?.prompt).not.toMatch(/gh issue (edit|comment)/);
    expect(parallelSpecs[0]?.prompt).not.toMatch(/--add-label|--remove-label/);
    expect(parallelSpecs[0]?.prompt).not.toContain('deep-research');
  });
});
