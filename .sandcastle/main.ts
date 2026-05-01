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
import { conciseErrorMessage, isLockError } from './lib/errorMessage.js';
import { runCoder, runCoderAsync, runGh, runJson } from './lib/gh.js';
import { parseParallelism } from './lib/parallelism.js';
import { workspaceNameForIssue } from './lib/workspaceName.js';

// Triage Agent's idle timeout inside the sandbox. 1800s = 30 minutes,
// long enough for repro attempts and slow Coder workspace cold starts but
// short enough to bound a single agent's resource use.
const TRIAGE_AGENT_IDLE_TIMEOUT_SECONDS = 1800;

// `gh issue list` defaults to --limit 30, which would silently drop excess
// eligible issues. The plan calls for "no hard batch cap: process all eligible
// issues, but only N at once", so cap at a high upper bound that exceeds any
// realistic triage backlog. (See `runJson`/`runCommand` for the matching
// `spawnSync` `maxBuffer` setting that pairs with this limit.)
const GH_ISSUE_LIST_LIMIT = 500;

// All gh CLI calls in the orchestrator must target this repo explicitly so
// the orchestrator works from CI, a worktree with a different remote, or a
// directory without `.git`, never silently querying the wrong repo via
// implicit cwd-based `.git/config` resolution.
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

// Exported for direct schema-level regression tests; runtime callers use
// these only via runJson + ghIssueListSchema.
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
  // Reuse runJson so coder-CLI preflight inherits the same status/JSON
  // diagnostics path as the gh-CLI calls. Schema is permissive (`unknown`)
  // because we only verify that whoami responded with valid JSON.
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

// Tracks sandboxes that have been created but not yet closed, indexed by
// the issue number that owns them. Signal handlers iterate this map to
// call close() on each so SIGINT/SIGTERM does not leave orphaned
// `agent-tty-triage-*` Coder workspaces blocking future runs. Storing the
// issue number lets cleanup logs name the workspace's owner instead of an
// opaque object reference.
const activeSandboxes = new Map<Sandbox, number>();

// Tracks workspace names whose `createSandbox` is in flight. The Coder
// control plane has already provisioned the workspace (the `coder create`
// HTTP request is in progress) but `createSandbox` has not yet resolved a
// `Sandbox` instance for us to close, so the workspace cannot be cleaned
// up via `Sandbox.close()`. The signal handler reaps these names via
// `coder delete <name> --yes` directly. The map is keyed by workspace name
// so we can also de-duplicate concurrent attempts on the same issue.
const pendingWorkspaceNames = new Map<string, number>();

// Set synchronously by the signal handler before any await. Checked at
// the top of `runTriageAgent` so any task pLimit dequeues during cleanup
// (in-flight runs completing as their sandboxes are closed cause queued
// tasks to start) returns early without provisioning a new workspace.
// Without this, those late-starting tasks would populate the maps that
// `closeActiveSandboxes` already snapshotted, and the new workspaces
// would be orphaned when `process.exit()` fires.
let shutdownRequested = false;

async function runTriageAgent(
  issue: TriageIssue,
  runId: string,
): Promise<TriageIssueSummary> {
  // workspaceName is computed inside the try so an assertIssueNumber
  // failure (malformed gh response, future caller passing an unvalidated
  // number) is caught per-issue instead of aborting the whole batch via
  // Promise.all in runBatch.
  let workspaceName: string | undefined;
  let sandbox: Sandbox | undefined;
  let result: TriageIssueSummary | undefined;

  // Skip queued tasks that pLimit dequeues after a shutdown signal. The
  // signal handler sets `shutdownRequested` synchronously before the
  // first await in closeActiveSandboxes; any task that starts here after
  // that point would otherwise call `createSandbox()`, populate the
  // already-snapshotted maps, and orphan a workspace when
  // `process.exit()` fires.
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

    // Track the in-flight workspace name so a SIGINT during the
    // `coder create` window can still reap the workspace via
    // `coder delete <name> --yes`. Removed once createSandbox resolves
    // (sandbox object now in activeSandboxes) or rejects (no workspace).
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
              // Sandcastle syncs git-tracked files only, so node_modules/ is
              // absent inside the workspace. Per the plan's resolved design
              // ("v1 should run `npm ci` in the workspace before triage"),
              // run a deterministic install before the agent starts so bug
              // reproductions can execute the project's tools.
              { command: 'npm ci' },
              { command: 'npm install -g @anthropic-ai/claude-code' },
            ],
          },
        },
      });
      activeSandboxes.set(sandbox, issue.number);
    } finally {
      // Remove from pending whether createSandbox resolved or rejected.
      // On resolve, ownership transfers to activeSandboxes (above). On
      // reject, the Coder control plane should have rolled back the
      // workspace; if it did not, the per-issue workspace name lock plus
      // template TTL remain the safety net.
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
    // Print the full, multi-line error to stderr before truncating to a
    // first-line summary for `TriageIssueSummary.message`. Without this,
    // root causes that live on line 2+ (Coder create stack traces, sync
    // failures, agent crashes) are permanently destroyed.
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
        // Preserve the original triage signal: if `result` is already a
        // success, downgrade to 'failed' but keep the original message and
        // append the close failure. If `result` is already a failure, do
        // the same so we never silently lose the root cause.
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
  // 128 + signal number convention. SIGINT=2 → 130, SIGTERM=15 → 143.
  return signal === 'SIGINT' ? 130 : 143;
}

/**
 * Best-effort cleanup of every Coder workspace this process is responsible
 * for, both fully-created (`activeSandboxes`) and in-flight (`pendingWorkspaceNames`,
 * for the window between `coder create` accepting the request and
 * `createSandbox` resolving a `Sandbox` instance). Used by signal handlers
 * so SIGINT/SIGTERM during a batch does not leave orphaned
 * `agent-tty-triage-*` workspaces blocking future runs (the per-issue
 * workspace name acts as a lock, so an orphan permanently blocks the
 * corresponding issue until manual `coder delete` or template TTL expiry).
 *
 * Logs each per-workspace close result keyed by issue number so the
 * operator can see exactly which workspaces are stranded after a forced
 * shutdown.
 */
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
    // Second signal during cleanup forces immediate exit. The operator
    // already decided to kill the process; the Coder template's
    // `default_ttl` is the safety net for any sandboxes whose close()
    // calls did not finish. Without this escape hatch a hung
    // `coder delete` would make the process unkillable without `kill -9`.
    if (signalled) {
      console.error(
        `[afk-triage] second ${signal}; force-exiting (cleanup in progress; remaining sandboxes will rely on template TTL)`,
      );
      process.exit(signalExitCode(signal));
    }
    signalled = true;
    // Set the shutdown flag SYNCHRONOUSLY before any await so queued
    // pLimit tasks that get dequeued during cleanup (in-flight runs
    // completing as their sandboxes are closed) see it and skip
    // provisioning new workspaces.
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
    // parseRunnerArgs is inside the try so an `--parallelism abc` typo or
    // any other invariant failure produces a structured JSON summary via
    // printSummary instead of escaping main() with a raw stack trace,
    // matching the contract every other batch-level failure already follows.
    const args = parseRunnerArgs(process.argv.slice(2), process.env);
    const summary = await runBatch(args);
    printSummary(summary);
  } catch (error) {
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
