import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  VideoCapableRendererBackend,
  VideoRecordingOptions,
} from '../../../src/renderer/backend.js';
import type {
  EventRecord,
  SessionRecord,
} from '../../../src/protocol/schemas.js';
import type { RenderProfileConfig } from '../../../src/renderer/types.js';

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

import {
  generateWebmExport,
  WebmReplayTimeoutError,
} from '../../../src/export/webm.js';

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
  const recordedMissingGlyphs =
    overrides.recordedMissingGlyphs ?? vi.fn().mockResolvedValue({});
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
    recordedMissingGlyphs,
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
        rendererName: 'ghostty-web' | 'libghostty-vt',
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
        void rendererName;
        void sessionId;
        void profile;
        void videoOptions;
        return mockBackend.backend;
      },
    );

    const result = await generateWebmExport(
      {
        sessionId: 'session-01',
        sessionDir: '/tmp/agent-tty/sessions/session-01',
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

    const [
      backendRendererName,
      backendSessionId,
      backendProfile,
      videoOptions,
    ] = backendCall;

    expect(backendRendererName).toBe('ghostty-web');
    expect(backendSessionId).toBe('session-01');
    expect(backendProfile).toMatchObject({
      fontSize: 16,
      name: 'reference-dark',
    });
    expect(videoOptions.outputDir).toContain('agent-tty-webm-');
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
        mode: 'recorded',
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
      timingMode: 'recorded',
      rendererBackend: 'ghostty-web',
    });
  });

  it('reports the glyphs that the replay drew as boxes, checked before the video closes', async () => {
    const callOrder: string[] = [];
    const mockBackend = createMockBackend({
      replayWithTiming: vi.fn().mockImplementation(() => {
        callOrder.push('replay');
        return Promise.resolve(createReplayState());
      }),
      recordedMissingGlyphs: vi.fn().mockImplementation(() => {
        callOrder.push('glyphs');
        return Promise.resolve({
          missingGlyphs: [{ codePoint: 'U+0378' }],
          missingGlyphsTruncated: true,
        });
      }),
      finalizeVideo: vi.fn().mockImplementation(() => {
        callOrder.push('finalize');
        return Promise.resolve();
      }),
    });

    const result = await generateWebmExport(
      {
        sessionId: 'session-01',
        sessionDir: '/tmp/agent-tty/sessions/session-01',
        manifest: createManifest(),
        events: createEvents(),
        outputPath: '/tmp/exports/recording-1-webm.webm',
      },
      { backendFactory: () => mockBackend.backend },
    );

    expect(callOrder).toEqual(['replay', 'glyphs', 'finalize']);
    expect(result).toMatchObject({
      missingGlyphs: [{ codePoint: 'U+0378' }],
      missingGlyphsTruncated: true,
    });
  });

  it('falls back to ghostty-web when libghostty-vt is requested', async () => {
    const mockBackend = createMockBackend();
    const backendFactory = vi.fn(
      (
        rendererName: 'ghostty-web' | 'libghostty-vt',
        sessionId: string,
        profile: RenderProfileConfig,
        videoOptions: VideoRecordingOptions,
      ) => {
        void rendererName;
        void sessionId;
        void profile;
        void videoOptions;
        return mockBackend.backend;
      },
    );

    const result = await generateWebmExport(
      {
        sessionId: 'session-01',
        sessionDir: '/tmp/agent-tty/sessions/session-01',
        manifest: createManifest(),
        events: createEvents(),
        outputPath: '/tmp/exports/recording-1-webm.webm',
        rendererName: 'libghostty-vt',
      },
      { backendFactory },
    );

    const backendFactoryCall = backendFactory.mock.calls[0];
    expect(backendFactoryCall).toBeDefined();
    if (backendFactoryCall === undefined) {
      throw new Error('expected backendFactory to be called');
    }
    const [rendererName, sessionId, profile, videoOptions] = backendFactoryCall;
    expect(rendererName).toBe('ghostty-web');
    expect(sessionId).toBe('session-01');
    expect(profile).toMatchObject({ name: 'reference-dark' });
    expect(videoOptions.outputDir).toContain('agent-tty-webm-');
    expect(result.rendererBackend).toBe('ghostty-web');
  });

  it('passes accelerated timing options when timingMode is accelerated', async () => {
    const mockBackend = createMockBackend();

    const result = await generateWebmExport(
      {
        sessionId: 'session-01',
        sessionDir: '/tmp/agent-tty/sessions/session-01',
        manifest: createManifest(),
        events: createEvents(),
        outputPath: '/tmp/exports/recording-1-webm.webm',
        timingMode: 'accelerated',
      },
      { backendFactory: () => mockBackend.backend },
    );

    expect(mockBackend.replayWithTiming).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-01' }),
      {
        mode: 'accelerated',
        maxGapMs: 400,
        minFrameHoldMs: 100,
        finalFrameHoldMs: 1_000,
      },
    );
    expect(result.timingMode).toBe('accelerated');
  });

  it('passes max-speed timing options when timingMode is max-speed', async () => {
    const mockBackend = createMockBackend();

    const result = await generateWebmExport(
      {
        sessionId: 'session-01',
        sessionDir: '/tmp/agent-tty/sessions/session-01',
        manifest: createManifest(),
        events: createEvents(),
        outputPath: '/tmp/exports/recording-1-webm.webm',
        timingMode: 'max-speed',
      },
      { backendFactory: () => mockBackend.backend },
    );

    expect(mockBackend.replayWithTiming).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-01' }),
      { mode: 'max-speed', minFrameHoldMs: 16, finalFrameHoldMs: 500 },
    );
    expect(result.timingMode).toBe('max-speed');
  });

  it('defaults to recorded timing when timingMode is omitted', async () => {
    const mockBackend = createMockBackend();

    const result = await generateWebmExport(
      {
        sessionId: 'session-01',
        sessionDir: '/tmp/agent-tty/sessions/session-01',
        manifest: createManifest(),
        events: createEvents(),
        outputPath: '/tmp/exports/recording-1-webm.webm',
      },
      { backendFactory: () => mockBackend.backend },
    );

    expect(mockBackend.replayWithTiming).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-01' }),
      { mode: 'recorded', finalFrameHoldMs: 1_000 },
    );
    expect(result.timingMode).toBe('recorded');
  });

  it('exports an empty event log as a blank video at seq -1', async () => {
    const emptyInput = {
      sessionId: 'session-01',
      initialCols: 80,
      initialRows: 24,
      events: [],
      targetSeq: -1,
    };
    mocks.buildReplayInput.mockReturnValue(emptyInput);
    const mockBackend = createMockBackend();

    const result = await generateWebmExport(
      {
        sessionId: 'session-01',
        sessionDir: '/tmp/agent-tty/sessions/session-01',
        manifest: createManifest(),
        events: [],
        outputPath: '/tmp/exports/recording--1-webm.webm',
      },
      { backendFactory: () => mockBackend.backend },
    );

    expect(mockBackend.replayWithTiming).toHaveBeenCalledWith(
      emptyInput,
      expect.anything(),
    );
    expect(result).toMatchObject({
      capturedAtSeq: -1,
      durationMs: 0,
      outputEventCount: 0,
      resizeEventCount: 0,
    });
  });

  it('rejects non-absolute output paths', async () => {
    await expect(
      generateWebmExport({
        sessionId: 'session-01',
        sessionDir: '/tmp/agent-tty/sessions/session-01',
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
          sessionDir: '/tmp/agent-tty/sessions/session-01',
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
          sessionDir: '/tmp/agent-tty/sessions/session-01',
          manifest: createManifest(),
          events: createEvents(),
          outputPath: '/tmp/exports/recording-1-webm.webm',
        },
        {
          backendFactory: () => mockBackend.backend,
          replayTimeoutMs: 1,
        },
      ),
    ).rejects.toThrow(
      'WebM replay timed out after 1 ms (planned duration 2500 ms at recorded timing)',
    );

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
          sessionDir: '/tmp/agent-tty/sessions/session-01',
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

describe('generateWebmExport replay deadline', () => {
  const FIVE_MINUTES_MS = 5 * 60 * 1000;
  const BASE_TIME_MS = Date.parse('2026-03-19T12:00:00.000Z');

  // Two output events, `spanMs` apart: the recording's whole length.
  function useRecordingOfLength(spanMs: number): void {
    mocks.buildReplayInput.mockReturnValue({
      sessionId: 'session-01',
      initialCols: 80,
      initialRows: 24,
      events: [
        {
          seq: 0,
          type: 'output',
          ts: new Date(BASE_TIME_MS).toISOString(),
          payload: { data: 'start\n' },
        },
        {
          seq: 1,
          type: 'output',
          ts: new Date(BASE_TIME_MS + spanMs).toISOString(),
          payload: { data: 'end\n' },
        },
      ],
      targetSeq: 1,
    });
  }

  // Starts an export whose replay runs on fake timers. It takes `replayMs` of
  // fake time, or never ends when `replayMs` is null.
  async function startExport(
    timingMode: 'recorded' | 'accelerated' | 'max-speed',
    replayMs: number | null,
  ) {
    let markReplayStarted: () => void = () => undefined;
    const replayStarted = new Promise<void>((resolve) => {
      markReplayStarted = resolve;
    });
    const replayWithTiming = vi.fn(
      (): Promise<ReturnType<typeof createReplayState>> => {
        markReplayStarted();
        return new Promise((resolve) => {
          if (replayMs !== null) {
            setTimeout(() => {
              resolve(createReplayState());
            }, replayMs);
          }
        });
      },
    );
    const mockBackend = createMockBackend({ replayWithTiming });
    let settled = false;
    const outcome = generateWebmExport(
      {
        sessionId: 'session-01',
        sessionDir: '/tmp/agent-tty/sessions/session-01',
        manifest: createManifest(),
        events: [],
        outputPath: '/tmp/exports/recording-1-webm.webm',
        timingMode,
      },
      { backendFactory: () => mockBackend.backend },
    ).then(
      (result) => {
        settled = true;
        return { result, error: undefined };
      },
      (error: unknown) => {
        settled = true;
        return { result: undefined, error };
      },
    );
    await replayStarted;

    return { outcome, mockBackend, isSettled: () => settled };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives a recording of more than 5 minutes the time that its plan needs', async () => {
    useRecordingOfLength(6 * 60 * 1000);
    // The replay waits out the recorded gap, then holds the final frame.
    const { outcome, mockBackend } = await startExport(
      'recorded',
      6 * 60 * 1000 + 1_000,
    );

    await vi.advanceTimersByTimeAsync(6 * 60 * 1000 + 1_000);
    const { result, error } = await outcome;

    expect(error).toBeUndefined();
    expect(result?.durationMs).toBe(6 * 60 * 1000);
    expect(mockBackend.finalizeVideo).toHaveBeenCalledTimes(1);
  });

  it('keeps the deadline within the longest delay that a timer runs', async () => {
    useRecordingOfLength(30 * 24 * 60 * 60 * 1000);
    const { outcome } = await startExport('recorded', 60_000);

    await vi.advanceTimersByTimeAsync(60_000);
    const { error } = await outcome;

    expect(error).toBeUndefined();
  });

  it.each([
    // The deadline is the planned duration plus 5 minutes. The plan is the
    // recorded gap and the final frame hold, with the gap cut by the mode.
    { timingMode: 'recorded', plannedDurationMs: 6 * 60 * 1000 + 1_000 },
    { timingMode: 'accelerated', plannedDurationMs: 400 + 1_000 },
    { timingMode: 'max-speed', plannedDurationMs: 500 },
  ] as const)(
    'stops a hung $timingMode replay once its plan and 5 minutes have passed',
    async ({ timingMode, plannedDurationMs }) => {
      useRecordingOfLength(6 * 60 * 1000);
      const deadlineMs = plannedDurationMs + FIVE_MINUTES_MS;
      const { outcome, mockBackend, isSettled } = await startExport(
        timingMode,
        null,
      );

      await vi.advanceTimersByTimeAsync(deadlineMs - 1);
      expect(isSettled()).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const { error } = await outcome;

      expect(error).toBeInstanceOf(WebmReplayTimeoutError);
      expect(error).toMatchObject({
        timeoutMs: deadlineMs,
        plannedDurationMs,
        timingMode,
        message: `WebM replay timed out after ${String(deadlineMs)} ms (planned duration ${String(plannedDurationMs)} ms at ${timingMode} timing)`,
      });
      expect(mockBackend.finalizeVideo).not.toHaveBeenCalled();
      expect(mockBackend.dispose).toHaveBeenCalledTimes(1);
    },
  );
});
