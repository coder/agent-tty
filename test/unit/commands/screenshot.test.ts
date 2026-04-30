import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CliError } from '../../../src/cli/errors.js';
import type { ScreenshotResult } from '../../../src/protocol/messages.js';
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
  ensureArtifactsDir: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  rename: mocks.rename,
  rm: mocks.rm,
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

vi.mock('../../../src/replay/offlineReplay.js', () => ({
  withOfflineReplayRenderer: mocks.withOfflineReplayRenderer,
}));

vi.mock('../../../src/storage/artifactManifest.js', () => ({
  appendArtifact: mocks.appendArtifact,
  createArtifactEntry: mocks.createArtifactEntry,
}));

vi.mock('../../../src/storage/artifactPaths.js', () => ({
  artifactPath: vi.fn(
    (_dir: string, filename: string) => `/artifacts/${filename}`,
  ),
  ensureArtifactsDir: mocks.ensureArtifactsDir,
  screenshotFilename: vi.fn(
    (seq: number, profileName: string) =>
      `screenshot-${String(seq)}-${profileName}.png`,
  ),
}));

import { runScreenshotCommand } from '../../../src/cli/commands/screenshot.js';
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
const TEST_SCREENSHOT_SHA256 = 'a'.repeat(64);
const TEST_RENDER_PROFILE_HASH = 'b'.repeat(64);

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

function createScreenshotResult(
  overrides: Partial<ScreenshotResult> = {},
): ScreenshotResult {
  return {
    sessionId: 'session-01',
    capturedAtSeq: 5,
    profileName: 'reference-dark',
    cols: 80,
    rows: 24,
    artifactPath: '/tmp/snapshot.png',
    pngSizeBytes: 2048,
    cursorVisible: false,
    rendererBackend: 'ghostty-web',
    pixelWidth: 800,
    pixelHeight: 600,
    sha256: TEST_SCREENSHOT_SHA256,
    renderProfileHash: TEST_RENDER_PROFILE_HASH,
    ...overrides,
  };
}

type MockSessionRecord =
  | ReturnType<typeof createRunningSessionRecord>
  | ReturnType<typeof createExitedSessionRecord>;

function mockOfflineReplayRendererSuccess(
  screenshotOverrides: Partial<ScreenshotResult> = {},
): void {
  mocks.withOfflineReplayRenderer.mockImplementation(
    async (
      _options: unknown,
      run: (context: {
        manifest: MockSessionRecord;
        replayInput: Record<string, never>;
        backend: {
          screenshot(
            outputPath: string,
            options?: { showCursor?: boolean },
          ): Promise<ScreenshotResult>;
        };
      }) => Promise<unknown>,
    ) => {
      const mockBackend = {
        screenshot(
          outputPath: string,
          options?: { showCursor?: boolean },
        ): Promise<ScreenshotResult> {
          return Promise.resolve(
            createScreenshotResult({
              cursorVisible: options?.showCursor === true,
              ...screenshotOverrides,
              artifactPath: outputPath,
            }),
          );
        },
      };

      return run({
        manifest: createExitedSessionRecord(),
        replayInput: {},
        backend: mockBackend,
      });
    },
  );
}

describe('screenshot command', () => {
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
    mocks.readManifestIfExists.mockResolvedValue(createRunningSessionRecord());
    mocks.appendArtifact.mockResolvedValue(undefined);
    mocks.createArtifactEntry.mockImplementation((entry: unknown) => ({
      id: 'artifact-01',
      createdAt: '2026-03-19T12:00:02.000Z',
      ...(entry as Record<string, unknown>),
    }));
    mocks.ensureArtifactsDir.mockResolvedValue(
      '/tmp/agent-tty/sessions/session-01/artifacts',
    );
    mocks.rename.mockResolvedValue(undefined);
    mocks.rm.mockResolvedValue(undefined);
  });

  it('falls back to the default render profile when no profile is configured', async () => {
    const result = createScreenshotResult({
      capturedAtSeq: 12,
      cols: 120,
      rows: 40,
    });
    mocks.sendRpc.mockResolvedValue(result);

    await runScreenshotCommand({
      context: TEST_CONTEXT,
      json: false,
      sessionId: 'session-01',
    });

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-tty/sessions/session-01/rpc.sock',
      'screenshot',
      { profile: 'reference-dark', rendererName: 'ghostty-web' },
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
        'Renderer backend: ghostty-web',
        'Pixel dimensions: 800×600',
        `SHA-256: ${TEST_SCREENSHOT_SHA256}`,
        `Render profile hash: ${TEST_RENDER_PROFILE_HASH}`,
      ],
    });
  });

  it('threads showCursor to running-session screenshot RPC requests', async () => {
    const result = createScreenshotResult({
      artifactPath: '/tmp/show-cursor.png',
      cursorVisible: true,
    });
    mocks.sendRpc.mockResolvedValue(result);

    await runScreenshotCommand({
      context: TEST_CONTEXT,
      json: false,
      sessionId: 'session-01',
      showCursor: true,
    });

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-tty/sessions/session-01/rpc.sock',
      'screenshot',
      {
        profile: 'reference-dark',
        rendererName: 'ghostty-web',
        showCursor: true,
      },
    );
    expect(mocks.emitSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        result,
      }),
    );
  });

  it('uses the context default profile when the command omits --profile', async () => {
    const result = createScreenshotResult({
      capturedAtSeq: 18,
      profileName: 'configured-profile',
      artifactPath: '/tmp/configured.png',
    });
    mocks.sendRpc.mockResolvedValue(result);

    await runScreenshotCommand({
      context: {
        ...TEST_CONTEXT,
        profileDefault: 'configured-profile',
      },
      json: false,
      sessionId: 'session-01',
    });

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-tty/sessions/session-01/rpc.sock',
      'screenshot',
      { profile: 'configured-profile', rendererName: 'ghostty-web' },
    );
  });

  it('uses an explicit render profile over the context default and preserves JSON mode', async () => {
    const result = createScreenshotResult({
      capturedAtSeq: 22,
      profileName: 'reference-light',
      artifactPath: '/tmp/light.png',
      pngSizeBytes: 1024,
    });
    mocks.sendRpc.mockResolvedValue(result);

    await runScreenshotCommand({
      context: {
        ...TEST_CONTEXT,
        profileDefault: 'configured-profile',
      },
      json: true,
      sessionId: 'session-01',
      profile: 'reference-light',
    });

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-tty/sessions/session-01/rpc.sock',
      'screenshot',
      { profile: 'reference-light', rendererName: 'ghostty-web' },
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
        'Renderer backend: ghostty-web',
        'Pixel dimensions: 800×600',
        `SHA-256: ${TEST_SCREENSHOT_SHA256}`,
        `Render profile hash: ${TEST_RENDER_PROFILE_HASH}`,
      ],
    });
  });

  it('uses offline replay for exited sessions', async () => {
    const result = createScreenshotResult({
      artifactPath: '/artifacts/screenshot-5-reference-dark.png',
    });
    mocks.readManifestIfExists.mockResolvedValue(createExitedSessionRecord());
    mockOfflineReplayRendererSuccess();

    await runScreenshotCommand({
      context: TEST_CONTEXT,
      json: false,
      sessionId: 'session-01',
    });

    expect(mocks.sendRpc).not.toHaveBeenCalled();
    expect(mocks.withOfflineReplayRenderer).toHaveBeenCalledWith(
      {
        sessionDir: '/tmp/agent-tty/sessions/session-01',
        profileName: 'reference-dark',
        rendererName: 'ghostty-web',
      },
      expect.any(Function),
    );
    // Rename, manifest-entry construction, and manifest append are exercised
    // by `test/unit/screenshot/capture.test.ts`. Here we only check the
    // routing-level surface of the offline path.
    expect(mocks.emitSuccess).toHaveBeenCalledWith({
      command: 'screenshot',
      json: false,
      result,
      lines: [
        'Session ID: session-01',
        'Captured At Seq: 5',
        'Profile: reference-dark',
        'Size: 80x24',
        'PNG Path: /artifacts/screenshot-5-reference-dark.png',
        'PNG Size: 2048 bytes',
        'Renderer backend: ghostty-web',
        'Pixel dimensions: 800×600',
        `SHA-256: ${TEST_SCREENSHOT_SHA256}`,
        `Render profile hash: ${TEST_RENDER_PROFILE_HASH}`,
      ],
    });
  });

  it('threads showCursor to offline replay screenshots', async () => {
    const backendScreenshot = vi.fn(
      (
        outputPath: string,
        options?: { showCursor?: boolean },
      ): Promise<ScreenshotResult> =>
        Promise.resolve(
          createScreenshotResult({
            artifactPath: outputPath,
            cursorVisible: options?.showCursor === true,
          }),
        ),
    );
    mocks.readManifestIfExists.mockResolvedValue(createExitedSessionRecord());
    mocks.withOfflineReplayRenderer.mockImplementation(
      async (
        _options: unknown,
        run: (context: {
          manifest: MockSessionRecord;
          replayInput: Record<string, never>;
          backend: {
            screenshot(
              outputPath: string,
              options?: { showCursor?: boolean },
            ): Promise<ScreenshotResult>;
          };
        }) => Promise<unknown>,
      ) =>
        run({
          manifest: createExitedSessionRecord(),
          replayInput: {},
          backend: {
            screenshot: backendScreenshot,
          },
        }),
    );

    await runScreenshotCommand({
      context: TEST_CONTEXT,
      json: false,
      sessionId: 'session-01',
      showCursor: true,
    });

    expect(backendScreenshot).toHaveBeenCalledWith(
      expect.stringMatching(/^\/artifacts\/\.tmp-screenshot-.*\.png$/),
      { showCursor: true },
    );
    // Manifest-entry metadata for `cursorVisible` is exercised by
    // `test/unit/screenshot/capture.test.ts`; here we only check that the
    // command-level result reflects the requested `showCursor` value.
    expect(mocks.emitSuccess).toHaveBeenCalled();
    const emitSuccessArg = mocks.emitSuccess.mock.calls.at(-1)?.[0] as {
      result?: { cursorVisible?: boolean };
    };
    expect(emitSuccessArg.result?.cursorVisible).toBe(true);
  });

  it('falls back to offline replay when the host is unreachable', async () => {
    const result = createScreenshotResult({
      artifactPath: '/artifacts/screenshot-5-reference-dark.png',
    });
    mocks.sendRpc.mockRejectedValue(
      new CliError(ERROR_CODES.HOST_UNREACHABLE, 'host unreachable'),
    );
    mockOfflineReplayRendererSuccess();

    await runScreenshotCommand({
      context: TEST_CONTEXT,
      json: false,
      sessionId: 'session-01',
    });

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-tty/sessions/session-01/rpc.sock',
      'screenshot',
      { profile: 'reference-dark', rendererName: 'ghostty-web' },
    );
    expect(mocks.withOfflineReplayRenderer).toHaveBeenCalledTimes(1);
    expect(mocks.emitSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'screenshot',
        result,
      }),
    );
  });

  it('propagates non-HOST_UNREACHABLE errors from RPC', async () => {
    mocks.sendRpc.mockRejectedValue(
      new CliError(ERROR_CODES.PROTOCOL_ERROR, 'protocol error'),
    );

    await expect(
      runScreenshotCommand({
        context: TEST_CONTEXT,
        json: false,
        sessionId: 'session-01',
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.PROTOCOL_ERROR,
      message: 'protocol error',
    });
    expect(mocks.withOfflineReplayRenderer).not.toHaveBeenCalled();
    expect(mocks.emitSuccess).not.toHaveBeenCalled();
  });

  it('cleans up temporary artifacts when offline replay capture fails', async () => {
    const captureError = new Error('capture failed');
    mocks.readManifestIfExists.mockResolvedValue(createExitedSessionRecord());
    mocks.withOfflineReplayRenderer.mockImplementation(
      async (
        _options: unknown,
        run: (context: {
          manifest: MockSessionRecord;
          replayInput: Record<string, never>;
          backend: {
            screenshot(
              outputPath: string,
              options?: { showCursor?: boolean },
            ): Promise<ScreenshotResult>;
          };
        }) => Promise<unknown>,
      ) =>
        run({
          manifest: createExitedSessionRecord(),
          replayInput: {},
          backend: {
            screenshot(
              outputPath: string,
              options?: { showCursor?: boolean },
            ): Promise<ScreenshotResult> {
              void outputPath;
              void options;
              return Promise.reject(captureError);
            },
          },
        }),
    );

    await expect(
      runScreenshotCommand({
        context: TEST_CONTEXT,
        json: false,
        sessionId: 'session-01',
      }),
    ).rejects.toBe(captureError);
    expect(mocks.rm).toHaveBeenCalledWith(
      expect.stringMatching(/^\/artifacts\/\.tmp-screenshot-.*\.png$/),
      { force: true },
    );
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(mocks.appendArtifact).not.toHaveBeenCalled();
    expect(mocks.emitSuccess).not.toHaveBeenCalled();
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
      runScreenshotCommand({
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

  it('rejects empty screenshot profile names', async () => {
    await expect(
      runScreenshotCommand({
        context: TEST_CONTEXT,
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
