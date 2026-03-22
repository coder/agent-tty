import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VideoCapableRendererBackend } from '../../../src/renderer/backend.js';
import type {
  EventRecord,
  SessionRecord,
} from '../../../src/protocol/schemas.js';

const mocks = vi.hoisted(() => ({
  buildReplayInput: vi.fn(),
  resolveProfile: vi.fn(),
}));

vi.mock('../../../src/host/replay.js', () => ({
  buildReplayInput: mocks.buildReplayInput,
}));

vi.mock('../../../src/renderer/profiles.js', () => ({
  resolveProfile: mocks.resolveProfile,
}));

import { generateWebmExport } from '../../../src/export/webm.js';

function createManifest(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    version: 1,
    sessionId: 'session-01',
    createdAt: '2026-03-19T12:00:00.000Z',
    updatedAt: '2026-03-19T12:00:01.000Z',
    status: 'running',
    command: ['/bin/sh'],
    cwd: '/tmp/workspace',
    cols: 80,
    rows: 24,
    hostPid: 123,
    childPid: 456,
    exitCode: null,
    exitSignal: null,
    ...overrides,
  };
}

function createEvents(): EventRecord[] {
  return [
    {
      seq: 0,
      type: 'output',
      ts: '2026-03-19T12:00:00.000Z',
      payload: { data: 'hello\n' },
    },
    {
      seq: 1,
      type: 'resize',
      ts: '2026-03-19T12:00:01.500Z',
      payload: { cols: 100, rows: 30 },
    },
  ];
}

function createReplayState() {
  return {
    lastSeq: 1,
    cols: 80,
    rows: 24,
    cursorRow: 0,
    cursorCol: 0,
  };
}

function createMockBackend(
  overrides: Partial<VideoCapableRendererBackend> = {},
) {
  const boot = overrides.boot ?? vi.fn().mockResolvedValue(undefined);
  const replayTo =
    overrides.replayTo ?? vi.fn().mockResolvedValue(createReplayState());
  const replayWithTiming =
    overrides.replayWithTiming ??
    vi.fn().mockResolvedValue(createReplayState());
  const snapshot =
    overrides.snapshot ??
    vi.fn().mockResolvedValue({
      sessionId: 'session-01',
      capturedAtSeq: 1,
      cols: 80,
      rows: 24,
      cursorRow: 0,
      cursorCol: 0,
      isAltScreen: false,
      visibleLines: [],
    });
  const screenshot =
    overrides.screenshot ??
    vi.fn().mockResolvedValue({
      sessionId: 'session-01',
      capturedAtSeq: 1,
      profileName: 'reference-dark',
      cols: 80,
      rows: 24,
      artifactPath: '/tmp/screenshot.png',
      pngSizeBytes: 1,
    });
  const getVisibleText =
    overrides.getVisibleText ?? vi.fn().mockResolvedValue('');
  const finalizeVideo =
    overrides.finalizeVideo ?? vi.fn().mockResolvedValue(undefined);
  const dispose = overrides.dispose ?? vi.fn().mockResolvedValue(undefined);
  const backend: VideoCapableRendererBackend = {
    rendererBackend: overrides.rendererBackend ?? 'mock-video-backend',
    isBooted: overrides.isBooted ?? false,
    boot,
    replayTo,
    replayWithTiming,
    snapshot,
    screenshot,
    getVisibleText,
    finalizeVideo,
    dispose,
  };

  return {
    backend,
    boot,
    replayWithTiming,
    finalizeVideo,
    dispose,
  };
}

describe('generateWebmExport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveProfile.mockReturnValue({
      name: 'reference-dark',
      theme: 'dark',
      fontFamily: 'monospace',
      fontSize: 16,
      cursorStyle: 'block',
      backgroundColor: '#000000',
      foregroundColor: '#ffffff',
    });
    mocks.buildReplayInput.mockReturnValue({
      sessionId: 'session-01',
      initialCols: 80,
      initialRows: 24,
      events: createEvents(),
      targetSeq: 1,
    });
  });

  it('orchestrates replay generation through an injected video backend factory', async () => {
    const callOrder: string[] = [];
    const boot = vi.fn().mockImplementation(() => {
      callOrder.push('boot');
      return Promise.resolve();
    });
    const replayWithTiming = vi.fn().mockImplementation(() => {
      callOrder.push('replay');
      return Promise.resolve(createReplayState());
    });
    const finalizeVideo = vi.fn().mockImplementation(() => {
      callOrder.push('finalize');
      return Promise.resolve();
    });
    const dispose = vi.fn().mockImplementation(() => {
      callOrder.push('dispose');
      return Promise.resolve();
    });
    const mockBackend = createMockBackend({
      boot,
      replayWithTiming,
      finalizeVideo,
      dispose,
    });
    const backendFactory = vi.fn(
      (
        sessionId: string,
        profile: { fontSize: number; name: string },
        videoOptions: {
          outputDir: string;
          size: {
            width: number;
            height: number;
          };
        },
      ) => {
        void sessionId;
        void profile;
        void videoOptions;
        return mockBackend.backend;
      },
    );

    const result = await generateWebmExport(
      {
        sessionId: 'session-01',
        sessionDir: '/tmp/agent-terminal/sessions/session-01',
        manifest: createManifest(),
        events: createEvents(),
        outputPath: '/tmp/exports/recording-1-webm.webm',
      },
      { backendFactory },
    );

    expect(mocks.buildReplayInput).toHaveBeenCalledWith(
      'session-01',
      createManifest(),
      createEvents(),
      undefined,
    );
    expect(mocks.resolveProfile).toHaveBeenCalledWith('reference-dark');
    expect(backendFactory).toHaveBeenCalledTimes(1);
    const backendCall = backendFactory.mock.calls[0];
    expect(backendCall).toBeDefined();

    if (backendCall === undefined) {
      return;
    }

    const [backendSessionId, backendProfile, videoOptions] = backendCall;

    expect(backendSessionId).toBe('session-01');
    expect(backendProfile).toMatchObject({
      fontSize: 16,
      name: 'reference-dark',
    });
    expect(videoOptions.outputDir).toContain('agent-terminal-webm-');
    expect(videoOptions.size).toEqual({
      width: 864,
      height: 608,
    });
    expect(mockBackend.boot).toHaveBeenCalledTimes(1);
    expect(mockBackend.replayWithTiming).toHaveBeenCalledWith(
      {
        sessionId: 'session-01',
        initialCols: 80,
        initialRows: 24,
        events: createEvents(),
        targetSeq: 1,
      },
      {
        maxGapMs: 100,
        minFrameHoldMs: 50,
        finalFrameHoldMs: 1_000,
      },
    );
    expect(mockBackend.finalizeVideo).toHaveBeenCalledWith(
      '/tmp/exports/recording-1-webm.webm',
    );
    expect(mockBackend.dispose).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['boot', 'replay', 'finalize', 'dispose']);
    expect(result).toEqual({
      capturedAtSeq: 1,
      durationMs: 1_500,
      outputEventCount: 1,
      resizeEventCount: 1,
      cols: 80,
      rows: 24,
      profileName: 'reference-dark',
      timingMode: 'accelerated',
    });
  });

  it('rejects empty events', async () => {
    await expect(
      generateWebmExport({
        sessionId: 'session-01',
        sessionDir: '/tmp/agent-terminal/sessions/session-01',
        manifest: createManifest(),
        events: [],
        outputPath: '/tmp/exports/recording-1-webm.webm',
      }),
    ).rejects.toThrow('events must not be empty');
  });

  it('rejects non-absolute output paths', async () => {
    await expect(
      generateWebmExport({
        sessionId: 'session-01',
        sessionDir: '/tmp/agent-terminal/sessions/session-01',
        manifest: createManifest(),
        events: createEvents(),
        outputPath: 'relative/path.webm',
      }),
    ).rejects.toThrow('outputPath must be absolute');
  });

  it('disposes the backend when replay fails', async () => {
    const replayError = new Error('replay failed');
    const replayWithTiming = vi.fn().mockRejectedValue(replayError);
    const mockBackend = createMockBackend({ replayWithTiming });

    await expect(
      generateWebmExport(
        {
          sessionId: 'session-01',
          sessionDir: '/tmp/agent-terminal/sessions/session-01',
          manifest: createManifest(),
          events: createEvents(),
          outputPath: '/tmp/exports/recording-1-webm.webm',
        },
        { backendFactory: () => mockBackend.backend },
      ),
    ).rejects.toThrow(replayError);

    expect(mockBackend.finalizeVideo).not.toHaveBeenCalled();
    expect(mockBackend.dispose).toHaveBeenCalledTimes(1);
  });

  it('times out replay and still disposes the backend', async () => {
    const replayWithTiming = vi.fn(
      (): Promise<ReturnType<typeof createReplayState>> =>
        new Promise(() => undefined),
    );
    const mockBackend = createMockBackend({ replayWithTiming });

    await expect(
      generateWebmExport(
        {
          sessionId: 'session-01',
          sessionDir: '/tmp/agent-terminal/sessions/session-01',
          manifest: createManifest(),
          events: createEvents(),
          outputPath: '/tmp/exports/recording-1-webm.webm',
        },
        {
          backendFactory: () => mockBackend.backend,
          replayTimeoutMs: 1,
        },
      ),
    ).rejects.toThrow('WebM replay timed out after 5 minutes');

    expect(mockBackend.finalizeVideo).not.toHaveBeenCalled();
    expect(mockBackend.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes the backend when finalizeVideo throws', async () => {
    const finalizeError = new Error('finalize failed');
    const finalizeVideo = vi.fn().mockRejectedValue(finalizeError);
    const mockBackend = createMockBackend({ finalizeVideo });

    await expect(
      generateWebmExport(
        {
          sessionId: 'session-01',
          sessionDir: '/tmp/agent-terminal/sessions/session-01',
          manifest: createManifest(),
          events: createEvents(),
          outputPath: '/tmp/exports/recording-1-webm.webm',
        },
        { backendFactory: () => mockBackend.backend },
      ),
    ).rejects.toThrow(finalizeError);

    expect(mockBackend.finalizeVideo).toHaveBeenCalledWith(
      '/tmp/exports/recording-1-webm.webm',
    );
    expect(mockBackend.dispose).toHaveBeenCalledTimes(1);
  });
});
