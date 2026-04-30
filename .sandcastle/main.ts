import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import type { Sandbox } from '@ai-hero/sandcastle';

import { invariant } from '../src/util/assert.js';
import { coder, type CoderOptions } from './vendor/sandcastle-coder/coder.js';
import { branchNameForIssue, assertRunId } from './lib/branchName.js';
import {
  classifyIssueForTriage,
  type TriageComment,
  type TriageIssue,
} from './lib/eligibility.js';
import { runCoder, runGhJson } from './lib/gh.js';
import { parseParallelism } from './lib/parallelism.js';
import { workspaceNameForIssue } from './lib/workspaceName.js';

export type TriageIssueStatus = 'success' | 'locked' | 'failed' | 'skipped';

export interface TriageIssueSummary {
  readonly issueNumber: number;
  readonly status: TriageIssueStatus;
  readonly message?: string;
}

export interface TriageBatchSummary {
  readonly runId: string;
  readonly totals: Record<TriageIssueStatus, number>;
  readonly perIssue: readonly TriageIssueSummary[];
  readonly message?: string;
}

interface RunnerArgs {
  readonly parallelism: number;
  readonly includeNeedsInfo: boolean;
  readonly dryRun: boolean;
}

const ghLabelSchema = z.looseObject({
  name: z.string(),
});

const ghAuthorSchema = z.looseObject({
  login: z.string().optional(),
});

const ghCommentSchema = z.looseObject({
  body: z.string(),
  createdAt: z.string(),
  author: ghAuthorSchema.optional(),
});

const ghIssueSchema = z.looseObject({
  number: z.number(),
  labels: z.array(ghLabelSchema),
  comments: z.array(ghCommentSchema).default([]),
  author: ghAuthorSchema.optional(),
  createdAt: z.string().optional(),
});

const ghIssueListSchema = z.array(ghIssueSchema);

type GhIssue = z.infer<typeof ghIssueSchema>;

export function pLimit(concurrency: number) {
  invariant(
    Number.isInteger(concurrency) && concurrency > 0,
    'concurrency must be a positive integer',
  );

  let active = 0;
  const queue: Array<() => void> = [];

  function runNext(): void {
    if (active >= concurrency) {
      return;
    }

    const next = queue.shift();
    if (next === undefined) {
      return;
    }

    active += 1;
    next();
  }

  return function limit<T>(task: () => Promise<T>): Promise<T> {
    invariant(typeof task === 'function', 'limited task must be a function');

    return new Promise<T>((resolve, reject) => {
      const run = (): void => {
        task()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            runNext();
          });
      };

      if (active < concurrency) {
        active += 1;
        run();
        return;
      }

      queue.push(run);
    });
  };
}

export function buildTriageBatchSummary(
  runId: string,
  perIssue: readonly TriageIssueSummary[],
  message?: string,
): TriageBatchSummary {
  const checkedRunId = assertRunId(runId);
  const totals: Record<TriageIssueStatus, number> = {
    success: 0,
    locked: 0,
    failed: 0,
    skipped: 0,
  };

  for (const issue of perIssue) {
    totals[issue.status] += 1;
  }

  return {
    runId: checkedRunId,
    totals,
    perIssue: [...perIssue].sort(
      (left, right) => left.issueNumber - right.issueNumber,
    ),
    ...(message === undefined ? {} : { message }),
  };
}

export function parseRunnerArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): RunnerArgs {
  let rawParallelism: string | undefined;
  let includeNeedsInfo = true;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    invariant(arg !== undefined, 'argument must exist while parsing argv');

    if (arg === '--parallelism') {
      const value = argv[index + 1];
      invariant(value !== undefined, '--parallelism requires a value');
      rawParallelism = value;
      index += 1;
      continue;
    }

    if (arg.startsWith('--parallelism=')) {
      rawParallelism = arg.slice('--parallelism='.length);
      continue;
    }

    if (arg === '--include-needs-info') {
      includeNeedsInfo = true;
      continue;
    }

    if (arg === '--no-include-needs-info') {
      includeNeedsInfo = false;
      continue;
    }

    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  return {
    parallelism: parseParallelism(rawParallelism ?? env.TRIAGE_PARALLELISM),
    includeNeedsInfo,
    dryRun,
  };
}

async function runBatch(args: RunnerArgs): Promise<TriageBatchSummary> {
  const runId = createRunId();

  if (!args.dryRun) {
    preflightCoder();
  }

  const issues = listCandidateIssues(args.includeNeedsInfo)
    .map(normalizeGhIssue)
    .filter(uniqueIssueFilter());

  const perIssue: TriageIssueSummary[] = [];
  const eligibleIssues: TriageIssue[] = [];

  for (const issue of issues) {
    const eligibility = classifyIssueForTriage(issue);
    if (!eligibility.eligible) {
      perIssue.push({
        issueNumber: issue.number,
        status: 'skipped',
        message: eligibility.reason,
      });
      continue;
    }

    if (args.dryRun) {
      perIssue.push({
        issueNumber: issue.number,
        status: 'skipped',
        message: 'dry-run',
      });
      continue;
    }

    eligibleIssues.push(issue);
  }

  const limit = pLimit(args.parallelism);
  const completed = await Promise.all(
    eligibleIssues.map((issue) => limit(() => runTriageAgent(issue, runId))),
  );
  perIssue.push(...completed);

  return buildTriageBatchSummary(runId, perIssue);
}

function preflightCoder(): void {
  const result = runCoder(['whoami', '-o', 'json']);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || `exit status ${result.status}`;
    throw new Error(`coder whoami -o json failed: ${detail}`);
  }

  try {
    JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `coder whoami -o json returned invalid JSON: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function listCandidateIssues(includeNeedsInfo: boolean): GhIssue[] {
  const issues = [listIssuesByLabel('needs-triage')];
  if (includeNeedsInfo) {
    issues.push(listIssuesByLabel('needs-info'));
  }

  return issues.flat();
}

function listIssuesByLabel(label: string): GhIssue[] {
  return runGhJson(
    [
      'issue',
      'list',
      '--label',
      label,
      '--state',
      'open',
      '--json',
      'number,labels,comments,author,createdAt',
    ],
    ghIssueListSchema,
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

async function runTriageAgent(
  issue: TriageIssue,
  runId: string,
): Promise<TriageIssueSummary> {
  const workspaceName = workspaceNameForIssue(issue.number);
  let sandbox: Sandbox | undefined;
  let result: TriageIssueSummary | undefined;

  try {
    const { createSandbox, claudeCode } = await import('@ai-hero/sandcastle');
    const coderOptions: CoderOptions = {
      template: 'coder',
      preset: 'Falkenstein',
      workspaceName,
      onClose: 'delete',
    };

    sandbox = await createSandbox({
      branch: branchNameForIssue(issue.number, runId),
      baseBranch: 'origin/main',
      sandbox: coder(coderOptions),
      hooks: {
        sandbox: {
          onSandboxReady: [{ command: 'gh auth status' }],
        },
      },
    });

    await sandbox.run({
      agent: claudeCode('claude-opus-4-6'),
      promptFile: '.sandcastle/triage-prompt.md',
      promptArgs: {
        ISSUE_NUMBER: String(issue.number),
      },
      idleTimeoutSeconds: 1800,
    });

    result = {
      issueNumber: issue.number,
      status: 'success',
    };
  } catch (error) {
    result = {
      issueNumber: issue.number,
      status: isLockError(error, workspaceName) ? 'locked' : 'failed',
      message: conciseErrorMessage(error),
    };
  } finally {
    if (sandbox !== undefined) {
      try {
        await sandbox.close();
      } catch (error) {
        result = {
          issueNumber: issue.number,
          status: 'failed',
          message: `close failed: ${conciseErrorMessage(error)}`,
        };
      }
    }
  }

  return result;
}

function isLockError(error: unknown, workspaceName: string): boolean {
  const message = conciseErrorMessage(error).toLowerCase();
  return (
    message.includes('coder create') ||
    message.includes('already exists') ||
    message.includes(workspaceName.toLowerCase())
  );
}

function conciseErrorMessage(error: unknown): string {
  return errorMessage(error).split('\n')[0]?.trim() || 'unknown error';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createRunId(date = new Date()): string {
  const runId = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(
    date.getUTCDate(),
  )}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(
    date.getUTCSeconds(),
  )}Z`;

  return assertRunId(runId);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

async function main(): Promise<void> {
  const args = parseRunnerArgs(process.argv.slice(2), process.env);

  try {
    const summary = await runBatch(args);
    printSummary(summary);
  } catch (error) {
    const runId = createRunId();
    const summary = buildTriageBatchSummary(
      runId,
      [],
      conciseErrorMessage(error),
    );
    printSummary(summary);
    process.exitCode = 1;
  }
}

function printSummary(summary: TriageBatchSummary): void {
  console.log(JSON.stringify(summary, null, 2));
  console.error(
    `AFK triage ${summary.runId}: ${summary.totals.success} success, ${summary.totals.locked} locked, ${summary.totals.failed} failed, ${summary.totals.skipped} skipped`,
  );
  if (summary.message !== undefined) {
    console.error(summary.message);
  }
}

if (process.argv[1] !== undefined) {
  const entrypoint = pathToFileURL(process.argv[1]).href;
  if (import.meta.url === entrypoint) {
    await main();
  }
}
