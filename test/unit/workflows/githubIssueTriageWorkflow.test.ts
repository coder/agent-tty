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
  publishableComment?: string | null;
  recommendedLabels?: string[];
  reproductionStatus?:
    | 'reproduced'
    | 'not_reproduced'
    | 'not_applicable'
    | 'deferred';
  commandsRun?: string[];
  observedBehavior?: string | null;
  expectedBehavior?: string | null;
  rootCause?: string | null;
  prototypeSummary?: string | null;
  confidence?: 'high' | 'medium' | 'low';
  labelNames: string[];
  summary: string;
};

type PublishOutput = {
  issue: number;
  status: 'published' | 'already_published' | 'deferred';
  reason: string;
  commentUrl: string | null;
  labelsAdded: string[];
  labelsRemoved: string[];
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
    published: Array<{
      issue: number;
      commentUrl: string;
      status: string;
      labelsAdded: string[];
      labelsRemoved: string[];
    }>;
    publishDeferred: Array<{
      issue?: number;
      reason: string;
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

function runWorkflow(options: {
  args?: Record<string, unknown>;
  issues?: Issue[];
  analyses?: Record<number, AnalysisOutput>;
  publications?: Record<number, PublishOutput>;
  listed?: {
    repository?: string;
    fetchedCount?: number;
    eligibleCount?: number;
    truncated?: boolean;
  };
}) {
  const module = loadWorkflow();
  const issues = options.issues ?? [];
  const agentSpecs: AgentSpec[] = [];
  const parallelSpecs: AgentSpec[] = [];

  const result = module.workflow({
    args: options.args ?? { repository: 'coder/agent-tty' },
    phase: () => {},
    log: () => {},
    agent: (spec) => {
      agentSpecs.push(spec);
      if (spec.id === 'resolve-context') {
        return {
          structuredOutput: {
            cwd: null,
            gitRoot: null,
            repository: 'coder/agent-tty',
            repositorySource: 'test',
          },
        };
      }
      if (spec.id === 'fetch-issues') {
        return {
          structuredOutput: {
            repository: options.listed?.repository ?? 'coder/agent-tty',
            filters: {
              state: 'open',
              includeLabels: ['needs-triage'],
              excludeLabels: ['triage:done'],
              limit: 1000,
              fetchLimit: 1000,
            },
            fetchedCount: options.listed?.fetchedCount ?? issues.length,
            eligibleCount: options.listed?.eligibleCount ?? issues.length,
            truncated: options.listed?.truncated ?? false,
            issues,
          },
        };
      }
      throw new Error('unexpected agent spec: ' + spec.id);
    },
    parallelAgents: (specs, options) => {
      expect(options.maxParallel).toBe(8);
      parallelSpecs.push(...specs);
      return specs.map((spec) => {
        const issue = Number(spec.id.match(/issue-(\d+)/)?.[1]);
        if (spec.id.startsWith('publish-issue-')) {
          return {
            structuredOutput: publishOutputByIssue(issue),
          };
        }
        return {
          structuredOutput: optionsByIssue(options, issue),
        };
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
    return (
      options.analyses?.[issue] ?? {
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
      }
    );
  }

  function publishOutputByIssue(issue: number): PublishOutput {
    return (
      options.publications?.[issue] ?? {
        issue,
        status: 'published',
        reason: '',
        commentUrl: `https://github.com/coder/agent-tty/issues/${issue}#issuecomment-1`,
        labelsAdded: ['ready-for-agent', 'triage:done'],
        labelsRemoved: ['triage:ongoing'],
      }
    );
  }
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
        1: {
          issue: 1,
          status: 'ready',
          reason: '',
          triageReport: 'Should be skipped.',
          labelNames: ['needs-triage', 'TRIAGE:DONE'],
          summary: 'Done after final read.',
        },
        2: {
          issue: 2,
          status: 'ready',
          reason: '',
          triageReport: 'Should be deferred.',
          labelNames: ['needs-triage', 'TRIAGE:ONGOING'],
          summary: 'Ongoing after final read.',
        },
        3: {
          issue: 3,
          status: 'ready',
          reason: '',
          triageReport: 'Ready draft.',
          labelNames: ['needs-triage'],
          summary: 'Still ready.',
        },
        4: {
          issue: 4,
          status: 'skipped_done',
          reason: '',
          triageReport: null,
          labelNames: ['needs-triage'],
          summary: 'Mismatched skipped done.',
        },
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

  it('rejects unsafe publish configuration before analysis', () => {
    expect(() =>
      runWorkflow({
        args: { repository: 'coder/agent-tty', publishMode: 'auto' },
      }),
    ).toThrow(/publishMode must be draft or publish/);

    expect(() =>
      runWorkflow({
        args: {
          repository: 'coder/agent-tty',
          publishMode: 'publish',
          publishAgentId: 'explore',
        },
      }),
    ).toThrow(/publishMode publish requires publishAgentId exec/);
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
    expect(result.structuredOutput.published).toEqual([]);
    expect(result.structuredOutput.drafted[0]).toMatchObject({
      issue: 1,
      recommendedLabels: ['ready-for-agent'],
      labelsToAdd: ['ready-for-agent', 'triage:done'],
      labelsToRemove: ['triage:ongoing'],
      reproductionStatus: 'reproduced',
      confidence: 'high',
    });
    expect(result.structuredOutput.drafted[0]?.publishableComment).toContain(
      'This triage report is AI-generated using Mux',
    );
  });

  it('publishes comments and labels only in explicit publish mode', () => {
    const { result, parallelSpecs } = runWorkflow({
      args: { repository: 'coder/agent-tty', publishMode: 'publish' },
      issues: [issue(1, ['needs-triage'])],
    });

    expect(parallelSpecs.map((spec) => spec.id)).toEqual([
      'analyze-issue-1-v1',
      'publish-issue-1-v1',
    ]);
    const publishSpec = parallelSpecs[1];
    expect(publishSpec?.agentId).toBe('exec');
    expect(publishSpec?.isolation).toBe('fork');
    expect(publishSpec?.prompt).toContain('gh issue comment');
    expect(publishSpec?.prompt).toContain('gh issue edit');
    expect(result.structuredOutput.published).toEqual([
      {
        issue: 1,
        commentUrl:
          'https://github.com/coder/agent-tty/issues/1#issuecomment-1',
        status: 'published',
        labelsAdded: ['ready-for-agent', 'triage:done'],
        labelsRemoved: ['triage:ongoing'],
      },
    ]);
  });

  it('does not publish when analysis recommends labels outside the allowlist', () => {
    const { result, parallelSpecs } = runWorkflow({
      args: { repository: 'coder/agent-tty', publishMode: 'publish' },
      issues: [issue(1, ['needs-triage'])],
      analyses: {
        1: {
          issue: 1,
          status: 'ready',
          reason: '',
          triageReport: 'Ready draft.',
          publishableComment: 'Ready public comment.',
          recommendedLabels: ['security-review'],
          reproductionStatus: 'not_applicable',
          commandsRun: [],
          observedBehavior: null,
          expectedBehavior: null,
          rootCause: null,
          prototypeSummary: null,
          confidence: 'medium',
          labelNames: ['needs-triage'],
          summary: 'Ready with disallowed label.',
        },
      },
    });

    expect(parallelSpecs.map((spec) => spec.id)).toEqual([
      'analyze-issue-1-v1',
    ]);
    expect(result.structuredOutput.drafted[0]?.rejectedLabels).toEqual([
      'security-review',
    ]);
    expect(result.structuredOutput.publishDeferred).toEqual([
      {
        issue: 1,
        reason: 'recommended-label-not-allowed-security-review',
      },
    ]);
    expect(result.structuredOutput.published).toEqual([]);
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
