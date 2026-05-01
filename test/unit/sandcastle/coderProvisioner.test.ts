import { describe, expect, it, vi } from 'vitest';

import {
  createCoderProvisioner,
  type CoderFactory,
  type ProvisionContext,
  type SandcastleImports,
} from '../../../.sandcastle/lib/coderProvisioner.js';
import type { CommandResult } from '../../../.sandcastle/lib/gh.js';

const RUN_ID = '20260430T141500Z';

interface FakeSandbox {
  readonly run: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
}

function makeFakeSandcastle(sandbox: FakeSandbox): {
  readonly imports: SandcastleImports;
  readonly createSandbox: ReturnType<typeof vi.fn>;
  readonly claudeCode: ReturnType<typeof vi.fn>;
  readonly importFn: () => Promise<SandcastleImports>;
} {
  const createSandbox = vi.fn(() => Promise.resolve(sandbox));
  const claudeCode = vi.fn((model: string) => ({ kind: 'fake-agent', model }));
  const imports = {
    createSandbox,
    claudeCode,
  } as unknown as SandcastleImports;
  return {
    imports,
    createSandbox,
    claudeCode,
    importFn: () => Promise.resolve(imports),
  };
}

function makeProvisionContext(issueNumber: number): ProvisionContext {
  return {
    issue: { number: issueNumber, labels: [], comments: [] },
    runId: RUN_ID,
    workspaceName: `agent-tty-triage-${issueNumber}`,
    branchName: `afk-triage/${issueNumber}-${RUN_ID}`,
  };
}

// The vendored `coder()` factory hides template, preset, onClose, and
// workspaceName inside its closure — they never appear on the returned
// provider. To pin those production knobs, tests inject a fake factory
// and assert on the args passed to it.
const FAKE_PROVIDER = {
  tag: 'isolated' as const,
  name: 'coder',
  env: {} as Record<string, string>,
  create: () => Promise.resolve({} as never),
};

function fakeCoderFactory(): {
  readonly factory: CoderFactory;
  readonly mock: ReturnType<typeof vi.fn>;
} {
  const mock = vi.fn(() => FAKE_PROVIDER);
  return {
    factory: mock as unknown as CoderFactory,
    mock,
  };
}

const noopRunCoderAsync = vi.fn(() =>
  Promise.resolve<CommandResult>({ stdout: '', stderr: '', status: 0 }),
);

describe('createCoderProvisioner.provision', () => {
  it('passes production template, preset, onClose, and workspaceName to the coder() factory', async () => {
    const sandbox: FakeSandbox = {
      run: vi.fn(() => Promise.resolve()),
      close: vi.fn(() => Promise.resolve()),
    };
    const fakes = makeFakeSandcastle(sandbox);
    const coderFactory = fakeCoderFactory();
    const provisioner = createCoderProvisioner({
      importSandcastle: fakes.importFn,
      runCoderAsync: noopRunCoderAsync,
      coderFactory: coderFactory.factory,
    });

    await provisioner.provision(makeProvisionContext(42));

    expect(coderFactory.mock).toHaveBeenCalledTimes(1);
    expect(coderFactory.mock).toHaveBeenCalledWith({
      template: 'coder',
      preset: 'Falkenstein',
      workspaceName: 'agent-tty-triage-42',
      onClose: 'delete',
    });
  });

  it('forwards the provider produced by coder() and the AFK ready-hooks to createSandbox', async () => {
    const sandbox: FakeSandbox = {
      run: vi.fn(() => Promise.resolve()),
      close: vi.fn(() => Promise.resolve()),
    };
    const fakes = makeFakeSandcastle(sandbox);
    const coderFactory = fakeCoderFactory();
    const provisioner = createCoderProvisioner({
      importSandcastle: fakes.importFn,
      runCoderAsync: noopRunCoderAsync,
      coderFactory: coderFactory.factory,
    });

    await provisioner.provision(makeProvisionContext(42));

    expect(fakes.createSandbox).toHaveBeenCalledTimes(1);
    const call = fakes.createSandbox.mock.calls[0]?.[0] as {
      readonly branch: string;
      readonly sandbox: typeof FAKE_PROVIDER;
      readonly hooks: {
        readonly sandbox: { readonly onSandboxReady: readonly unknown[] };
      };
    };
    expect(call.branch).toBe('afk-triage/42-20260430T141500Z');
    expect(call.sandbox).toBe(FAKE_PROVIDER);
    expect(call.hooks.sandbox.onSandboxReady).toEqual([
      { command: 'gh auth status' },
      { command: 'npm ci' },
      { command: 'npm install -g @anthropic-ai/claude-code' },
    ]);
  });

  it('runs the Triage Agent with the pinned model, prompt file, and idle timeout', async () => {
    const sandbox: FakeSandbox = {
      run: vi.fn(() => Promise.resolve()),
      close: vi.fn(() => Promise.resolve()),
    };
    const fakes = makeFakeSandcastle(sandbox);
    const coderFactory = fakeCoderFactory();
    const provisioner = createCoderProvisioner({
      importSandcastle: fakes.importFn,
      runCoderAsync: noopRunCoderAsync,
      coderFactory: coderFactory.factory,
    });

    const agent = await provisioner.provision(makeProvisionContext(123));
    await agent.run();

    expect(fakes.claudeCode).toHaveBeenCalledWith('claude-opus-4-6');
    expect(sandbox.run).toHaveBeenCalledTimes(1);
    const runCall = sandbox.run.mock.calls[0]?.[0] as {
      readonly promptFile: string;
      readonly promptArgs: Record<string, string>;
      readonly idleTimeoutSeconds: number;
    };
    expect(runCall.promptFile).toBe('.sandcastle/triage-prompt.md');
    expect(runCall.promptArgs).toEqual({ ISSUE_NUMBER: '123' });
    expect(runCall.idleTimeoutSeconds).toBe(1800);
  });

  it('close delegates to sandbox.close', async () => {
    const sandbox: FakeSandbox = {
      run: vi.fn(() => Promise.resolve()),
      close: vi.fn(() => Promise.resolve()),
    };
    const fakes = makeFakeSandcastle(sandbox);
    const coderFactory = fakeCoderFactory();
    const provisioner = createCoderProvisioner({
      importSandcastle: fakes.importFn,
      runCoderAsync: noopRunCoderAsync,
      coderFactory: coderFactory.factory,
    });

    const agent = await provisioner.provision(makeProvisionContext(7));
    await agent.close();

    expect(sandbox.close).toHaveBeenCalledTimes(1);
  });
});

describe('createCoderProvisioner.deleteWorkspace', () => {
  it('runs `coder delete <name> --yes` and returns deleted on status 0', async () => {
    const runCoderAsync = vi.fn(() =>
      Promise.resolve<CommandResult>({
        stdout: '',
        stderr: '',
        status: 0,
      }),
    );
    const provisioner = createCoderProvisioner({
      importSandcastle: () =>
        Promise.resolve({} as unknown as SandcastleImports),
      runCoderAsync,
    });

    const result = await provisioner.deleteWorkspace('agent-tty-triage-9');

    expect(runCoderAsync).toHaveBeenCalledWith([
      'delete',
      'agent-tty-triage-9',
      '--yes',
    ]);
    expect(result).toEqual({ outcome: 'deleted' });
  });

  it('returns failed with status and stderr when coder delete exits non-zero', async () => {
    const runCoderAsync = vi.fn(() =>
      Promise.resolve<CommandResult>({
        stdout: '',
        stderr: 'workspace not found\n',
        status: 1,
      }),
    );
    const provisioner = createCoderProvisioner({
      importSandcastle: () =>
        Promise.resolve({} as unknown as SandcastleImports),
      runCoderAsync,
    });

    const result = await provisioner.deleteWorkspace('agent-tty-triage-9');

    expect(result).toEqual({
      outcome: 'failed',
      status: 1,
      stderr: 'workspace not found\n',
    });
  });
});
