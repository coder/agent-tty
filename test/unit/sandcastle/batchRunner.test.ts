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
  let pendingReject: ((error: unknown) => void) | undefined;

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
          pendingReject = reject;
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
      if (pendingReject === undefined) {
        throw new Error('provision is not pending');
      }
      pendingReject(error);
      pendingReject = undefined;
    },
  };
}

function makeIssue(number: number): TriageIssue {
  return { number, labels: [], comments: [] };
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

  it('skips dequeued issues when shutdown is requested before provision() is invoked', async () => {
    const fakes = makeFakeProvisioner();
    const runner = createTriageBatchRunner({
      coderProvisioner: fakes.provisioner,
      errorLogger: vi.fn(),
    });

    // Trigger shutdown synchronously after run() schedules but before the
    // post-yield re-check inside runOne fires.
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
    while (runner.status.pending === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(runner.status.pending).toBe(1);

    await runner.requestShutdown();

    expect(fakes.deleteWorkspace).toHaveBeenCalledWith('agent-tty-triage-5');

    fakes.rejectProvision(new Error('cancelled'));
    const summaries = await runPromise;
    expect(summaries[0]?.status).toBe('failed');
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
