import { invariant } from '../../src/util/assert.js';
import { branchNameForIssue, workspaceNameForIssue } from './afkIdentity.js';
import {
  createCoderProvisioner,
  type CoderProvisioner,
  type ProvisionedAgent,
} from './coderProvisioner.js';
import type { TriageIssue } from './eligibility.js';
import { conciseErrorMessage, isLockError } from './errorMessage.js';
import { pLimit } from './pLimit.js';

export type TriageIssueStatus = 'success' | 'locked' | 'failed' | 'skipped';

export interface TriageIssueSummary {
  readonly issueNumber: number;
  readonly status: TriageIssueStatus;
  readonly message?: string;
}

export interface BatchRunnerDeps {
  readonly coderProvisioner?: CoderProvisioner;
  readonly errorLogger?: (...args: readonly unknown[]) => void;
}

export interface RunBatchOptions {
  readonly runId: string;
  readonly parallelism: number;
}

export interface BatchRunnerStatus {
  readonly active: number;
  readonly pending: number;
}

export interface TriageBatchRunner {
  run(
    eligibleIssues: readonly TriageIssue[],
    options: RunBatchOptions,
  ): Promise<TriageIssueSummary[]>;

  /**
   * Idempotent. Sets the shutdown flag synchronously so newly dequeued tasks
   * stop spawning new Coder workspaces, then closes active sandboxes and
   * reaps any in-flight workspace creates.
   */
  requestShutdown(): Promise<void>;

  readonly status: BatchRunnerStatus;
}

export function createTriageBatchRunner(
  deps: BatchRunnerDeps = {},
): TriageBatchRunner {
  const provisioner = deps.coderProvisioner ?? createCoderProvisioner();
  const errorLogger =
    deps.errorLogger ??
    ((...args: readonly unknown[]) => console.error(...args));

  const activeAgents = new Map<ProvisionedAgent, number>();
  const pendingWorkspaceNames = new Map<string, number>();

  // Set synchronously before cleanup awaits so newly dequeued tasks do not
  // create workspaces outside the cleanup snapshot.
  let shutdownRequested = false;

  async function runOne(
    issue: TriageIssue,
    runId: string,
  ): Promise<TriageIssueSummary> {
    let workspaceName: string | undefined;
    let agent: ProvisionedAgent | undefined;
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
      const branchName = branchNameForIssue(issue.number, runId);

      pendingWorkspaceNames.set(workspaceName, issue.number);
      try {
        agent = await provisioner.provision({
          issue,
          runId,
          workspaceName,
          branchName,
        });
      } finally {
        pendingWorkspaceNames.delete(workspaceName);
      }

      // Re-check shutdownRequested after provision() resolves. SIGINT can
      // arrive while provisioning a Coder workspace (which takes minutes);
      // requestShutdown() runs synchronously, snapshots
      // pendingWorkspaceNames (which still includes our entry — pending is
      // populated before the await above), and dispatches
      // deleteWorkspace() against our workspace name. Without this
      // re-check, the just-resolved agent would land in the cleared
      // activeAgents map, agent.run() would race against the workspace
      // delete, and a graceful skip would be misclassified as 'failed'.
      //
      // Do NOT call agent.close() here: the workspace is already in the
      // queue requestShutdown owns. Calling close() in parallel would race
      // the dispatched deleteWorkspace and cause a spurious "workspace may
      // be stranded" log line in the second-to-finish call. Returning
      // 'skipped' without close lets requestShutdown's reap path log the
      // single, correct outcome.
      //
      // oxlint cannot see across the await boundary that shutdownRequested
      // is mutated by requestShutdown, so it narrows it to `false` after
      // the entry-time check and flags this as `no-unnecessary-condition`.
      // The check is semantically required (without it, DEREM-3
      // reintroduces the race); suppress the warning rather than delete it.
      // oxlint-disable-next-line typescript/no-unnecessary-condition
      if (shutdownRequested) {
        return {
          issueNumber: issue.number,
          status: 'skipped',
          message: 'shutdown requested',
        };
      }

      activeAgents.set(agent, issue.number);

      await agent.run();

      result = {
        issueNumber: issue.number,
        status: 'success',
      };
    } catch (error) {
      errorLogger(`[issue ${issue.number}]`, error);
      result = {
        issueNumber: issue.number,
        status:
          workspaceName !== undefined && isLockError(error, workspaceName)
            ? 'locked'
            : 'failed',
        message: conciseErrorMessage(error),
      };
    } finally {
      // Skip close when the agent was already cleaned up by the signal
      // handler (requestShutdown). Otherwise we would call close() twice on
      // the same Coder workspace; the second call fails because the
      // workspace is gone, the catch fires, and a successful triage gets
      // silently overwritten with a misleading `close failed: workspace
      // not found` message. Membership in `activeAgents` is the
      // single-owner protocol that disambiguates "still ours to close"
      // from "signal handler took it".
      if (agent !== undefined && activeAgents.has(agent)) {
        activeAgents.delete(agent);
        try {
          await agent.close();
        } catch (closeError) {
          errorLogger(`[issue ${issue.number}] close failed`, closeError);
          // Agent is in activeAgents only if provision() resolved, which
          // means runOne already reached either the success-result
          // assignment or the catch block (both of which assign result).
          // Assert rather than branch.
          invariant(
            result !== undefined,
            'result must be defined when closing an active agent',
          );
          const original =
            result.message ?? `original status: ${result.status}`;
          result = {
            issueNumber: issue.number,
            status: 'failed',
            message: `${original}; close failed: ${conciseErrorMessage(closeError)}`,
          };
        }
      }
    }

    return result;
  }

  async function run(
    eligibleIssues: readonly TriageIssue[],
    options: RunBatchOptions,
  ): Promise<TriageIssueSummary[]> {
    const limit = pLimit(options.parallelism);
    return Promise.all(
      eligibleIssues.map((issue) => limit(() => runOne(issue, options.runId))),
    );
  }

  async function requestShutdown(): Promise<void> {
    shutdownRequested = true;

    const agentEntries = Array.from(activeAgents.entries());
    const pendingEntries = Array.from(pendingWorkspaceNames.entries());
    activeAgents.clear();
    pendingWorkspaceNames.clear();

    const closeResults = await Promise.allSettled(
      agentEntries.map(async ([agent]) => {
        await agent.close();
      }),
    );

    for (const [index, settled] of closeResults.entries()) {
      const entry = agentEntries[index];
      if (entry === undefined) {
        continue;
      }
      const [, issueNumber] = entry;
      if (settled.status === 'fulfilled') {
        errorLogger(`[issue ${issueNumber}] sandbox closed during shutdown`);
      } else {
        errorLogger(
          `[issue ${issueNumber}] sandbox close failed during shutdown — workspace may be stranded:`,
          settled.reason,
        );
      }
    }

    // Reap any workspaces whose `provision()` registered them as in-flight
    // but never resolved a ProvisionedAgent for us to close via the normal
    // path. The provisioner's deleteWorkspace mirrors the
    // `onClose: 'delete'` semantics for the in-flight case.
    const pendingResults = await Promise.allSettled(
      pendingEntries.map(([workspaceName]) =>
        provisioner.deleteWorkspace(workspaceName),
      ),
    );

    for (const [index, settled] of pendingResults.entries()) {
      const entry = pendingEntries[index];
      if (entry === undefined) {
        continue;
      }
      const [workspaceName, issueNumber] = entry;
      if (settled.status === 'rejected') {
        // Defensive: the production CoderProvisioner.deleteWorkspace
        // always resolves (spawn errors map to outcome:'failed'), so this
        // branch is unreachable for the real provisioner. Kept so that
        // an injected provisioner that violates the resolve-only contract
        // produces a useful log line instead of an unhandled rejection.
        errorLogger(
          `[issue ${issueNumber}] in-flight workspace ${workspaceName} delete threw during shutdown — workspace may be stranded:`,
          settled.reason,
        );
        continue;
      }
      const deleteResult = settled.value;
      if (deleteResult.outcome === 'deleted') {
        errorLogger(
          `[issue ${issueNumber}] in-flight workspace ${workspaceName} deleted during shutdown`,
        );
      } else {
        errorLogger(
          `[issue ${issueNumber}] in-flight workspace ${workspaceName} delete failed during shutdown (status ${deleteResult.status}) — workspace may be stranded: ${deleteResult.stderr.trim()}`,
        );
      }
    }
  }

  return {
    run,
    requestShutdown,
    get status(): BatchRunnerStatus {
      return {
        active: activeAgents.size,
        pending: pendingWorkspaceNames.size,
      };
    },
  };
}
