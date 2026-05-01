import { z } from 'zod';

import type { TriageComment, TriageIssue } from './eligibility.js';
import { runGh, runJson, type CommandRunner } from './gh.js';

const GH_ISSUE_LIST_LIMIT = 500;
// Avoid cwd-based repo inference when running from CI or a sandcastle worktree.
const GH_REPO_ARGS: readonly string[] = ['--repo', 'coder/agent-tty'];

const ghLabelSchema = z.looseObject({
  name: z.string(),
});

const ghAuthorSchema = z.looseObject({
  login: z.string().optional(),
});

export const ghCommentSchema = z.looseObject({
  body: z.string(),
  createdAt: z.string(),
  // `gh --json` returns `"author": null` for deleted / ghost accounts, so
  // accept both null and undefined. Downstream code already uses optional
  // chaining (`comment.author?.login`) so the runtime path tolerates both.
  author: ghAuthorSchema.nullish(),
});

export const ghIssueSchema = z.looseObject({
  number: z.number(),
  labels: z.array(ghLabelSchema),
  comments: z.array(ghCommentSchema).default([]),
  // Same as ghCommentSchema.author: GitHub returns null for deleted users.
  author: ghAuthorSchema.nullish(),
  createdAt: z.string().optional(),
});

const ghIssueListSchema = z.array(ghIssueSchema);

type GhIssue = z.infer<typeof ghIssueSchema>;

/**
 * List candidate issues for a Triage Batch and normalize them into the
 * orchestrator-facing TriageIssue shape. Always queries `needs-triage`;
 * also queries `needs-info` when `includeNeedsInfo` is true. The runner
 * parameter exists so unit tests can inject canned `gh` output without
 * spawning real processes; production callers should let it default to
 * `runGh`.
 */
export function listCandidateIssues(
  includeNeedsInfo: boolean,
  runner: CommandRunner = runGh,
): TriageIssue[] {
  const issues = [listIssuesByLabel('needs-triage', runner)];
  if (includeNeedsInfo) {
    issues.push(listIssuesByLabel('needs-info', runner));
  }

  return issues.flat().map(normalizeGhIssue).filter(uniqueIssueFilter());
}

function listIssuesByLabel(label: string, runner: CommandRunner): GhIssue[] {
  return runJson(
    'gh',
    [
      'issue',
      'list',
      ...GH_REPO_ARGS,
      '--label',
      label,
      '--state',
      'open',
      '--limit',
      String(GH_ISSUE_LIST_LIMIT),
      '--json',
      'number,labels,comments,author,createdAt',
    ],
    ghIssueListSchema,
    runner,
  );
}

function normalizeGhIssue(issue: GhIssue): TriageIssue {
  return {
    number: issue.number,
    labels: issue.labels.map((label) => label.name),
    comments: issue.comments.map(normalizeGhComment),
  };
}

function normalizeGhComment(
  comment: z.infer<typeof ghCommentSchema>,
): TriageComment {
  const author =
    comment.author?.login === undefined
      ? undefined
      : { login: comment.author.login };

  return {
    body: comment.body,
    createdAt: comment.createdAt,
    ...(author === undefined ? {} : { author }),
  };
}

function uniqueIssueFilter(): (issue: TriageIssue) => boolean {
  const seen = new Set<number>();

  return (issue) => {
    if (seen.has(issue.number)) {
      return false;
    }

    seen.add(issue.number);
    return true;
  };
}
