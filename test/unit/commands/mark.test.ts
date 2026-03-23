import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ERROR_CODES } from '../../../src/protocol/errors.js';

const mocks = vi.hoisted(() => ({
  emitSuccess: vi.fn(),
  sendRpc: vi.fn(),
  readManifestIfExists: vi.fn(),
  resolveHome: vi.fn(),
  sessionDir: vi.fn(),
  manifestPath: vi.fn(),
  socketPath: vi.fn(),
}));

vi.mock('../../../src/cli/output.js', () => ({
  emitSuccess: mocks.emitSuccess,
}));

vi.mock('../../../src/host/rpcClient.js', () => ({
  sendRpc: mocks.sendRpc,
}));

vi.mock('../../../src/storage/manifests.js', () => ({
  readManifestIfExists: mocks.readManifestIfExists,
}));

vi.mock('../../../src/storage/home.js', () => ({
  resolveHome: mocks.resolveHome,
}));

vi.mock('../../../src/storage/sessionPaths.js', () => ({
  sessionDir: mocks.sessionDir,
  manifestPath: mocks.manifestPath,
  socketPath: mocks.socketPath,
}));

import { runMarkCommand } from '../../../src/cli/commands/mark.js';

const TEST_CONTEXT = {
  home: '/tmp/agent-terminal',
  timeoutMs: undefined,
  colorEnabled: true,
  logLevel: 'info',
  profileDefault: undefined,
  configFile: null,
} as const;

function createSessionRecord(
  status: 'running' | 'exiting' | 'exited' = 'running',
) {
  return {
    version: 1,
    sessionId: 'session-01',
    createdAt: '2026-03-19T12:00:00.000Z',
    updatedAt: '2026-03-19T12:00:01.000Z',
    status,
    command: ['/bin/sh'],
    cwd: '/tmp/workspace',
    cols: 80,
    rows: 24,
    hostPid: status === 'running' ? 123 : null,
    childPid: status === 'running' ? 456 : null,
    exitCode: status === 'exited' ? 0 : null,
    exitSignal: null,
  };
}

describe('mark command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveHome.mockReturnValue('/tmp/agent-terminal');
    mocks.sessionDir.mockImplementation(
      (_home: string, sessionId: string) =>
        `/tmp/agent-terminal/sessions/${sessionId}`,
    );
    mocks.manifestPath.mockImplementation(
      (sessionDirectory: string) => `${sessionDirectory}/session.json`,
    );
    mocks.socketPath.mockImplementation(
      (sessionDirectory: string) => `${sessionDirectory}/rpc.sock`,
    );
    mocks.readManifestIfExists.mockResolvedValue(
      createSessionRecord('running'),
    );
  });

  it('sends the mark RPC for a running session and emits the committed seq', async () => {
    mocks.sendRpc.mockResolvedValue({ seq: 12 });

    await runMarkCommand({
      context: TEST_CONTEXT,
      json: false,
      sessionId: 'session-01',
      label: 'checkpoint',
    });

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-terminal/sessions/session-01/rpc.sock',
      'mark',
      { label: 'checkpoint' },
    );
    expect(mocks.emitSuccess).toHaveBeenCalledWith({
      command: 'mark',
      json: false,
      result: { seq: 12 },
      lines: ['Marker set at seq 12.'],
    });
  });

  it('throws SESSION_NOT_RUNNING when the session is not running', async () => {
    mocks.readManifestIfExists.mockResolvedValue(createSessionRecord('exited'));

    await expect(
      runMarkCommand({
        context: TEST_CONTEXT,
        json: false,
        sessionId: 'session-01',
        label: 'checkpoint',
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.SESSION_NOT_RUNNING,
      message: 'Session "session-01" is not running.',
    });
    expect(mocks.sendRpc).not.toHaveBeenCalled();
  });

  it('throws SESSION_NOT_FOUND when the session does not exist', async () => {
    mocks.readManifestIfExists.mockResolvedValue(null);

    await expect(
      runMarkCommand({
        context: TEST_CONTEXT,
        json: false,
        sessionId: 'session-01',
        label: 'checkpoint',
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.SESSION_NOT_FOUND,
      message: 'Session "session-01" was not found.',
    });
    expect(mocks.sendRpc).not.toHaveBeenCalled();
  });

  it('accepts an empty label', async () => {
    mocks.sendRpc.mockResolvedValue({ seq: 7 });

    await runMarkCommand({
      context: TEST_CONTEXT,
      json: false,
      sessionId: 'session-01',
      label: '',
    });

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-terminal/sessions/session-01/rpc.sock',
      'mark',
      { label: '' },
    );
    expect(mocks.emitSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'mark',
        result: { seq: 7 },
      }),
    );
  });

  it('preserves JSON mode and includes seq in the result envelope', async () => {
    mocks.sendRpc.mockResolvedValue({ seq: 99 });

    await runMarkCommand({
      context: TEST_CONTEXT,
      json: true,
      sessionId: 'session-01',
      label: 'json-marker',
    });

    expect(mocks.emitSuccess).toHaveBeenCalledWith({
      command: 'mark',
      json: true,
      result: { seq: 99 },
      lines: ['Marker set at seq 99.'],
    });
  });
});
