import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ERROR_CODES, makeCliError } from '../../../src/protocol/errors.js';

const mocks = vi.hoisted(() => ({
  countEventLogEntries: vi.fn(),
  emitSuccess: vi.fn(),
  reconcileSession: vi.fn(),
  sendRpc: vi.fn(),
  readManifest: vi.fn(),
  readManifestIfExists: vi.fn(),
  resolveHome: vi.fn(),
  sessionDir: vi.fn(),
  eventLogPath: vi.fn(),
  manifestPath: vi.fn(),
  socketPath: vi.fn(),
}));

vi.mock('../../../src/cli/output.js', () => ({
  emitSuccess: mocks.emitSuccess,
}));

vi.mock('../../../src/host/eventLog.js', () => ({
  countEventLogEntries: mocks.countEventLogEntries,
}));

vi.mock('../../../src/host/lifecycle.js', () => ({
  reconcileSession: mocks.reconcileSession,
}));

vi.mock('../../../src/host/rpcClient.js', () => ({
  sendRpc: mocks.sendRpc,
}));

vi.mock('../../../src/storage/manifests.js', () => ({
  readManifest: mocks.readManifest,
  readManifestIfExists: mocks.readManifestIfExists,
}));

vi.mock('../../../src/storage/home.js', () => ({
  resolveHome: mocks.resolveHome,
}));

vi.mock('../../../src/storage/sessionPaths.js', () => ({
  sessionDir: mocks.sessionDir,
  eventLogPath: mocks.eventLogPath,
  manifestPath: mocks.manifestPath,
  socketPath: mocks.socketPath,
}));

import { runInspectCommand } from '../../../src/cli/commands/inspect.js';

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
    hostPid: status === 'exited' ? null : 123,
    childPid: status === 'exited' ? null : 456,
    exitCode: status === 'exited' ? 0 : null,
    exitSignal: null,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('inspect command', () => {
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
    mocks.eventLogPath.mockImplementation(
      (sessionDirectory: string) => `${sessionDirectory}/events.jsonl`,
    );
    mocks.socketPath.mockImplementation(
      (sessionDirectory: string) => `${sessionDirectory}/rpc.sock`,
    );
    mocks.countEventLogEntries.mockResolvedValue(2);
    mocks.readManifestIfExists.mockResolvedValue(
      createSessionRecord('running'),
    );
    mocks.readManifest.mockResolvedValue(createSessionRecord('exited'));
    mocks.reconcileSession.mockResolvedValue(undefined);
  });

  it('uses live RPC inspect data when the session is active', async () => {
    const liveSession = createSessionRecord('running');
    vi.spyOn(Date, 'now').mockReturnValue(
      Date.parse('2026-03-19T12:00:05.000Z'),
    );
    mocks.sendRpc.mockResolvedValue({ session: liveSession });

    await runInspectCommand({
      context: TEST_CONTEXT,
      json: false,
      sessionId: 'session-01',
    });

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-terminal/sessions/session-01/rpc.sock',
      'inspect',
    );
    expect(mocks.countEventLogEntries).toHaveBeenCalledWith(
      '/tmp/agent-terminal/sessions/session-01/events.jsonl',
    );
    expect(mocks.emitSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'inspect',
        json: false,
        result: {
          session: liveSession,
          eventCount: 2,
          uptime: 5000,
        },
        lines: expect.arrayContaining(['Event Count: 2', 'Uptime: 5000ms']),
      }),
    );
  });

  it('rejects malformed inspect RPC responses', async () => {
    mocks.sendRpc.mockResolvedValue({ session: { sessionId: 'session-01' } });

    await expect(
      runInspectCommand({
        context: TEST_CONTEXT,
        json: false,
        sessionId: 'session-01',
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.PROTOCOL_ERROR,
      message: 'Unexpected response from host',
      details: {
        issues: expect.any(Array) as unknown,
      },
    });
    expect(mocks.emitSuccess).not.toHaveBeenCalled();
  });

  it('falls back to reconciled manifest data when the host is unreachable', async () => {
    mocks.sendRpc.mockRejectedValue(
      makeCliError(ERROR_CODES.HOST_UNREACHABLE, {
        message: 'Session host is unreachable.',
      }),
    );

    await runInspectCommand({
      context: TEST_CONTEXT,
      json: true,
      sessionId: 'session-01',
    });

    expect(mocks.reconcileSession).toHaveBeenCalledWith(
      '/tmp/agent-terminal/sessions/session-01',
    );
    expect(mocks.readManifest).toHaveBeenCalledWith(
      '/tmp/agent-terminal/sessions/session-01/session.json',
    );
    expect(mocks.countEventLogEntries).toHaveBeenCalledWith(
      '/tmp/agent-terminal/sessions/session-01/events.jsonl',
    );
    expect(mocks.emitSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'inspect',
        json: true,
        result: {
          session: createSessionRecord('exited'),
          eventCount: 2,
          uptime: 1000,
        },
      }),
    );
  });
});
