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
  } as const;

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
      context,
      json: true,
      command: ['/bin/sh', '-c', 'echo ready'],
      shellPath: '/bin/bash',
      cwd: '/tmp/workspace',
      cols: 120,
      rows: 40,
      envEntries: ['FOO=bar', 'BAZ=qux'],
      term: 'vt100',
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

  it('rejects malformed env entries before allocating a session', async () => {
    await expect(
      runCreateCommand({
        context,
        json: true,
        command: ['/bin/sh', '-c', 'echo ready'],
        shellPath: '/bin/bash',
        cwd: '/tmp/workspace',
        cols: 120,
        rows: 40,
        envEntries: ['MALFORMED'],
        term: 'vt100',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: '--env must use KEY=VALUE format, got: MALFORMED',
    });

    expect(mocks.allocateSession).not.toHaveBeenCalled();
    expect(mocks.launchHost).not.toHaveBeenCalled();
  });
});
