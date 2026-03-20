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

import { runScreenshotCommand } from '../../../src/cli/commands/screenshot.js';

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

describe('screenshot command', () => {
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

  it('requests screenshots with the default render profile', async () => {
    const result = {
      sessionId: 'session-01',
      capturedAtSeq: 12,
      profileName: 'reference-dark',
      cols: 120,
      rows: 40,
      artifactPath: '/tmp/snapshot.png',
      pngSizeBytes: 2048,
    };
    mocks.sendRpc.mockResolvedValue(result);

    await runScreenshotCommand({
      json: false,
      sessionId: 'session-01',
    });

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-terminal/sessions/session-01/rpc.sock',
      'screenshot',
      { profile: 'reference-dark' },
    );
    expect(mocks.emitSuccess).toHaveBeenCalledWith({
      command: 'screenshot',
      json: false,
      result,
      lines: [
        'Session ID: session-01',
        'Captured At Seq: 12',
        'Profile: reference-dark',
        'Size: 120x40',
        'PNG Path: /tmp/snapshot.png',
        'PNG Size: 2048 bytes',
      ],
    });
  });

  it('uses an explicit render profile and preserves JSON mode', async () => {
    const result = {
      sessionId: 'session-01',
      capturedAtSeq: 22,
      profileName: 'reference-light',
      cols: 80,
      rows: 24,
      artifactPath: '/tmp/light.png',
      pngSizeBytes: 1024,
    };
    mocks.sendRpc.mockResolvedValue(result);

    await runScreenshotCommand({
      json: true,
      sessionId: 'session-01',
      profile: 'reference-light',
    });

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-terminal/sessions/session-01/rpc.sock',
      'screenshot',
      { profile: 'reference-light' },
    );
    expect(mocks.emitSuccess).toHaveBeenCalledWith({
      command: 'screenshot',
      json: true,
      result,
      lines: [
        'Session ID: session-01',
        'Captured At Seq: 22',
        'Profile: reference-light',
        'Size: 80x24',
        'PNG Path: /tmp/light.png',
        'PNG Size: 1024 bytes',
      ],
    });
  });

  it('rejects malformed screenshot RPC responses', async () => {
    mocks.sendRpc.mockResolvedValue({
      sessionId: 'session-01',
      capturedAtSeq: 12,
      profileName: 'reference-dark',
      cols: 120,
      rows: 40,
      artifactPath: '/tmp/snapshot.png',
    });

    await expect(
      runScreenshotCommand({
        json: false,
        sessionId: 'session-01',
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.PROTOCOL_ERROR,
      message: 'Unexpected response from host',
      details: {
        issues: expect.any(Array),
      },
    });
    expect(mocks.emitSuccess).not.toHaveBeenCalled();
  });

  it('rejects invalid session identifiers before reading the manifest', async () => {
    mocks.sessionDir.mockImplementation(() => {
      throw new Error('sessionId must not contain path separators');
    });

    await expect(
      runScreenshotCommand({
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

  it('rejects empty screenshot profile names', async () => {
    await expect(
      runScreenshotCommand({
        json: false,
        sessionId: 'session-01',
        profile: '',
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT,
      details: {
        profile: '',
      },
    });
    expect(mocks.sendRpc).not.toHaveBeenCalled();
  });
});
