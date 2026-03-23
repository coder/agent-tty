import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  emitSuccess: vi.fn(),
  allocateSession: vi.fn(),
  launchHost: vi.fn(),
  reconcileSession: vi.fn(),
  sendRpc: vi.fn(),
  readManifestIfExists: vi.fn(),
  sessionDir: vi.fn(),
  manifestPath: vi.fn(),
  socketPath: vi.fn(),
}));

vi.mock('../../../src/cli/output.js', () => ({
  emitSuccess: mocks.emitSuccess,
}));

vi.mock('../../../src/host/lifecycle.js', () => ({
  allocateSession: mocks.allocateSession,
  launchHost: mocks.launchHost,
  reconcileSession: mocks.reconcileSession,
}));

vi.mock('../../../src/host/rpcClient.js', () => ({
  sendRpc: mocks.sendRpc,
}));

vi.mock('../../../src/storage/manifests.js', () => ({
  readManifestIfExists: mocks.readManifestIfExists,
}));

vi.mock('../../../src/storage/sessionPaths.js', () => ({
  sessionDir: mocks.sessionDir,
  manifestPath: mocks.manifestPath,
  socketPath: mocks.socketPath,
}));

import { runCreateCommand } from '../../../src/cli/commands/create.js';

describe('create command', () => {
  const context = {
    home: '/tmp/agent-terminal-home',
    timeoutMs: undefined,
    colorEnabled: true,
    logLevel: 'info',
    profileDefault: undefined,
    configFile: null,
  } as const;
  const baseOptions = {
    json: true,
    command: ['/bin/sh', '-c', 'echo ready'],
    shellPath: '/bin/bash',
    cwd: '/tmp/workspace',
    cols: 120,
    rows: 40,
    envEntries: [] as string[],
    term: 'vt100',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.allocateSession.mockResolvedValue({
      sessionId: 'session-01',
      sessionDirectory: '/tmp/agent-terminal-home/sessions/session-01',
    });
    mocks.launchHost.mockReturnValue(12345);
    mocks.sendRpc.mockResolvedValue({ session: { sessionId: 'session-01' } });
    mocks.readManifestIfExists.mockResolvedValue(null);
    mocks.sessionDir.mockImplementation(
      (_home: string, sessionId: string) =>
        `/tmp/agent-terminal-home/sessions/${sessionId}`,
    );
    mocks.manifestPath.mockImplementation(
      (sessionDirectory: string) => `${sessionDirectory}/session.json`,
    );
    mocks.socketPath.mockImplementation(
      (sessionDirectory: string) => `${sessionDirectory}/rpc.sock`,
    );
  });

  it('passes home, env, term, name, and shell through session creation', async () => {
    await runCreateCommand({
      ...baseOptions,
      context,
      envEntries: ['FOO=bar', 'BAZ=qux'],
      name: 'demo-session',
    });

    expect(mocks.allocateSession).toHaveBeenCalledWith({
      home: context.home,
      command: ['/bin/sh', '-c', 'echo ready'],
      shellPath: '/bin/bash',
      cwd: '/tmp/workspace',
      cols: 120,
      rows: 40,
      env: { FOO: 'bar', BAZ: 'qux' },
      term: 'vt100',
      name: 'demo-session',
    });
    expect(mocks.launchHost).toHaveBeenCalledWith({
      sessionId: 'session-01',
      home: context.home,
      env: { FOO: 'bar', BAZ: 'qux' },
      term: 'vt100',
    });
    expect(mocks.emitSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'create',
        json: true,
        result: { sessionId: 'session-01' },
      }),
    );
  });

  it('passes idle timeout through allocation when provided explicitly', async () => {
    await runCreateCommand({
      ...baseOptions,
      context,
      idleTimeoutMs: 5000,
    });

    expect(mocks.allocateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        idleTimeoutMs: 5000,
      }),
    );
  });

  it('falls back to the configured idle timeout when no flag is provided', async () => {
    await runCreateCommand({
      ...baseOptions,
      context: {
        ...context,
        configFile: {
          idleTimeoutMs: 1234,
        },
      },
    });

    expect(mocks.allocateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        idleTimeoutMs: 1234,
      }),
    );
  });

  it('accepts an idle timeout of 0 without persisting it to allocation metadata', async () => {
    await runCreateCommand({
      ...baseOptions,
      context,
      idleTimeoutMs: 0,
    });

    expect(mocks.allocateSession).toHaveBeenCalledTimes(1);
    expect(mocks.allocateSession.mock.calls[0]?.[0]).not.toHaveProperty(
      'idleTimeoutMs',
    );
  });

  it('rejects negative idle timeout values before allocating a session', async () => {
    await expect(
      runCreateCommand({
        ...baseOptions,
        context,
        idleTimeoutMs: -1,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: '--idle-timeout-ms must be a non-negative integer.',
    });

    expect(mocks.allocateSession).not.toHaveBeenCalled();
    expect(mocks.launchHost).not.toHaveBeenCalled();
  });

  it('rejects malformed env entries before allocating a session', async () => {
    await expect(
      runCreateCommand({
        ...baseOptions,
        context,
        envEntries: ['MALFORMED'],
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: '--env must use KEY=VALUE format, got: MALFORMED',
    });

    expect(mocks.allocateSession).not.toHaveBeenCalled();
    expect(mocks.launchHost).not.toHaveBeenCalled();
  });
});
