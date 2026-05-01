import { pathToFileURL } from 'node:url';

import { Command, CommanderError } from 'commander';
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
import { conciseErrorMessage, isLockError } from './lib/errorMessage.js';
import { runCoder, runCoderAsync, runGh, runJson } from './lib/gh.js';
import { parseParallelism } from './lib/parallelism.js';
import { workspaceNameForIssue } from './lib/workspaceName.js';

const TRIAGE_AGENT_IDLE_TIMEOUT_SECONDS = 1800;
const GH_ISSUE_LIST_LIMIT = 500;
// Avoid cwd-based repo inference when running from CI or a sandcastle worktree.
const GH_REPO_ARGS: readonly string[] = ['--repo', 'coder/agent-tty'];

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
        // Wrap `task()` in `Promise.resolve().then(...)` so a synchronous
        // throw inside a non-async caller still becomes a rejection. Without
        // this, a sync throw would skip the `.finally()` decrement, leaking
        // a concurrency slot permanently and stalling the batch after
        // `concurrency` such failures.
        Promise.resolve()
          .then(task)
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
    perIssue: perIssue.toSorted(
      (left, right) => left.issueNumber - right.issueNumber,
    ),
    ...(message === undefined ? {} : { message }),
  };
}

function buildRunnerProgram(): Command {
  return (
    new Command()
      .name('afk-triage')
      .description(
        'Fan out Claude Code triage agents across needs-triage / needs-info issues',
      )
      .option(
        '--parallelism <n>',
        'Concurrent triage agents (overrides TRIAGE_PARALLELISM env, default 5)',
      )
      .option(
        '--no-include-needs-info',
        'Exclude needs-info issues from triage (included by default)',
      )
      .option(
        '--dry-run',
        'List eligible issues without provisioning Coder workspaces',
      )
      .exitOverride()
      // Keep help and usage on stderr so stdout remains JSON-only.
      .configureOutput({
        writeOut: (str) => process.stderr.write(str),
        writeErr: (str) => process.stderr.write(str),
      })
  );
}

export function parseRunnerArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): RunnerArgs {
  const program = buildRunnerProgram();
  program.parse([...argv], { from: 'user' });

  const opts = program.opts<{
    parallelism?: string;
    includeNeedsInfo?: boolean;
    dryRun?: boolean;
  }>();

  return {
    parallelism: parseParallelism(opts.parallelism ?? env.TRIAGE_PARALLELISM),
    includeNeedsInfo: opts.includeNeedsInfo !== false,
    dryRun: opts.dryRun === true,
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
  runJson('coder', ['whoami', '-o', 'json'], z.unknown(), runCoder);
}

function listCandidateIssues(includeNeedsInfo: boolean): GhIssue[] {
  const issues = [listIssuesByLabel('needs-triage')];
  if (includeNeedsInfo) {
    issues.push(listIssuesByLabel('needs-info'));
  }

  return issues.flat();
}

function listIssuesByLabel(label: string): GhIssue[] {
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
    runGh,
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

const activeSandboxes = new Map<Sandbox, number>();
const pendingWorkspaceNames = new Map<string, number>();

// Set synchronously before cleanup awaits so newly dequeued tasks do not
// create workspaces outside the cleanup snapshot.
let shutdownRequested = false;

async function runTriageAgent(
  issue: TriageIssue,
  runId: string,
): Promise<TriageIssueSummary> {
  let workspaceName: string | undefined;
  let sandbox: Sandbox | undefined;
  let result: TriageIssueSummary | undefined;

  if (shutdownRequested) {
    return {
      issueNumber: issue.number,
      status: 'skipped',
      message: 'shutdown requested',
    };
  }

  try {
    workspaceName = workspaceNameForIssue(issue.number);
    const { createSandbox, claudeCode } = await import('@ai-hero/sandcastle');
    const coderOptions: CoderOptions = {
      template: 'coder',
      preset: 'Falkenstein',
      workspaceName,
      onClose: 'delete',
    };

    // Re-check the shutdown flag after the `await import(...)` yield.
    // Even on a module-cache hit, dynamic import yields once to the
    // microtask queue; a SIGINT during that microtask sets
    // `shutdownRequested = true` and snapshots empty maps. Without this
    // re-check the resumed task would still call createSandbox below
    // and orphan the resulting workspace when `process.exit()` fires,
    // because there are no further await points between the
    // pendingWorkspaceNames.set() call and the createSandbox call.
    if (shutdownRequested) {
      return {
        issueNumber: issue.number,
        status: 'skipped',
        message: 'shutdown requested',
      };
    }

    pendingWorkspaceNames.set(workspaceName, issue.number);
    try {
      // Use sandcastle's HEAD default for the base branch so AFK triage sees this checkout.
      sandbox = await createSandbox({
        branch: branchNameForIssue(issue.number, runId),
        sandbox: coder(coderOptions),
        hooks: {
          sandbox: {
            onSandboxReady: [
              { command: 'gh auth status' },
              // Sandcastle syncs git-tracked files only; install deps before triage.
              { command: 'npm ci' },
              { command: 'npm install -g @anthropic-ai/claude-code' },
            ],
          },
        },
      });
      activeSandboxes.set(sandbox, issue.number);
    } finally {
      pendingWorkspaceNames.delete(workspaceName);
    }

    await sandbox.run({
      agent: claudeCode('claude-opus-4-6'),
      promptFile: '.sandcastle/triage-prompt.md',
      promptArgs: {
        ISSUE_NUMBER: String(issue.number),
      },
      idleTimeoutSeconds: TRIAGE_AGENT_IDLE_TIMEOUT_SECONDS,
    });

    result = {
      issueNumber: issue.number,
      status: 'success',
    };
  } catch (error) {
    console.error(`[issue ${issue.number}]`, error);
    result = {
      issueNumber: issue.number,
      status:
        workspaceName !== undefined && isLockError(error, workspaceName)
          ? 'locked'
          : 'failed',
      message: conciseErrorMessage(error),
    };
  } finally {
    // Skip close when the sandbox was already cleaned up by the signal
    // handler (closeActiveSandboxes). Otherwise we would call `coder
    // delete` twice on the same workspace; the second call fails because
    // the workspace is gone, the catch fires, and a successful triage
    // gets silently overwritten with a misleading `close failed: workspace
    // not found` message. Membership in `activeSandboxes` is the
    // single-owner protocol that disambiguates "still ours to close"
    // from "signal handler took it".
    if (sandbox !== undefined && activeSandboxes.has(sandbox)) {
      activeSandboxes.delete(sandbox);
      try {
        await sandbox.close();
      } catch (closeError) {
        console.error(`[issue ${issue.number}] close failed`, closeError);
        const closeMessage = `close failed: ${conciseErrorMessage(closeError)}`;
        result = {
          issueNumber: issue.number,
          status: 'failed',
          message:
            result === undefined
              ? closeMessage
              : `${result.message ?? `original status: ${result.status}`}; ${closeMessage}`,
        };
      }
    }
  }

  return result;
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

function signalExitCode(signal: NodeJS.Signals): number {
  return signal === 'SIGINT' ? 130 : 143;
}

async function closeActiveSandboxes(): Promise<void> {
  const sandboxEntries = Array.from(activeSandboxes.entries());
  const pendingEntries = Array.from(pendingWorkspaceNames.entries());
  activeSandboxes.clear();
  pendingWorkspaceNames.clear();

  const sandboxResults = await Promise.allSettled(
    sandboxEntries.map(async ([sandbox]) => {
      await sandbox.close();
    }),
  );

  for (const [index, settled] of sandboxResults.entries()) {
    const entry = sandboxEntries[index];
    if (entry === undefined) {
      continue;
    }
    const [, issueNumber] = entry;
    if (settled.status === 'fulfilled') {
      console.error(`[issue ${issueNumber}] sandbox closed during shutdown`);
    } else {
      console.error(
        `[issue ${issueNumber}] sandbox close failed during shutdown — workspace may be stranded:`,
        settled.reason,
      );
    }
  }

  // Reap any workspaces whose `coder create` returned a workspace on the
  // control plane but whose `createSandbox` did not yet resolve a Sandbox
  // instance for us to close via the normal path. Direct
  // `coder delete <name> --yes` is the closest equivalent to the
  // `onClose: 'delete'` semantics for the `Sandbox.close()` path.
  //
  // Use the async runCoderAsync (spawn) variant rather than the sync
  // runCoder (spawnSync) one: the synchronous variant blocks the event
  // loop, which would prevent a second SIGINT from being delivered to
  // the force-exit branch of installSignalHandlers while a hung
  // `coder delete` is in progress. The async variant yields between
  // chunks so that escape hatch keeps working.
  const pendingResults = await Promise.allSettled(
    pendingEntries.map(([workspaceName]) =>
      runCoderAsync(['delete', workspaceName, '--yes']),
    ),
  );

  for (const [index, settled] of pendingResults.entries()) {
    const entry = pendingEntries[index];
    if (entry === undefined) {
      continue;
    }
    const [workspaceName, issueNumber] = entry;
    if (settled.status === 'rejected') {
      console.error(
        `[issue ${issueNumber}] in-flight workspace ${workspaceName} delete threw during shutdown — workspace may be stranded:`,
        settled.reason,
      );
      continue;
    }
    if (settled.value.status === 0) {
      console.error(
        `[issue ${issueNumber}] in-flight workspace ${workspaceName} deleted during shutdown`,
      );
    } else {
      console.error(
        `[issue ${issueNumber}] in-flight workspace ${workspaceName} delete failed during shutdown (status ${settled.value.status}) — workspace may be stranded: ${settled.value.stderr.trim()}`,
      );
    }
  }
}

function installSignalHandlers(): void {
  let signalled = false;
  const handle = (signal: NodeJS.Signals): void => {
    // Let a second signal escape hung workspace cleanup.
    if (signalled) {
      console.error(
        `[afk-triage] second ${signal}; force-exiting (cleanup in progress; remaining sandboxes will rely on template TTL)`,
      );
      process.exit(signalExitCode(signal));
    }
    signalled = true;
    shutdownRequested = true;
    console.error(
      `[afk-triage] received ${signal}; closing ${activeSandboxes.size} active sandboxes and ${pendingWorkspaceNames.size} in-flight workspaces (send ${signal} again to force-exit)`,
    );
    closeActiveSandboxes().finally(() => {
      process.exit(signalExitCode(signal));
    });
  };

  process.on('SIGINT', handle);
  process.on('SIGTERM', handle);
}

async function main(): Promise<void> {
  process.env['CODER_WORKSPACE_USE_PARAMETER_DEFAULTS'] = 'true';
  installSignalHandlers();

  try {
    const args = parseRunnerArgs(process.argv.slice(2), process.env);
    const summary = await runBatch(args);
    printSummary(summary);
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exitCode =
        error.code === 'commander.helpDisplayed' ||
        error.code === 'commander.version'
          ? 0
          : 2;
      return;
    }
    console.error('[afk-triage] batch failed', error);
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
