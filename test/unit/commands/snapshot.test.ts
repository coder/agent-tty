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

import { runSnapshotCommand } from '../../../src/cli/commands/snapshot.js';

function createRunningSessionRecord() {
  return {
    version: 1,
    sessionId: 'session-01',
    createdAt: '2026-03-19T12:00:00.000Z',
    updatedAt: '2026-03-19T12:00:01.000Z',
    status: 'running' as const,
    command: ['/bin/sh'],
    cwd: '/tmp/workspace',
    cols: 80,
    rows: 24,
    hostPid: 123,
    childPid: 456,
    exitCode: null,
    exitSignal: null,
  };
}

describe('snapshot command', () => {
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
    mocks.readManifestIfExists.mockResolvedValue(createRunningSessionRecord());
  });

  it('requests structured snapshots by default and formats human output', async () => {
    const result = {
      format: 'structured' as const,
      sessionId: 'session-01',
      capturedAtSeq: 12,
      cols: 120,
      rows: 40,
      cursorRow: 4,
      cursorCol: 5,
      isAltScreen: false,
      visibleLines: [
        { row: 0, text: 'hello' },
        { row: 1, text: 'world' },
      ],
    };
    mocks.sendRpc.mockResolvedValue(result);

    await runSnapshotCommand({
      json: false,
      sessionId: 'session-01',
    });

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-terminal/sessions/session-01/rpc.sock',
      'snapshot',
      { format: 'structured' },
    );
    expect(mocks.emitSuccess).toHaveBeenCalledWith({
      command: 'snapshot',
      json: false,
      result,
      lines: [
        'Session ID: session-01',
        'Captured At Seq: 12',
        'Format: structured',
        'Size: 120x40',
        'Cursor: row 4, col 5',
        'Alt Screen: no',
        'Visible Lines (2):',
        '  [0] hello',
        '  [1] world',
      ],
    });
  });

  it('requests text snapshots when asked and preserves JSON mode', async () => {
    const result = {
      format: 'text' as const,
      sessionId: 'session-01',
      capturedAtSeq: 7,
      cols: 80,
      rows: 24,
      cursorRow: 2,
      cursorCol: 3,
      text: 'hello\nworld',
    };
    mocks.sendRpc.mockResolvedValue(result);

    await runSnapshotCommand({
      json: true,
      sessionId: 'session-01',
      format: 'text',
    });

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-terminal/sessions/session-01/rpc.sock',
      'snapshot',
      { format: 'text' },
    );
    expect(mocks.emitSuccess).toHaveBeenCalledWith({
      command: 'snapshot',
      json: true,
      result,
      lines: [
        'Session ID: session-01',
        'Captured At Seq: 7',
        'Format: text',
        'Size: 80x24',
        'Cursor: row 2, col 3',
        'Text:',
        'hello\nworld',
      ],
    });
  });

  it('rejects invalid session identifiers before reading the manifest', async () => {
    mocks.sessionDir.mockImplementation(() => {
      throw new Error('sessionId must not contain path separators');
    });

    await expect(
      runSnapshotCommand({
        json: false,
        sessionId: '../bad-session',
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_SESSION_ID,
      details: {
        sessionId: '../bad-session',
      },
    });
    expect(mocks.readManifestIfExists).not.toHaveBeenCalled();
  });

  it('rejects unsupported snapshot formats', async () => {
    await expect(
      runSnapshotCommand({
        json: false,
        sessionId: 'session-01',
        format: 'binary',
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT,
      details: {
        format: 'binary',
      },
    });
    expect(mocks.sendRpc).not.toHaveBeenCalled();
  });
});
