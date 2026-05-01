import { describe, expect, it } from 'vitest';

import type { CommandResult } from '../../../.sandcastle/lib/gh.js';
import {
  ghCommentSchema,
  ghIssueSchema,
  listCandidateIssues,
} from '../../../.sandcastle/lib/issueSource.js';

describe('ghCommentSchema null-author handling', () => {
  it('accepts comments with null author (ghost/deleted accounts)', () => {
    expect(() =>
      ghCommentSchema.parse({
        body: 'comment from a ghost account',
        createdAt: '2026-04-30T14:15:00Z',
        author: null,
      }),
    ).not.toThrow();
  });

  it('accepts comments with undefined author', () => {
    expect(() =>
      ghCommentSchema.parse({
        body: 'comment with no author key',
        createdAt: '2026-04-30T14:15:00Z',
      }),
    ).not.toThrow();
  });

  it('accepts comments with a normal author object', () => {
    expect(() =>
      ghCommentSchema.parse({
        body: 'normal comment',
        createdAt: '2026-04-30T14:15:00Z',
        author: { login: 'alice' },
      }),
    ).not.toThrow();
  });
});

describe('ghIssueSchema null-author handling', () => {
  it('accepts issues with null author and a comment whose author is null', () => {
    expect(() =>
      ghIssueSchema.parse({
        number: 42,
        labels: [{ name: 'needs-triage' }],
        author: null,
        createdAt: '2026-04-30T12:00:00Z',
        comments: [
          {
            body: 'orphaned comment',
            createdAt: '2026-04-30T13:00:00Z',
            author: null,
          },
        ],
      }),
    ).not.toThrow();
  });
});

interface RecordedCall {
  readonly args: readonly string[];
}

function recordingRunner(responses: Record<string, unknown>): {
  calls: RecordedCall[];
  runner: (args: readonly string[]) => CommandResult;
} {
  const calls: RecordedCall[] = [];

  const runner = (args: readonly string[]): CommandResult => {
    calls.push({ args });
    const labelIndex = args.indexOf('--label');
    const label = labelIndex >= 0 ? args[labelIndex + 1] : undefined;
    if (label === undefined || !(label in responses)) {
      throw new Error(`unexpected label in test runner: ${String(label)}`);
    }
    return {
      stdout: JSON.stringify(responses[label]),
      stderr: '',
      status: 0,
    };
  };

  return { calls, runner };
}

describe('listCandidateIssues', () => {
  it('queries only needs-triage when includeNeedsInfo is false', () => {
    const { calls, runner } = recordingRunner({
      'needs-triage': [
        {
          number: 1,
          labels: [{ name: 'needs-triage' }],
          comments: [],
        },
      ],
    });

    const issues = listCandidateIssues(false, runner);

    expect(issues).toEqual([
      { number: 1, labels: ['needs-triage'], comments: [] },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      'issue',
      'list',
      '--repo',
      'coder/agent-tty',
      '--label',
      'needs-triage',
      '--state',
      'open',
      '--limit',
      '500',
      '--json',
      'number,labels,comments,author,createdAt',
    ]);
  });

  it('queries both labels when includeNeedsInfo is true', () => {
    const { calls, runner } = recordingRunner({
      'needs-triage': [],
      'needs-info': [],
    });

    listCandidateIssues(true, runner);

    expect(
      calls.map((call) => call.args[call.args.indexOf('--label') + 1]),
    ).toEqual(['needs-triage', 'needs-info']);
  });

  it('normalizes labels and comments into the orchestrator-facing shape', () => {
    const { runner } = recordingRunner({
      'needs-triage': [
        {
          number: 7,
          labels: [{ name: 'bug' }, { name: 'needs-triage' }],
          comments: [
            {
              body: 'first',
              createdAt: '2026-04-30T12:00:00Z',
              author: { login: 'alice' },
            },
            {
              body: 'orphan',
              createdAt: '2026-04-30T13:00:00Z',
              author: null,
            },
          ],
        },
      ],
    });

    const issues = listCandidateIssues(false, runner);

    expect(issues).toEqual([
      {
        number: 7,
        labels: ['bug', 'needs-triage'],
        comments: [
          {
            body: 'first',
            createdAt: '2026-04-30T12:00:00Z',
            author: { login: 'alice' },
          },
          {
            body: 'orphan',
            createdAt: '2026-04-30T13:00:00Z',
          },
        ],
      },
    ]);
  });

  it('deduplicates issues that appear under both labels and preserves first-seen order', () => {
    const { runner } = recordingRunner({
      'needs-triage': [
        { number: 10, labels: [{ name: 'needs-triage' }], comments: [] },
        { number: 11, labels: [{ name: 'needs-triage' }], comments: [] },
      ],
      'needs-info': [
        // Duplicate of #10 with stale label snapshot — must be dropped.
        { number: 10, labels: [{ name: 'needs-info' }], comments: [] },
        { number: 12, labels: [{ name: 'needs-info' }], comments: [] },
      ],
    });

    const issues = listCandidateIssues(true, runner);

    expect(issues.map((issue) => issue.number)).toEqual([10, 11, 12]);
    // The first-seen issue (from needs-triage) wins.
    expect(issues[0]?.labels).toEqual(['needs-triage']);
  });
});
