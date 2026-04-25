import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ERROR_CODES, makeCliError } from '../../../src/protocol/errors.js';

const mocks = vi.hoisted(() => ({
  emitSuccess: vi.fn(),
  sendRpc: vi.fn(),
  readManifestIfExists: vi.fn(),
  resolveHome: vi.fn(),
  sessionDir: vi.fn(),
  manifestPath: vi.fn(),
  socketPath: vi.fn(),
  withOfflineReplayRenderer: vi.fn(),
}));

vi.mock('../../../src/cli/output.js', () => ({
  emitSuccess: mocks.emitSuccess,
}));

vi.mock('../../../src/host/rpcClient.js', () => ({
  sendRpc: mocks.sendRpc,
}));

vi.mock('../../../src/replay/offlineReplay.js', () => ({
  withOfflineReplayRenderer: mocks.withOfflineReplayRenderer,
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

import { runWaitCommand } from '../../../src/cli/commands/wait.js';
import { createLogger } from '../../../src/util/logger.js';

const TEST_CONTEXT = {
  home: '/tmp/agent-tty',
  timeoutMs: undefined,
  colorEnabled: true,
  logLevel: 'info',
  logger: createLogger('info', () => undefined),
  profileDefault: undefined,
  rendererDefault: 'ghostty-web',
  configFile: null,
} as const;

function createSessionRecord(
  status: 'running' | 'exited' = 'running',
  exitCode: number | null = null,
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
    exitCode,
    exitSignal: null,
  };
}

function createOptions(
  overrides: Partial<Parameters<typeof runWaitCommand>[0]> = {},
) {
  return {
    context: TEST_CONTEXT,
    json: false,
    sessionId: 'session-01',
    waitForExit: false,
    idleMs: undefined,
    timeout: undefined,
    text: undefined,
    regex: undefined,
    screenStableMs: undefined,
    cursorRow: undefined,
    cursorCol: undefined,
    ...overrides,
  };
}

function createOfflineSemanticSnapshot(
  overrides: Partial<{
    capturedAtSeq: number;
    cursorRow: number;
    cursorCol: number;
    visibleLines: { row: number; text: string }[];
  }> = {},
) {
  return {
    sessionId: 'session-01',
    capturedAtSeq: 5,
    cols: 80,
    rows: 24,
    cursorRow: 0,
    cursorCol: 0,
    isAltScreen: false,
    visibleLines: [{ row: 0, text: 'offline output' }],
    ...overrides,
  };
}

function mockOfflineReplaySnapshot(
  snapshotOverrides: Parameters<typeof createOfflineSemanticSnapshot>[0] = {},
): void {
  mocks.withOfflineReplayRenderer.mockImplementation(
    async (
      _options: unknown,
      run: (context: {
        manifest: ReturnType<typeof createSessionRecord>;
        replayInput: Record<string, never>;
        backend: {
          snapshot: (options?: unknown) => Promise<unknown>;
        };
      }) => Promise<unknown>,
    ) => {
      const mockBackend = {
        snapshot: vi.fn(() =>
          Promise.resolve(createOfflineSemanticSnapshot(snapshotOverrides)),
        ),
      };

      return run({
        manifest: createSessionRecord('exited', 0),
        replayInput: {},
        backend: mockBackend,
      });
    },
  );
}

describe('wait command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveHome.mockReturnValue('/tmp/agent-tty');
    mocks.sessionDir.mockImplementation(
      (_home: string, sessionId: string) =>
        `/tmp/agent-tty/sessions/${sessionId}`,
    );
    mocks.manifestPath.mockImplementation(
      (sessionDirectory: string) => `${sessionDirectory}/session.json`,
    );
    mocks.socketPath.mockImplementation(
      (sessionDirectory: string) => `${sessionDirectory}/rpc.sock`,
    );
    mocks.readManifestIfExists.mockResolvedValue(createSessionRecord());
  });

  it('rejects --text and --regex together', async () => {
    await expect(
      runWaitCommand(createOptions({ text: 'hello', regex: 'world' })),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT,
      message: '--text and --regex are mutually exclusive.',
    });
    expect(mocks.sendRpc).not.toHaveBeenCalled();
  });

  it('rejects mixing --exit with render wait flags', async () => {
    const promise = runWaitCommand(
      createOptions({ waitForExit: true, text: 'hello' }),
    );

    await expect(promise).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT,
    });
    await expect(promise).rejects.toHaveProperty(
      'message',
      expect.stringContaining('Cannot mix legacy wait flags'),
    );
    expect(mocks.sendRpc).not.toHaveBeenCalled();
  });

  it('rejects mixing --idle-ms with render wait flags', async () => {
    const promise = runWaitCommand(
      createOptions({ idleMs: 500, regex: '\\d+' }),
    );

    await expect(promise).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT,
    });
    await expect(promise).rejects.toHaveProperty(
      'message',
      expect.stringContaining('Cannot mix legacy wait flags'),
    );
    expect(mocks.sendRpc).not.toHaveBeenCalled();
  });

  it('rejects negative --screen-stable-ms values', async () => {
    await expect(
      runWaitCommand(createOptions({ screenStableMs: -1 })),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_DURATION,
      details: { screenStableMs: -1 },
    });
    expect(mocks.sendRpc).not.toHaveBeenCalled();
  });

  it('rejects non-integer --screen-stable-ms values', async () => {
    await expect(
      runWaitCommand(createOptions({ screenStableMs: 1.5 })),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_DURATION,
      details: { screenStableMs: 1.5 },
    });
    expect(mocks.sendRpc).not.toHaveBeenCalled();
  });

  it('rejects negative --cursor-row values', async () => {
    await expect(
      runWaitCommand(createOptions({ cursorRow: -1 })),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT,
      details: { cursorRow: -1 },
    });
    expect(mocks.sendRpc).not.toHaveBeenCalled();
  });

  it('rejects non-integer --cursor-row values', async () => {
    await expect(
      runWaitCommand(createOptions({ cursorRow: 1.5 })),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT,
      details: { cursorRow: 1.5 },
    });
    expect(mocks.sendRpc).not.toHaveBeenCalled();
  });

  it('rejects negative --cursor-col values', async () => {
    await expect(
      runWaitCommand(createOptions({ cursorCol: -1 })),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT,
      details: { cursorCol: -1 },
    });
    expect(mocks.sendRpc).not.toHaveBeenCalled();
  });

  it('rejects non-integer --cursor-col values', async () => {
    await expect(
      runWaitCommand(createOptions({ cursorCol: 1.5 })),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT,
      details: { cursorCol: 1.5 },
    });
    expect(mocks.sendRpc).not.toHaveBeenCalled();
  });

  it('accepts --timeout 0 for infinite render waits', async () => {
    const result = {
      matched: true,
      timedOut: false,
      matchedText: 'hello',
      capturedAtSeq: 12,
    };
    mocks.sendRpc.mockResolvedValue(result);

    await runWaitCommand(createOptions({ text: 'hello', timeout: 0 }));

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-tty/sessions/session-01/rpc.sock',
      'waitForRender',
      {
        text: 'hello',
        regex: undefined,
        screenStableMs: undefined,
        cursorRow: undefined,
        cursorCol: undefined,
        timeoutMs: undefined,
        rendererName: 'ghostty-web',
      },
      0,
    );
    expect(mocks.emitSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'wait',
        result,
      }),
    );
  });

  it('rejects negative --timeout values for render waits', async () => {
    await expect(
      runWaitCommand(createOptions({ text: 'hello', timeout: -1 })),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_DURATION,
      details: { timeout: -1 },
    });
    expect(mocks.sendRpc).not.toHaveBeenCalled();
  });

  it('requires one wait mode when no flags are provided', async () => {
    await expect(runWaitCommand(createOptions())).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_DURATION,
      message: 'Specify exactly one of --exit or --idle-ms.',
    });
    expect(mocks.sendRpc).not.toHaveBeenCalled();
  });

  it('routes --exit waits to the legacy wait RPC', async () => {
    const result = { timedOut: false, exitCode: 0 };
    mocks.sendRpc.mockResolvedValue(result);

    await runWaitCommand(createOptions({ waitForExit: true }));

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-tty/sessions/session-01/rpc.sock',
      'wait',
      {
        exit: true,
        idleMs: undefined,
        timeoutMs: 600_000,
      },
      605_000,
    );
    expect(mocks.emitSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'wait',
        result,
      }),
    );
  });

  it('routes --idle-ms waits to the legacy wait RPC', async () => {
    const result = { timedOut: false };
    mocks.sendRpc.mockResolvedValue(result);

    await runWaitCommand(createOptions({ idleMs: 500 }));

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-tty/sessions/session-01/rpc.sock',
      'wait',
      {
        exit: undefined,
        idleMs: 500,
        timeoutMs: 600_000,
      },
      605_000,
    );
    expect(mocks.emitSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'wait',
        result,
      }),
    );
  });

  it('routes --text waits to the render wait RPC', async () => {
    const result = {
      matched: true,
      timedOut: false,
      matchedText: 'hello',
      capturedAtSeq: 7,
    };
    mocks.sendRpc.mockResolvedValue(result);

    await runWaitCommand(createOptions({ text: 'hello' }));

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-tty/sessions/session-01/rpc.sock',
      'waitForRender',
      {
        text: 'hello',
        regex: undefined,
        screenStableMs: undefined,
        cursorRow: undefined,
        cursorCol: undefined,
        timeoutMs: 600_000,
        rendererName: 'ghostty-web',
      },
      605_000,
    );
    expect(mocks.emitSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'wait',
        result,
      }),
    );
  });

  it('routes --regex waits to the render wait RPC', async () => {
    const result = {
      matched: true,
      timedOut: false,
      matchedText: '42',
      capturedAtSeq: 9,
    };
    mocks.sendRpc.mockResolvedValue(result);

    await runWaitCommand(createOptions({ regex: '\\d+' }));

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-tty/sessions/session-01/rpc.sock',
      'waitForRender',
      {
        text: undefined,
        regex: '\\d+',
        screenStableMs: undefined,
        cursorRow: undefined,
        cursorCol: undefined,
        timeoutMs: 600_000,
        rendererName: 'ghostty-web',
      },
      605_000,
    );
    expect(mocks.emitSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'wait',
        result,
      }),
    );
  });

  it('routes cursor waits to the render wait RPC', async () => {
    const result = {
      matched: true,
      timedOut: false,
      cursorRow: 3,
      cursorCol: 4,
      capturedAtSeq: 11,
    };
    mocks.sendRpc.mockResolvedValue(result);

    await runWaitCommand(
      createOptions({ text: 'hello', cursorRow: 3, cursorCol: 4 }),
    );

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-tty/sessions/session-01/rpc.sock',
      'waitForRender',
      {
        text: 'hello',
        regex: undefined,
        screenStableMs: undefined,
        cursorRow: 3,
        cursorCol: 4,
        timeoutMs: 600_000,
        rendererName: 'ghostty-web',
      },
      605_000,
    );
    expect(mocks.emitSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'wait',
        result,
      }),
    );
  });

  it('falls back to offline replay when render wait host becomes unreachable and the snapshot matches', async () => {
    mocks.sendRpc.mockRejectedValue(
      makeCliError(ERROR_CODES.HOST_UNREACHABLE, {
        message: 'Session host is unreachable.',
      }),
    );
    mockOfflineReplaySnapshot({
      capturedAtSeq: 15,
      visibleLines: [{ row: 0, text: 'offline hello output' }],
    });

    await runWaitCommand(createOptions({ text: 'hello' }));

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-tty/sessions/session-01/rpc.sock',
      'waitForRender',
      {
        text: 'hello',
        regex: undefined,
        screenStableMs: undefined,
        cursorRow: undefined,
        cursorCol: undefined,
        timeoutMs: 600_000,
        rendererName: 'ghostty-web',
      },
      605_000,
    );
    expect(mocks.withOfflineReplayRenderer).toHaveBeenCalledWith(
      {
        sessionDir: '/tmp/agent-tty/sessions/session-01',
        rendererName: 'ghostty-web',
      },
      expect.any(Function),
    );
    expect(mocks.emitSuccess).toHaveBeenCalledWith({
      command: 'wait',
      json: false,
      result: {
        matched: true,
        timedOut: false,
        matchedText: 'hello',
        cursorRow: 0,
        cursorCol: 0,
        capturedAtSeq: 15,
      },
      lines: ['Matched: hello', 'Cursor: row 0, col 0', 'capturedAtSeq: 15'],
    });
  });

  it('returns a descriptive error when the offline snapshot does not satisfy the wait condition', async () => {
    mocks.sendRpc.mockRejectedValue(
      makeCliError(ERROR_CODES.HOST_UNREACHABLE, {
        message: 'Session host is unreachable.',
      }),
    );
    mockOfflineReplaySnapshot({
      capturedAtSeq: 21,
      visibleLines: [{ row: 0, text: 'offline output' }],
    });

    const promise = runWaitCommand(createOptions({ text: 'hello' }));

    await expect(promise).rejects.toMatchObject({
      code: ERROR_CODES.REPLAY_ERROR,
      details: {
        text: 'hello',
        capturedAtSeq: 21,
        visibleLines: ['offline output'],
      },
    });
    await expect(promise).rejects.toHaveProperty(
      'message',
      expect.stringContaining('latest offline snapshot did not satisfy'),
    );
    expect(mocks.emitSuccess).not.toHaveBeenCalled();
  });

  it('surfaces RPC timeout errors for render waits', async () => {
    mocks.sendRpc.mockRejectedValue(
      makeCliError(ERROR_CODES.HOST_TIMEOUT, {
        message: 'Session host timed out.',
      }),
    );

    await expect(
      runWaitCommand(createOptions({ text: 'hello', timeout: 1 })),
    ).rejects.toMatchObject({
      code: ERROR_CODES.HOST_TIMEOUT,
      message: 'Session host timed out.',
    });
    expect(mocks.emitSuccess).not.toHaveBeenCalled();
  });

  it('rejects malformed legacy wait RPC responses', async () => {
    mocks.sendRpc.mockResolvedValue({
      timedOut: false,
      exitCode: 1.5,
    });

    await expect(
      runWaitCommand(createOptions({ waitForExit: true })),
    ).rejects.toMatchObject({
      code: ERROR_CODES.PROTOCOL_ERROR,
      message: 'Unexpected response from host',
      details: {
        issues: expect.any(Array) as unknown,
      },
    });
    expect(mocks.emitSuccess).not.toHaveBeenCalled();
  });

  it('rejects malformed render wait RPC responses', async () => {
    mocks.sendRpc.mockResolvedValue({
      matched: true,
      timedOut: false,
      capturedAtSeq: '7',
    });

    await expect(
      runWaitCommand(createOptions({ text: 'hello' })),
    ).rejects.toMatchObject({
      code: ERROR_CODES.PROTOCOL_ERROR,
      message: 'Unexpected response from host',
      details: {
        issues: expect.any(Array) as unknown,
      },
    });
    expect(mocks.emitSuccess).not.toHaveBeenCalled();
  });

  it('rejects missing sessions before contacting RPC', async () => {
    mocks.readManifestIfExists.mockResolvedValue(null);

    await expect(
      runWaitCommand(createOptions({ waitForExit: true })),
    ).rejects.toMatchObject({
      code: ERROR_CODES.SESSION_NOT_FOUND,
      details: {
        sessionId: 'session-01',
        manifestPath: '/tmp/agent-tty/sessions/session-01/session.json',
      },
    });
    expect(mocks.sendRpc).not.toHaveBeenCalled();
  });

  it('surfaces render wait errors when the session is no longer running', async () => {
    mocks.readManifestIfExists.mockResolvedValue(
      createSessionRecord('exited', 0),
    );
    mocks.sendRpc.mockRejectedValue(
      makeCliError(ERROR_CODES.SESSION_NOT_RUNNING, {
        message: 'Session "session-01" is not running.',
        details: {
          sessionId: 'session-01',
          status: 'exited',
        },
      }),
    );

    await expect(
      runWaitCommand(createOptions({ text: 'hello' })),
    ).rejects.toMatchObject({
      code: ERROR_CODES.SESSION_NOT_RUNNING,
      details: {
        sessionId: 'session-01',
        status: 'exited',
      },
    });
  });
});
