import { describe, expect, it, vi } from 'vitest';

import { createTriageBatchRunner } from '../../../.sandcastle/lib/batchRunner.js';
import type {
  CoderProvisioner,
  ProvisionContext,
  ProvisionedAgent,
  WorkspaceDeleteResult,
} from '../../../.sandcastle/lib/coderProvisioner.js';
import type { TriageIssue } from '../../../.sandcastle/lib/eligibility.js';

const RUN_ID = '20260430T141500Z';

interface FakeAgent {
  readonly id: number;
  readonly run: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
}

interface FakeProvisioner {
  readonly provisioner: CoderProvisioner;
  readonly provision: ReturnType<typeof vi.fn>;
  readonly deleteWorkspace: ReturnType<typeof vi.fn>;
  readonly agents: Map<number, FakeAgent>;
  rejectProvision: (error: unknown) => void;
}

interface FakeProvisionerConfig {
  /** When true, provision() returns a controllable promise instead of resolving immediately. */
  readonly hangProvision?: boolean;
  /** Throw before any agent is constructed. */
  readonly provisionError?: Error;
  /** Override the FakeAgent produced for an issue (e.g. with a throwing run/close). */
  readonly agentFactory?: (issueNumber: number) => FakeAgent;
}

function defaultAgent(issueNumber: number): FakeAgent {
  return {
    id: issueNumber,
    run: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
}

function asProvisionedAgent(agent: FakeAgent): ProvisionedAgent {
  return agent as unknown as ProvisionedAgent;
}

function makeFakeProvisioner(
  config: FakeProvisionerConfig = {},
): FakeProvisioner {
  // Stores one rejector per hung provision() call so multi-issue tests
  // using `hangProvision: true` can settle every issue. A single mutable
  // slot would silently overwrite earlier rejectors and Promise.all
  // would hang on the unsettled ones.
  const pendingRejects: ((error: unknown) => void)[] = [];

  const agentFactory = config.agentFactory ?? defaultAgent;
  const agents = new Map<number, FakeAgent>();

  const provision = vi.fn(
    (ctx: ProvisionContext): Promise<ProvisionedAgent> => {
      if (config.provisionError !== undefined) {
        return Promise.reject(config.provisionError);
      }
      const issueNumber = ctx.issue.number;
      if (config.hangProvision === true) {
        return new Promise<ProvisionedAgent>((_resolve, reject) => {
          pendingRejects.push(reject);
        });
      }
      const agent = agentFactory(issueNumber);
      agents.set(issueNumber, agent);
      return Promise.resolve(asProvisionedAgent(agent));
    },
  );

  const deleteWorkspace = vi.fn(
    (_workspaceName: string): Promise<WorkspaceDeleteResult> =>
      Promise.resolve({ outcome: 'deleted' }),
  );

  const provisioner: CoderProvisioner = {
    provision: (ctx) => provision(ctx),
    deleteWorkspace: (name) => deleteWorkspace(name),
  };

  return {
    provisioner,
    provision,
    deleteWorkspace,
    agents,
    rejectProvision: (error) => {
      if (pendingRejects.length === 0) {
        throw new Error('provision is not pending');
      }
      // Drain all so multi-issue hung tests can settle every issue.
      for (const reject of pendingRejects.splice(0)) {
        reject(error);
      }
    },
  };
}

function makeIssue(number: number): TriageIssue {
  return { number, labels: [], comments: [] };
}

/**
 * Spin until `predicate()` is truthy or `timeoutMs` elapses, throwing a
 * descriptive error on timeout. Polls the runner's status counters so
 * we can synchronize on observable lifecycle state without hanging the
 * whole test on vitest's global timeout.
 */
async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms: ${description}`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('createTriageBatchRunner', () => {
  it('resolves to an empty list and does not call the provisioner when no issues are eligible', async () => {
    const fakes = makeFakeProvisioner();
    const runner = createTriageBatchRunner({
      coderProvisioner: fakes.provisioner,
      errorLogger: vi.fn(),
    });

    const result = await runner.run([], { runId: RUN_ID, parallelism: 2 });

    expect(result).toEqual([]);
    expect(fakes.provision).not.toHaveBeenCalled();
    expect(fakes.deleteWorkspace).not.toHaveBeenCalled();
  });

  it('returns success and closes the agent once when an issue completes cleanly', async () => {
    const fakes = makeFakeProvisioner();
    const errorLogger = vi.fn();
    const runner = createTriageBatchRunner({
      coderProvisioner: fakes.provisioner,
      errorLogger,
    });

    const result = await runner.run([makeIssue(42)], {
      runId: RUN_ID,
      parallelism: 1,
    });

    expect(result).toEqual([{ issueNumber: 42, status: 'success' }]);
    expect(fakes.provision).toHaveBeenCalledTimes(1);
    const ctx = fakes.provision.mock.calls[0]?.[0] as ProvisionContext;
    expect(ctx).toMatchObject({
      runId: RUN_ID,
      workspaceName: 'agent-tty-triage-42',
      branchName: 'afk-triage/42-20260430T141500Z',
    });
    const agent = fakes.agents.get(42);
    expect(agent?.run).toHaveBeenCalledTimes(1);
    expect(agent?.close).toHaveBeenCalledTimes(1);
    expect(errorLogger).not.toHaveBeenCalled();
    expect(runner.status).toEqual({ active: 0, pending: 0 });
  });

  it('classifies workspace-name conflicts as locked', async () => {
    const fakes = makeFakeProvisioner({
      provisionError: new Error('workspace agent-tty-triage-7 already exists'),
    });
    const runner = createTriageBatchRunner({
      coderProvisioner: fakes.provisioner,
      errorLogger: vi.fn(),
    });

    const result = await runner.run([makeIssue(7)], {
      runId: RUN_ID,
      parallelism: 1,
    });

    expect(result).toEqual([
      {
        issueNumber: 7,
        status: 'locked',
        message: 'workspace agent-tty-triage-7 already exists',
      },
    ]);
  });

  it('returns failed when agent.run rejects, with concise error message', async () => {
    const fakes = makeFakeProvisioner({
      agentFactory: (issueNumber) => ({
        id: issueNumber,
        run: vi.fn(() =>
          Promise.reject(new Error('agent crashed\nstack trace ignored')),
        ),
        close: vi.fn(() => Promise.resolve()),
      }),
    });
    const runner = createTriageBatchRunner({
      coderProvisioner: fakes.provisioner,
      errorLogger: vi.fn(),
    });

    const result = await runner.run([makeIssue(11)], {
      runId: RUN_ID,
      parallelism: 1,
    });

    expect(result).toEqual([
      { issueNumber: 11, status: 'failed', message: 'agent crashed' },
    ]);
    expect(fakes.agents.get(11)?.close).toHaveBeenCalledTimes(1);
  });

  it('overwrites a successful result when agent.close throws after a successful run', async () => {
    const fakes = makeFakeProvisioner({
      agentFactory: (issueNumber) => ({
        id: issueNumber,
        run: vi.fn(() => Promise.resolve()),
        close: vi.fn(() => Promise.reject(new Error('coder delete refused'))),
      }),
    });
    const runner = createTriageBatchRunner({
      coderProvisioner: fakes.provisioner,
      errorLogger: vi.fn(),
    });

    const result = await runner.run([makeIssue(3)], {
      runId: RUN_ID,
      parallelism: 1,
    });

    expect(result).toEqual([
      {
        issueNumber: 3,
        status: 'failed',
        message: 'original status: success; close failed: coder delete refused',
      },
    ]);
  });

  it('skips queued issues when shutdown is requested before runOne dispatches', async () => {
    // Exercises the entry-time `if (shutdownRequested)` check in runOne.
    // pLimit schedules runOne via Promise.resolve().then(...). When
    // requestShutdown() runs synchronously before that microtask fires,
    // shutdownRequested is true by the time runOne starts and the entry
    // check returns 'skipped' immediately, never calling provision().
    const fakes = makeFakeProvisioner();
    const runner = createTriageBatchRunner({
      coderProvisioner: fakes.provisioner,
      errorLogger: vi.fn(),
    });

    const runPromise = runner.run([makeIssue(4)], {
      runId: RUN_ID,
      parallelism: 1,
    });
    await runner.requestShutdown();
    const result = await runPromise;

    expect(result).toEqual([
      { issueNumber: 4, status: 'skipped', message: 'shutdown requested' },
    ]);
    expect(fakes.provision).not.toHaveBeenCalled();
  });

  it('skips without double-closing when shutdown fires while provision() is in flight', async () => {
    // Exercises the post-provision shutdownRequested re-check in runOne.
    // The fake provision() fires requestShutdown() synchronously and then
    // resolves with a real agent. Without the post-provision re-check,
    // the agent would be registered in activeAgents (already cleared by
    // requestShutdown), `agent.run()` would race against the in-flight
    // workspace delete, and the result would be 'failed' instead of
    // 'skipped'. The post-provision branch must NOT call agent.close(): the
    // workspace is already in requestShutdown's deleteWorkspace queue, and
    // a parallel close would race with that dispatch and produce a
    // spurious "workspace may be stranded" log line.
    const runnerRef: {
      current: ReturnType<typeof createTriageBatchRunner> | undefined;
    } = { current: undefined };
    const baseFakes = makeFakeProvisioner({
      agentFactory: (issueNumber) => ({
        id: issueNumber,
        run: vi.fn(() =>
          Promise.reject(
            new Error('agent.run must not fire after post-provision shutdown'),
          ),
        ),
        close: vi.fn(() => Promise.resolve()),
      }),
    });
    const provisioner: CoderProvisioner = {
      provision: async (ctx) => {
        if (runnerRef.current !== undefined) {
          // Synchronously flip shutdownRequested = true. We do NOT await
          // requestShutdown() here so that provision() resolves to its
          // agent first; the runOne flow then re-checks the flag.
          void runnerRef.current.requestShutdown();
        }
        return baseFakes.provisioner.provision(ctx);
      },
      deleteWorkspace: (name) => baseFakes.provisioner.deleteWorkspace(name),
    };
    const runner = createTriageBatchRunner({
      coderProvisioner: provisioner,
      errorLogger: vi.fn(),
    });
    runnerRef.current = runner;

    const result = await runner.run([makeIssue(4)], {
      runId: RUN_ID,
      parallelism: 1,
    });

    expect(result).toEqual([
      { issueNumber: 4, status: 'skipped', message: 'shutdown requested' },
    ]);
    // The post-provision skip path must not call run() OR close(); the
    // workspace is reaped by requestShutdown's deleteWorkspace queue.
    expect(baseFakes.agents.get(4)?.run).not.toHaveBeenCalled();
    expect(baseFakes.agents.get(4)?.close).not.toHaveBeenCalled();
    expect(baseFakes.deleteWorkspace).toHaveBeenCalledWith(
      'agent-tty-triage-4',
    );
  });

  it('composes run-fail and close-fail messages in the close-error path', async () => {
    // Exercises the run-fail + close-fail double-failure path: agent.run()
    // rejects (result becomes failed) and the subsequent agent.close() in
    // runOne's finally also throws, producing the composed message
    // `<run-error>; close failed: <close-error>`.
    const fakes = makeFakeProvisioner({
      agentFactory: (issueNumber) => ({
        id: issueNumber,
        run: vi.fn(() => Promise.reject(new Error('agent crashed'))),
        close: vi.fn(() => Promise.reject(new Error('coder delete refused'))),
      }),
    });
    const runner = createTriageBatchRunner({
      coderProvisioner: fakes.provisioner,
      errorLogger: vi.fn(),
    });

    const result = await runner.run([makeIssue(13)], {
      runId: RUN_ID,
      parallelism: 1,
    });

    expect(result).toEqual([
      {
        issueNumber: 13,
        status: 'failed',
        message: 'agent crashed; close failed: coder delete refused',
      },
    ]);
  });

  it('closes active agents via requestShutdown while agent.run() is mid-flight', async () => {
    // Exercises the single-owner close protocol: an agent registered in
    // activeAgents is closed by requestShutdown(), and runOne's finally
    // sees activeAgents.has(agent) === false and skips the second close.
    const runHang: { resolve: () => void; promise: Promise<void> } = {
      resolve: () => undefined,
      promise: Promise.resolve(),
    };
    runHang.promise = new Promise<void>((resolve) => {
      runHang.resolve = resolve;
    });
    const fakes = makeFakeProvisioner({
      agentFactory: (issueNumber) => ({
        id: issueNumber,
        run: vi.fn(() => runHang.promise),
        close: vi.fn(() => Promise.resolve()),
      }),
    });
    const runner = createTriageBatchRunner({
      coderProvisioner: fakes.provisioner,
      errorLogger: vi.fn(),
    });

    const runPromise = runner.run([makeIssue(8)], {
      runId: RUN_ID,
      parallelism: 1,
    });

    // Wait until the agent is registered and agent.run() is in flight.
    await waitFor(
      () => runner.status.active > 0,
      'runner.status.active to advance after provision()',
    );
    expect(runner.status.active).toBe(1);
    expect(runner.status.pending).toBe(0);

    await runner.requestShutdown();

    // Single-owner protocol: requestShutdown closed the agent exactly once.
    expect(fakes.agents.get(8)?.close).toHaveBeenCalledTimes(1);

    // Let agent.run() resolve; runOne's finally must not double-close.
    runHang.resolve();
    const summaries = await runPromise;
    expect(summaries[0]?.status).toBe('success');
    expect(fakes.agents.get(8)?.close).toHaveBeenCalledTimes(1);
  });

  it('reaps in-flight workspaces via provisioner.deleteWorkspace during shutdown', async () => {
    const fakes = makeFakeProvisioner({ hangProvision: true });
    const runner = createTriageBatchRunner({
      coderProvisioner: fakes.provisioner,
      errorLogger: vi.fn(),
    });

    const runPromise = runner.run([makeIssue(5)], {
      runId: RUN_ID,
      parallelism: 1,
    });

    // Wait until the runner has registered the in-flight workspace.
    await waitFor(
      () => runner.status.pending > 0,
      'runner.status.pending to advance after pendingWorkspaceNames.set',
    );
    expect(runner.status.pending).toBe(1);

    await runner.requestShutdown();

    expect(fakes.deleteWorkspace).toHaveBeenCalledWith('agent-tty-triage-5');

    fakes.rejectProvision(new Error('cancelled'));
    const summaries = await runPromise;
    expect(summaries[0]?.status).toBe('failed');
  });

  it('logs "workspace may be stranded" when active-agent close throws during shutdown', async () => {
    // Exercises the active-agent close-fail branch in requestShutdown:
    // an agent registered in activeAgents whose close() throws should
    // surface the per-issue "sandbox close failed during shutdown —
    // workspace may be stranded" log line so operators know to clean up
    // the workspace manually. A regression that silences this log or
    // drops the error reason would defeat that contract.
    const errorLogger = vi.fn();
    const runHang: { resolve: () => void; promise: Promise<void> } = {
      resolve: () => undefined,
      promise: Promise.resolve(),
    };
    runHang.promise = new Promise<void>((resolve) => {
      runHang.resolve = resolve;
    });
    const closeError = new Error('coder delete refused during shutdown');
    const fakes = makeFakeProvisioner({
      agentFactory: (issueNumber) => ({
        id: issueNumber,
        run: vi.fn(() => runHang.promise),
        close: vi.fn(() => Promise.reject(closeError)),
      }),
    });
    const runner = createTriageBatchRunner({
      coderProvisioner: fakes.provisioner,
      errorLogger,
    });

    const runPromise = runner.run([makeIssue(91)], {
      runId: RUN_ID,
      parallelism: 1,
    });
    await waitFor(
      () => runner.status.active > 0,
      'agent registered in activeAgents',
    );

    await runner.requestShutdown();

    expect(errorLogger).toHaveBeenCalledWith(
      '[issue 91] sandbox close failed during shutdown — workspace may be stranded:',
      closeError,
    );

    runHang.resolve();
    await runPromise;
  });

  it('logs "workspace may be stranded" when in-flight deleteWorkspace exits non-zero during shutdown', async () => {
    // Exercises the pending-delete-fail branch in requestShutdown: when
    // deleteWorkspace returns { outcome: 'failed', status, stderr } for
    // an in-flight workspace, the runner emits a per-issue "in-flight
    // workspace ... delete failed during shutdown (status N) — workspace
    // may be stranded: <stderr>" log line. Operators rely on this for
    // manual cleanup of stranded Coder workspaces.
    const errorLogger = vi.fn();
    const baseFakes = makeFakeProvisioner({ hangProvision: true });
    const failedDelete = vi.fn(
      (_name: string): Promise<WorkspaceDeleteResult> =>
        Promise.resolve({
          outcome: 'failed',
          status: 7,
          stderr: 'workspace not found  \n',
        }),
    );
    const provisioner: CoderProvisioner = {
      provision: (ctx) => baseFakes.provisioner.provision(ctx),
      deleteWorkspace: (name) => failedDelete(name),
    };
    const runner = createTriageBatchRunner({
      coderProvisioner: provisioner,
      errorLogger,
    });

    const runPromise = runner.run([makeIssue(92)], {
      runId: RUN_ID,
      parallelism: 1,
    });
    await waitFor(
      () => runner.status.pending > 0,
      'workspace registered in pendingWorkspaceNames',
    );

    await runner.requestShutdown();

    expect(errorLogger).toHaveBeenCalledWith(
      '[issue 92] in-flight workspace agent-tty-triage-92 delete failed during shutdown (status 7) — workspace may be stranded: workspace not found',
    );

    baseFakes.rejectProvision(new Error('cancelled'));
    await runPromise;
  });

  it('exposes status counts that drop back to zero after run completes', async () => {
    const fakes = makeFakeProvisioner();
    const runner = createTriageBatchRunner({
      coderProvisioner: fakes.provisioner,
      errorLogger: vi.fn(),
    });

    expect(runner.status).toEqual({ active: 0, pending: 0 });

    await runner.run([makeIssue(1), makeIssue(2)], {
      runId: RUN_ID,
      parallelism: 2,
    });

    expect(runner.status).toEqual({ active: 0, pending: 0 });
  });

  it('requestShutdown is idempotent and does not call deleteWorkspace when nothing is pending', async () => {
    const fakes = makeFakeProvisioner();
    const runner = createTriageBatchRunner({
      coderProvisioner: fakes.provisioner,
      errorLogger: vi.fn(),
    });

    await runner.run([makeIssue(9)], { runId: RUN_ID, parallelism: 1 });

    await runner.requestShutdown();
    await runner.requestShutdown();

    // No active agents or pending workspaces remained after the run, so
    // the cleanup snapshots were both empty.
    expect(fakes.deleteWorkspace).not.toHaveBeenCalled();
  });
});
