import { pathToFileURL } from 'node:url';

import { Command, CommanderError } from 'commander';
import { z } from 'zod';

import { assertRunId, createRunId } from './lib/afkIdentity.js';
import {
  createTriageBatchRunner,
  type TriageBatchRunner,
  type TriageIssueStatus,
  type TriageIssueSummary,
} from './lib/batchRunner.js';
import { classifyIssueForTriage, type TriageIssue } from './lib/eligibility.js';
import { conciseErrorMessage } from './lib/errorMessage.js';
import { runCoder, runJson } from './lib/gh.js';
import { listCandidateIssues } from './lib/issueSource.js';
import { parseParallelism } from './lib/parallelism.js';

export { pLimit } from './lib/pLimit.js';
export type {
  TriageIssueStatus,
  TriageIssueSummary,
} from './lib/batchRunner.js';

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

async function runBatch(
  args: RunnerArgs,
  batchRunner: TriageBatchRunner,
): Promise<TriageBatchSummary> {
  const runId = createRunId();

  if (!args.dryRun) {
    preflightCoder();
  }

  const issues = listCandidateIssues(args.includeNeedsInfo);

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

  const completed = await batchRunner.run(eligibleIssues, {
    runId,
    parallelism: args.parallelism,
  });
  perIssue.push(...completed);

  return buildTriageBatchSummary(runId, perIssue);
}

function preflightCoder(): void {
  runJson('coder', ['whoami', '-o', 'json'], z.unknown(), runCoder);
}

function signalExitCode(signal: NodeJS.Signals): number {
  return signal === 'SIGINT' ? 130 : 143;
}

function installSignalHandlers(batchRunner: TriageBatchRunner): void {
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
    const status = batchRunner.status;
    console.error(
      `[afk-triage] received ${signal}; closing ${status.active} active sandboxes and ${status.pending} in-flight workspaces (send ${signal} again to force-exit)`,
    );
    // requestShutdown sets the runner's shutdown flag synchronously before
    // any await, then resolves once cleanup finishes; the .finally() exit
    // mirrors the previous closeActiveSandboxes().finally() semantics.
    batchRunner.requestShutdown().finally(() => {
      process.exit(signalExitCode(signal));
    });
  };

  process.on('SIGINT', handle);
  process.on('SIGTERM', handle);
}

async function main(): Promise<void> {
  process.env['CODER_WORKSPACE_USE_PARAMETER_DEFAULTS'] = 'true';
  const batchRunner = createTriageBatchRunner();
  installSignalHandlers(batchRunner);

  try {
    const args = parseRunnerArgs(process.argv.slice(2), process.env);
    const summary = await runBatch(args, batchRunner);
    printSummary(summary);
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exitCode = error.code === 'commander.helpDisplayed' ? 0 : 2;
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
