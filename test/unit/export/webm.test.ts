import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ReplayProgress,
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
  WebmReplayStallError,
} from '../../../src/export/webm.js';
import { GhosttyWebBackend } from '../../../src/renderer/ghosttyWeb/index.js';

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
      expect.any(Function),
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
      expect.any(Function),
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
      expect.any(Function),
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
      expect.any(Function),
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
      expect.any(Function),
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

  it('stops a replay that makes no progress and still disposes the backend', async () => {
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
          stallWindowMs: 1,
        },
      ),
    ).rejects.toThrow(
      'WebM replay stalled: the renderer made no progress for 1 ms (last event seq -1, recorded timing)',
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

describe('generateWebmExport stall watchdog', () => {
  const WINDOW_MS = 5 * 60 * 1000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

  type ReplayScript = (
    onProgress: (progress: ReplayProgress) => void,
  ) => Promise<ReturnType<typeof createReplayState>>;

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  // Starts an export whose replay is `script`, on fake timers. The script
  // acts as the renderer: it reports progress and takes fake time.
  async function startExport(
    script: ReplayScript,
    timingMode: 'recorded' | 'accelerated' | 'max-speed' = 'recorded',
  ) {
    let markReplayStarted: () => void = () => undefined;
    const replayStarted = new Promise<void>((resolve) => {
      markReplayStarted = resolve;
    });
    const replayWithTiming = vi.fn(
      (
        _input: unknown,
        _timing: unknown,
        onProgress?: (progress: ReplayProgress) => void,
      ) => {
        markReplayStarted();
        return script(onProgress ?? (() => undefined));
      },
    );
    const mockBackend = createMockBackend({ replayWithTiming });
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
      (result) => ({ result, error: undefined }),
      (error: unknown) => ({ result: undefined, error }),
    );
    await replayStarted;

    return { outcome, mockBackend };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a replay going while it reports progress for longer than the window', async () => {
    const { outcome, mockBackend } = await startExport(async (onProgress) => {
      for (let seq = 0; seq < 5; seq += 1) {
        await sleep(WINDOW_MS - 60_000);
        onProgress({ seq, scheduledWaitMs: 0 });
      }
      return createReplayState();
    });

    await vi.advanceTimersByTimeAsync(5 * (WINDOW_MS - 60_000));
    const { error } = await outcome;

    expect(error).toBeUndefined();
    expect(mockBackend.finalizeVideo).toHaveBeenCalledTimes(1);
  });

  it('does not count a multi-day wait on the timing schedule as a stall', async () => {
    const { outcome, mockBackend } = await startExport(async (onProgress) => {
      onProgress({ seq: 0, scheduledWaitMs: 20 * DAY_MS });
      await sleep(20 * DAY_MS);
      onProgress({ seq: 1, scheduledWaitMs: 0 });
      return createReplayState();
    });

    await vi.advanceTimersByTimeAsync(20 * DAY_MS);
    const { error } = await outcome;

    expect(error).toBeUndefined();
    expect(mockBackend.finalizeVideo).toHaveBeenCalledTimes(1);
  });

  it('keeps going through several waits that together pass the longest timer', async () => {
    const { outcome, mockBackend } = await startExport(async (onProgress) => {
      for (let seq = 0; seq < 3; seq += 1) {
        onProgress({ seq, scheduledWaitMs: 10 * DAY_MS });
        await sleep(10 * DAY_MS);
      }
      return createReplayState();
    });

    await vi.advanceTimersByTimeAsync(30 * DAY_MS);
    const { error } = await outcome;

    expect(error).toBeUndefined();
    expect(mockBackend.finalizeVideo).toHaveBeenCalledTimes(1);
  });

  it('starts no timer that runs longer than a timer can, for a wait of 30 days', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const { outcome, mockBackend } = await startExport(async (onProgress) => {
      onProgress({ seq: 0, scheduledWaitMs: 30 * DAY_MS });
      await sleep(15 * DAY_MS);
      await sleep(15 * DAY_MS);
      onProgress({ seq: 1, scheduledWaitMs: 0 });
      return createReplayState();
    });

    await vi.advanceTimersByTimeAsync(30 * DAY_MS);
    const { error } = await outcome;

    expect(error).toBeUndefined();
    expect(mockBackend.finalizeVideo).toHaveBeenCalledTimes(1);
    const delays = setTimeoutSpy.mock.calls.map((call) => Number(call[1]));
    expect(delays.length).toBeGreaterThan(0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS);
  });

  it.each(['recorded', 'accelerated', 'max-speed'] as const)(
    'stops a hung %s replay once the window has passed since its last progress',
    async (timingMode) => {
      const { outcome, mockBackend } = await startExport(async (onProgress) => {
        await sleep(1_000);
        onProgress({ seq: 7, scheduledWaitMs: 0 });
        return new Promise(() => undefined);
      }, timingMode);

      await vi.advanceTimersByTimeAsync(1_000 + WINDOW_MS - 1);
      expect(mockBackend.dispose).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      const { error } = await outcome;

      expect(error).toBeInstanceOf(WebmReplayStallError);
      expect(error).toMatchObject({
        stallWindowMs: WINDOW_MS,
        lastSeq: 7,
        timingMode,
        message: `WebM replay stalled: the renderer made no progress for ${String(WINDOW_MS)} ms (last event seq 7, ${timingMode} timing)`,
      });
      expect(mockBackend.finalizeVideo).not.toHaveBeenCalled();
      expect(mockBackend.dispose).toHaveBeenCalledTimes(1);
    },
  );

  it('stops a replay that reports nothing, naming no event', async () => {
    const { outcome, mockBackend } = await startExport(
      () => new Promise(() => undefined),
    );

    await vi.advanceTimersByTimeAsync(WINDOW_MS - 1);
    expect(mockBackend.dispose).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const { error } = await outcome;

    expect(error).toBeInstanceOf(WebmReplayStallError);
    expect(error).toMatchObject({ stallWindowMs: WINDOW_MS, lastSeq: -1 });
  });

  it('starts the window after a scheduled wait, not before it', async () => {
    const { outcome, mockBackend } = await startExport((onProgress) => {
      onProgress({ seq: 3, scheduledWaitMs: 2 * DAY_MS });
      return new Promise(() => undefined);
    });

    await vi.advanceTimersByTimeAsync(2 * DAY_MS + WINDOW_MS - 1);
    expect(mockBackend.dispose).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const { error } = await outcome;

    expect(error).toBeInstanceOf(WebmReplayStallError);
    expect(error).toMatchObject({ stallWindowMs: WINDOW_MS, lastSeq: 3 });
  });

  it('leaves no timer behind when the replay succeeds', async () => {
    const { outcome } = await startExport((onProgress) => {
      onProgress({ seq: 0, scheduledWaitMs: DAY_MS });
      return Promise.resolve(createReplayState());
    });

    const { error } = await outcome;

    expect(error).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer behind when the replay fails', async () => {
    const replayError = new Error('replay failed');
    const { outcome } = await startExport((onProgress) => {
      onProgress({ seq: 0, scheduledWaitMs: DAY_MS });
      return Promise.reject(replayError);
    });

    const { error } = await outcome;

    expect(error).toBe(replayError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts no timer when a replay that already stalled reports again', async () => {
    let reportLate: (progress: ReplayProgress) => void = () => undefined;
    const { outcome } = await startExport((onProgress) => {
      reportLate = onProgress;
      return new Promise(() => undefined);
    });

    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    const { error } = await outcome;
    expect(error).toBeInstanceOf(WebmReplayStallError);

    reportLate({ seq: 9, scheduledWaitMs: DAY_MS });

    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { seq: 0.5, scheduledWaitMs: 0, message: 'seq must be an integer' },
    { seq: -2, scheduledWaitMs: 0, message: 'seq must be an integer' },
    { seq: 0, scheduledWaitMs: -1, message: 'scheduledWaitMs must be' },
    { seq: 0, scheduledWaitMs: Number.NaN, message: 'scheduledWaitMs must be' },
  ])(
    'rejects a progress report of seq $seq and wait $scheduledWaitMs',
    async ({ seq, scheduledWaitMs, message }) => {
      const { outcome } = await startExport((onProgress) => {
        onProgress({ seq, scheduledWaitMs });
        return Promise.resolve(createReplayState());
      });

      const { error } = await outcome;

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(message);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

// These tests run the real GhosttyWebBackend replay loop with its renderer
// bridge replaced by a stub that takes fake time. They check that the loop
// reports progress where the watchdog needs it.
describe('generateWebmExport stall watchdog with the ghostty-web replay loop', () => {
  const BASE_TIME_MS = Date.parse('2026-03-19T12:00:00.000Z');
  const DAY_MS = 24 * 60 * 60 * 1000;
  const WINDOW_MS = 5 * 60 * 1000;

  type ReplayEvent = {
    seq: number;
    type: 'output' | 'input_text';
    ts: string;
    payload: { data: string };
  };

  function event(
    seq: number,
    offsetMs: number,
    type: ReplayEvent['type'] = 'output',
  ): ReplayEvent {
    return {
      seq,
      type,
      ts: new Date(BASE_TIME_MS + offsetMs).toISOString(),
      payload: { data: `e${String(seq)}` },
    };
  }

  // Exports `events` with the real replay loop. Each bridge call takes
  // `bridgeCostMs` of fake time. Returns how long the replay took in fake
  // time, or the error that stopped it.
  async function exportWithRealReplayLoop(
    events: ReplayEvent[],
    timingMode: 'recorded' | 'accelerated' | 'max-speed',
    bridgeCostMs: number,
    runForMs: number,
  ): Promise<{ replayMs: number | undefined; error: unknown }> {
    mocks.buildReplayInput.mockReturnValue({
      sessionId: 'session-01',
      initialCols: 80,
      initialRows: 24,
      events,
      targetSeq: events.length - 1,
    });
    let markReplayStarted: () => void = () => undefined;
    const replayStarted = new Promise<void>((resolve) => {
      markReplayStarted = resolve;
    });
    let finalizedAtMs: number | undefined;
    let startedAtMs = 0;
    const outcome = generateWebmExport(
      {
        sessionId: 'session-01',
        sessionDir: '/tmp/agent-tty/sessions/session-01',
        manifest: createManifest(),
        events: [],
        outputPath: '/tmp/exports/recording-1-webm.webm',
        timingMode,
      },
      {
        backendFactory: (_rendererName, sessionId, profile, videoOptions) => {
          const backend = new GhosttyWebBackend(
            sessionId,
            profile,
            videoOptions,
          );
          Object.assign(backend as object, {
            boot: () => Promise.resolve(),
            isBooted: true,
            page: { isClosed: () => false },
            resizeBridge: () => {
              startedAtMs = Date.now();
              markReplayStarted();
              return Promise.resolve();
            },
            writeBatchBridge: () =>
              new Promise<void>((resolve) => {
                setTimeout(resolve, bridgeCostMs);
              }),
            notePaintedGraphemes: () => Promise.resolve(),
            checkPaintedGlyphs: () => Promise.resolve({}),
            readHarnessSnapshot: () =>
              Promise.resolve({
                cols: 80,
                rows: 24,
                cursorRow: 0,
                cursorCol: 0,
                isAltScreen: false,
                visibleLines: [],
              }),
            recordedMissingGlyphs: () => Promise.resolve({}),
            finalizeVideo: () => {
              finalizedAtMs = Date.now();
              return Promise.resolve();
            },
            dispose: () => Promise.resolve(),
          });
          return backend;
        },
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    await replayStarted;
    await vi.advanceTimersByTimeAsync(runForMs);
    const error = await outcome;

    return {
      replayMs:
        finalizedAtMs === undefined ? undefined : finalizedAtMs - startedAtMs,
      error,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.resolveProfile.mockReturnValue({
      name: 'reference-dark',
      theme: 'dark',
      fontFamily: 'monospace',
      fontSize: 16,
      cursorStyle: 'block',
      backgroundColor: '#000000',
      foregroundColor: '#ffffff',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    { label: '6 minutes', gapMs: 6 * 60 * 1000 },
    { label: '20 days', gapMs: 20 * DAY_MS },
  ])(
    'exports a recording with a gap of $label at recorded timing',
    async ({ gapMs }) => {
      const { replayMs, error } = await exportWithRealReplayLoop(
        [event(0, 0), event(1, gapMs)],
        'recorded',
        0,
        gapMs + 60_000,
      );

      expect(error).toBeUndefined();
      expect(replayMs).toBeGreaterThan(gapMs);
    },
  );

  it.each([
    { timingMode: 'accelerated', eventCount: 7_401, bridgeCostMs: 50 },
    { timingMode: 'max-speed', eventCount: 39_001, bridgeCostMs: 15 },
  ] as const)(
    'exports a dense $timingMode recording whose replay runs far past its plan',
    async ({ timingMode, eventCount, bridgeCostMs }) => {
      // An input event after each output event forces a flush, and each flush
      // holds the frame, so the replay takes minutes for a recording that
      // spans seconds.
      const events = Array.from({ length: eventCount }, (_, seq) =>
        event(seq, seq, seq % 2 === 0 ? 'output' : 'input_text'),
      );
      const { replayMs, error } = await exportWithRealReplayLoop(
        events,
        timingMode,
        bridgeCostMs,
        60 * 60 * 1000,
      );

      expect(error).toBeUndefined();
      expect(replayMs).toBeGreaterThan(WINDOW_MS);
    },
  );

  it('exports a max-speed recording whose output goes to the renderer in one flush', async () => {
    // One flush is 40 bridge calls of 21 s each, 14 minutes in all. Each
    // call is progress.
    const events = Array.from({ length: 39_001 }, (_, seq) => event(seq, seq));
    const { replayMs, error } = await exportWithRealReplayLoop(
      events,
      'max-speed',
      21_000,
      60 * 60 * 1000,
    );

    expect(error).toBeUndefined();
    expect(replayMs).toBeGreaterThan(WINDOW_MS);
  });

  it('stops a replay whose renderer call hangs and names the last event it reached', async () => {
    const events = [event(0, 0), event(1, 10), event(2, 20, 'input_text')];
    const { replayMs, error } = await exportWithRealReplayLoop(
      events,
      'recorded',
      // A bridge call that outlasts the window.
      2 * WINDOW_MS,
      60 * 60 * 1000,
    );

    expect(replayMs).toBeUndefined();
    expect(error).toBeInstanceOf(WebmReplayStallError);
    expect(error).toMatchObject({
      stallWindowMs: WINDOW_MS,
      timingMode: 'recorded',
    });
  });
});
