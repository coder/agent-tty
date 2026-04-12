import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CliError } from '../../../src/cli/errors.js';
import { ERROR_CODES } from '../../../src/protocol/errors.js';

const mocks = vi.hoisted(() => ({
  emitSuccess: vi.fn(),
  sendRpc: vi.fn(),
  readManifestIfExists: vi.fn(),
  resolveHome: vi.fn(),
  sessionDir: vi.fn(),
  manifestPath: vi.fn(),
  socketPath: vi.fn(),
  withOfflineReplayRenderer: vi.fn(),
  appendArtifact: vi.fn(),
  createArtifactEntry: vi.fn(),
  artifactPath: vi.fn(),
  ensureArtifactsDir: vi.fn(),
  snapshotFilename: vi.fn(),
  writeTextFileAtomic: vi.fn(),
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

vi.mock('../../../src/storage/artifactManifest.js', () => ({
  appendArtifact: mocks.appendArtifact,
  createArtifactEntry: mocks.createArtifactEntry,
}));

vi.mock('../../../src/storage/artifactPaths.js', () => ({
  artifactPath: mocks.artifactPath,
  ensureArtifactsDir: mocks.ensureArtifactsDir,
  snapshotFilename: mocks.snapshotFilename,
}));

vi.mock('../../../src/storage/manifests.js', () => ({
  readManifestIfExists: mocks.readManifestIfExists,
  writeTextFileAtomic: mocks.writeTextFileAtomic,
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
import { createLogger } from '../../../src/util/logger.js';

const TEST_CONTEXT = {
  home: '/tmp/agent-tty',
  timeoutMs: undefined,
  colorEnabled: true,
  logLevel: 'info',
  logger: createLogger('info', () => undefined),
  profileDefault: undefined,
  configFile: null,
} as const;

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

function createExitedSessionRecord() {
  return {
    ...createRunningSessionRecord(),
    status: 'exited' as const,
    hostPid: null,
    childPid: null,
    exitCode: 0,
    exitSignal: null,
  };
}

type MaybePromise<T> = T | Promise<T>;

function getLastEmitSuccessPayload(): unknown {
  return mocks.emitSuccess.mock.calls.at(-1)?.[0] as unknown;
}

function createOfflineSemanticSnapshot(
  options: {
    scrollbackLines?: { row: number; text: string }[];
    cells?: {
      lineNumber: number;
      cells: {
        char: string;
        fg?: string;
        bg?: string;
        bold?: boolean;
        italic?: boolean;
        underline?: boolean;
        strikethrough?: boolean;
      }[];
    }[];
  } = {},
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
    ...(options.scrollbackLines === undefined
      ? {}
      : { scrollbackLines: options.scrollbackLines }),
    ...(options.cells === undefined ? {} : { cells: options.cells }),
  };
}

function installOfflineReplaySuccessMock(
  snapshotImpl: (
    options?: unknown,
  ) => MaybePromise<ReturnType<typeof createOfflineSemanticSnapshot>> = () =>
    createOfflineSemanticSnapshot(),
) {
  mocks.withOfflineReplayRenderer.mockImplementation(
    async (_options: unknown, run: (ctx: unknown) => Promise<unknown>) => {
      const mockBackend = {
        snapshot(options?: unknown) {
          return Promise.resolve(snapshotImpl(options));
        },
        rendererBackend: 'mock-backend',
      };

      return run({
        manifest: createExitedSessionRecord(),
        replayInput: {},
        backend: mockBackend,
      });
    },
  );
}

describe('snapshot command', () => {
  beforeEach(() => {
    vi.resetAllMocks();
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
    mocks.readManifestIfExists.mockResolvedValue(createRunningSessionRecord());
    mocks.createArtifactEntry.mockImplementation(
      (entry: Record<string, unknown>) => ({
        ...entry,
        id: 'artifact-01',
        createdAt: '2026-03-19T12:00:02.000Z',
      }),
    );
    mocks.artifactPath.mockImplementation(
      (_dir: string, filename: string) => `/artifacts/${filename}`,
    );
    mocks.snapshotFilename.mockImplementation(
      (seq: number, format: string) => `snapshot-${String(seq)}-${format}.json`,
    );
    mocks.ensureArtifactsDir.mockResolvedValue('/artifacts');
    mocks.appendArtifact.mockResolvedValue(undefined);
    mocks.writeTextFileAtomic.mockResolvedValue(undefined);
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
      context: TEST_CONTEXT,
      json: false,
      sessionId: 'session-01',
    });

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-tty/sessions/session-01/rpc.sock',
      'snapshot',
      { format: 'structured', includeScrollback: false, includeCells: false },
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
      context: TEST_CONTEXT,
      json: true,
      sessionId: 'session-01',
      format: 'text',
    });

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-tty/sessions/session-01/rpc.sock',
      'snapshot',
      { format: 'text', includeScrollback: false, includeCells: false },
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

  it('includes scrollbackLines in structured RPC snapshots when includeScrollback is true', async () => {
    const result = {
      format: 'structured' as const,
      sessionId: 'session-01',
      capturedAtSeq: 12,
      cols: 120,
      rows: 40,
      cursorRow: 4,
      cursorCol: 5,
      isAltScreen: false,
      visibleLines: [{ row: 0, text: 'visible' }],
      scrollbackLines: [
        { row: 0, text: 'scrolled' },
        { row: 1, text: 'away' },
      ],
    };
    mocks.sendRpc.mockResolvedValue(result);

    await runSnapshotCommand({
      context: TEST_CONTEXT,
      json: false,
      sessionId: 'session-01',
      includeScrollback: true,
    });

    expect(mocks.sendRpc).toHaveBeenCalledWith(expect.any(String), 'snapshot', {
      format: 'structured',
      includeScrollback: true,
      includeCells: false,
    });
    const emitted = getLastEmitSuccessPayload() as {
      lines: string[];
    };
    expect(emitted.lines).toEqual(
      expect.arrayContaining([
        'Scrollback Lines (2):',
        '  [0] scrolled',
        '  [1] away',
        'Visible Lines (1):',
        '  [0] visible',
      ]),
    );
  });

  it('requests structured cell data in RPC snapshots only when includeCells is true', async () => {
    const result = {
      format: 'structured' as const,
      sessionId: 'session-01',
      capturedAtSeq: 12,
      cols: 3,
      rows: 1,
      cursorRow: 0,
      cursorCol: 2,
      isAltScreen: false,
      visibleLines: [{ row: 0, text: 'hey' }],
      cells: [
        {
          lineNumber: 0,
          cells: [
            { char: 'h', fg: '#ffffff', bg: '#000000' },
            { char: 'e', fg: '#ffeeaa', bg: '#000000', italic: true },
            { char: 'y', fg: '#00ff00', bg: '#000000', bold: true },
          ],
        },
      ],
    };
    mocks.sendRpc.mockResolvedValue(result);

    await runSnapshotCommand({
      context: TEST_CONTEXT,
      json: true,
      sessionId: 'session-01',
      includeCells: true,
    });

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-tty/sessions/session-01/rpc.sock',
      'snapshot',
      {
        format: 'structured',
        includeScrollback: false,
        includeCells: true,
      },
    );
    expect(mocks.emitSuccess).toHaveBeenCalledWith({
      command: 'snapshot',
      json: true,
      result,
      lines: [
        'Session ID: session-01',
        'Captured At Seq: 12',
        'Format: structured',
        'Size: 3x1',
        'Cursor: row 0, col 2',
        'Alt Screen: no',
        'Visible Lines (1):',
        '  [0] hey',
      ],
    });
  });

  it('preserves host-prepended scrollback text in text RPC snapshots when includeScrollback is true', async () => {
    const result = {
      format: 'text' as const,
      sessionId: 'session-01',
      capturedAtSeq: 7,
      cols: 80,
      rows: 24,
      cursorRow: 2,
      cursorCol: 3,
      text: 'scrolled\naway\nvisible',
    };
    mocks.sendRpc.mockResolvedValue(result);

    await runSnapshotCommand({
      context: TEST_CONTEXT,
      json: false,
      sessionId: 'session-01',
      format: 'text',
      includeScrollback: true,
    });

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-tty/sessions/session-01/rpc.sock',
      'snapshot',
      { format: 'text', includeScrollback: true, includeCells: false },
    );
    expect(mocks.emitSuccess).toHaveBeenCalledWith({
      command: 'snapshot',
      json: false,
      result,
      lines: [
        'Session ID: session-01',
        'Captured At Seq: 7',
        'Format: text',
        'Size: 80x24',
        'Cursor: row 2, col 3',
        'Text:',
        'scrolled\naway\nvisible',
      ],
    });
  });

  it('uses offline replay for exited sessions and persists the artifact', async () => {
    const snapshot = createOfflineSemanticSnapshot();
    const result = {
      format: 'structured' as const,
      ...snapshot,
    };
    mocks.readManifestIfExists.mockResolvedValue(createExitedSessionRecord());
    installOfflineReplaySuccessMock();

    await runSnapshotCommand({
      context: TEST_CONTEXT,
      json: false,
      sessionId: 'session-01',
    });

    expect(mocks.sendRpc).not.toHaveBeenCalled();
    expect(mocks.withOfflineReplayRenderer).toHaveBeenCalledWith(
      { sessionDir: '/tmp/agent-tty/sessions/session-01' },
      expect.any(Function),
    );
    expect(mocks.ensureArtifactsDir).toHaveBeenCalledWith(
      '/tmp/agent-tty/sessions/session-01',
    );
    expect(mocks.snapshotFilename).toHaveBeenCalledWith(5, 'structured');
    expect(mocks.writeTextFileAtomic).toHaveBeenCalledWith({
      path: '/artifacts/snapshot-5-structured.json',
      pathLabel: 'snapshot artifact path',
      contents: `${JSON.stringify(result, null, 2)}\n`,
      writeErrorMessage:
        'Failed to write snapshot artifact at /artifacts/snapshot-5-structured.json.',
    });
    expect(mocks.createArtifactEntry).toHaveBeenCalledWith({
      kind: 'snapshot',
      filename: 'snapshot-5-structured.json',
      sessionId: 'session-01',
      capturedAtSeq: 5,
      metadata: {
        format: 'structured',
        cols: 80,
        rows: 24,
        cursorRow: 0,
        cursorCol: 0,
        rendererBackend: 'mock-backend',
      },
    });
    expect(mocks.appendArtifact).toHaveBeenCalledWith(
      '/tmp/agent-tty/sessions/session-01',
      {
        kind: 'snapshot',
        filename: 'snapshot-5-structured.json',
        sessionId: 'session-01',
        capturedAtSeq: 5,
        metadata: {
          format: 'structured',
          cols: 80,
          rows: 24,
          cursorRow: 0,
          cursorCol: 0,
          rendererBackend: 'mock-backend',
        },
        id: 'artifact-01',
        createdAt: '2026-03-19T12:00:02.000Z',
      },
    );
    expect(mocks.emitSuccess).toHaveBeenCalledWith({
      command: 'snapshot',
      json: false,
      result,
      lines: [
        'Session ID: session-01',
        'Captured At Seq: 5',
        'Format: structured',
        'Size: 80x24',
        'Cursor: row 0, col 0',
        'Alt Screen: no',
        'Visible Lines (1):',
        '  [0] offline output',
      ],
    });
  });

  it('uses offline replay for exited sessions and includes scrollback when requested', async () => {
    const snapshotMock = vi.fn((options?: unknown) =>
      createOfflineSemanticSnapshot(
        (options as { includeScrollback?: boolean } | undefined)
          ?.includeScrollback
          ? {
              scrollbackLines: [
                { row: 0, text: 'scrolled' },
                { row: 1, text: 'away' },
              ],
            }
          : {},
      ),
    );
    mocks.readManifestIfExists.mockResolvedValue(createExitedSessionRecord());
    installOfflineReplaySuccessMock(snapshotMock);

    await runSnapshotCommand({
      context: TEST_CONTEXT,
      json: false,
      sessionId: 'session-01',
      includeScrollback: true,
    });

    expect(snapshotMock).toHaveBeenCalledWith({
      includeScrollback: true,
      includeCells: false,
    });
    const emitted = getLastEmitSuccessPayload() as {
      result: {
        scrollbackLines?: { row: number; text: string }[];
      };
      lines: string[];
    };
    expect(emitted.result.scrollbackLines).toEqual([
      { row: 0, text: 'scrolled' },
      { row: 1, text: 'away' },
    ]);
    expect(emitted.lines).toEqual(
      expect.arrayContaining([
        'Scrollback Lines (2):',
        '  [0] scrolled',
        '  [1] away',
        'Visible Lines (1):',
        '  [0] offline output',
      ]),
    );
  });

  it('threads includeCells through offline replay snapshots and persists cells', async () => {
    const snapshotMock = vi.fn((options?: unknown) =>
      createOfflineSemanticSnapshot(
        (options as { includeCells?: boolean } | undefined)?.includeCells
          ? {
              cells: [
                {
                  lineNumber: 0,
                  cells: [
                    { char: 'o', fg: '#ffffff', bg: '#000000' },
                    { char: 'k', fg: '#00ff00', bg: '#000000', bold: true },
                  ],
                },
              ],
            }
          : {},
      ),
    );
    mocks.readManifestIfExists.mockResolvedValue(createExitedSessionRecord());
    installOfflineReplaySuccessMock(snapshotMock);

    await runSnapshotCommand({
      context: TEST_CONTEXT,
      json: true,
      sessionId: 'session-01',
      includeCells: true,
    });

    expect(snapshotMock).toHaveBeenCalledWith({
      includeScrollback: false,
      includeCells: true,
    });
    const emitted = getLastEmitSuccessPayload() as {
      result: {
        cells?: {
          lineNumber: number;
          cells: { char: string; bold?: boolean }[];
        }[];
      };
    };
    expect(emitted.result.cells).toEqual([
      {
        lineNumber: 0,
        cells: [
          { char: 'o', fg: '#ffffff', bg: '#000000' },
          { char: 'k', fg: '#00ff00', bg: '#000000', bold: true },
        ],
      },
    ]);
  });

  it('defaults offline snapshots to omitting scrollbackLines', async () => {
    const snapshotMock = vi.fn((options?: unknown) =>
      createOfflineSemanticSnapshot(
        (options as { includeScrollback?: boolean } | undefined)
          ?.includeScrollback
          ? {
              scrollbackLines: [{ row: 0, text: 'unexpected scrollback' }],
            }
          : {},
      ),
    );
    mocks.readManifestIfExists.mockResolvedValue(createExitedSessionRecord());
    installOfflineReplaySuccessMock(snapshotMock);

    await runSnapshotCommand({
      context: TEST_CONTEXT,
      json: false,
      sessionId: 'session-01',
    });

    expect(snapshotMock).toHaveBeenCalledWith({
      includeScrollback: false,
      includeCells: false,
    });
    const emitted = getLastEmitSuccessPayload() as {
      result: {
        scrollbackLines?: { row: number; text: string }[];
      };
      lines: string[];
    };
    expect(emitted.result.scrollbackLines).toBeUndefined();
    expect(emitted.lines).not.toEqual(
      expect.arrayContaining(['Scrollback Lines (1):']),
    );
  });

  it('falls back to offline replay when the running session host is unreachable', async () => {
    const result = {
      format: 'text' as const,
      sessionId: 'session-01',
      capturedAtSeq: 5,
      cols: 80,
      rows: 24,
      cursorRow: 0,
      cursorCol: 0,
      text: 'offline output',
    };
    mocks.sendRpc.mockRejectedValue(
      new CliError(ERROR_CODES.HOST_UNREACHABLE, 'host unreachable'),
    );
    installOfflineReplaySuccessMock();

    await runSnapshotCommand({
      context: TEST_CONTEXT,
      json: true,
      sessionId: 'session-01',
      format: 'text',
    });

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-tty/sessions/session-01/rpc.sock',
      'snapshot',
      { format: 'text', includeScrollback: false, includeCells: false },
    );
    expect(mocks.withOfflineReplayRenderer).toHaveBeenCalledWith(
      { sessionDir: '/tmp/agent-tty/sessions/session-01' },
      expect.any(Function),
    );
    expect(mocks.emitSuccess).toHaveBeenCalledWith({
      command: 'snapshot',
      json: true,
      result,
      lines: [
        'Session ID: session-01',
        'Captured At Seq: 5',
        'Format: text',
        'Size: 80x24',
        'Cursor: row 0, col 0',
        'Text:',
        'offline output',
      ],
    });
  });

  it('propagates non-HOST_UNREACHABLE errors from RPC', async () => {
    mocks.sendRpc.mockRejectedValue(
      new CliError(ERROR_CODES.PROTOCOL_ERROR, 'protocol failed'),
    );

    await expect(
      runSnapshotCommand({
        context: TEST_CONTEXT,
        json: false,
        sessionId: 'session-01',
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.PROTOCOL_ERROR,
      message: 'protocol failed',
    });
    expect(mocks.withOfflineReplayRenderer).not.toHaveBeenCalled();
    expect(mocks.emitSuccess).not.toHaveBeenCalled();
  });

  it('rejects malformed snapshot RPC responses', async () => {
    mocks.sendRpc.mockResolvedValue({
      format: 'structured',
      sessionId: 'session-01',
      capturedAtSeq: 12,
      cols: 120,
      rows: 40,
      cursorRow: 4,
      isAltScreen: false,
      visibleLines: [],
    });

    await expect(
      runSnapshotCommand({
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

  it('rejects invalid session identifiers before reading the manifest', async () => {
    mocks.sessionDir.mockImplementation(() => {
      throw new Error('sessionId must not contain path separators');
    });

    await expect(
      runSnapshotCommand({
        context: TEST_CONTEXT,
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
        context: TEST_CONTEXT,
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
