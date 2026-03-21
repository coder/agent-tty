import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  EventRecord,
  SessionRecord,
} from '../../../src/protocol/schemas.js';

const mocks = vi.hoisted(() => ({
  buildReplayInput: vi.fn(),
  resolveProfile: vi.fn(),
  GhosttyWebBackend: vi.fn(),
}));

vi.mock('../../../src/host/replay.js', () => ({
  buildReplayInput: mocks.buildReplayInput,
}));

vi.mock('../../../src/renderer/profiles.js', () => ({
  resolveProfile: mocks.resolveProfile,
}));

vi.mock('../../../src/renderer/ghosttyWeb/backend.js', () => ({
  GhosttyWebBackend: mocks.GhosttyWebBackend,
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

describe('generateWebmExport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveProfile.mockReturnValue({ fontSize: 16 });
    mocks.buildReplayInput.mockReturnValue({
      sessionId: 'session-01',
      initialCols: 80,
      initialRows: 24,
      events: createEvents(),
      targetSeq: 1,
    });
  });

  it('orchestrates replay generation through GhosttyWebBackend', async () => {
    const mockBackend = {
      boot: vi.fn().mockResolvedValue(undefined),
      replayWithTiming: vi.fn().mockResolvedValue({
        lastSeq: 1,
        cols: 80,
        rows: 24,
        cursorRow: 0,
        cursorCol: 0,
      }),
      finalizeVideo: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    mocks.GhosttyWebBackend.mockImplementation(
      function MockGhosttyWebBackend() {
        return mockBackend;
      },
    );

    const result = await generateWebmExport({
      sessionId: 'session-01',
      sessionDir: '/tmp/agent-terminal/sessions/session-01',
      manifest: createManifest(),
      events: createEvents(),
      outputPath: '/tmp/exports/recording-1-webm.webm',
    });

    expect(mocks.buildReplayInput).toHaveBeenCalledWith(
      'session-01',
      createManifest(),
      createEvents(),
      undefined,
    );
    expect(mocks.resolveProfile).toHaveBeenCalledWith('reference-dark');
    expect(mocks.GhosttyWebBackend).toHaveBeenCalledTimes(1);
    const ghosttyBackendCall = mocks.GhosttyWebBackend.mock.calls[0] as [
      string,
      { fontSize: number },
      {
        outputDir: string;
        size: {
          width: number;
          height: number;
        };
      },
    ];
    const [backendSessionId, backendProfile, videoOptions] = ghosttyBackendCall;

    expect(backendSessionId).toBe('session-01');
    expect(backendProfile).toEqual({ fontSize: 16 });
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
      {},
    );
    expect(mockBackend.finalizeVideo).toHaveBeenCalledWith(
      '/tmp/exports/recording-1-webm.webm',
    );
    expect(mockBackend.dispose).toHaveBeenCalledTimes(1);

    const [bootOrder] = mockBackend.boot.mock.invocationCallOrder;
    const [replayOrder] = mockBackend.replayWithTiming.mock.invocationCallOrder;
    const [finalizeOrder] = mockBackend.finalizeVideo.mock.invocationCallOrder;
    const [disposeOrder] = mockBackend.dispose.mock.invocationCallOrder;

    expect(bootOrder).toBeDefined();
    expect(replayOrder).toBeDefined();
    expect(finalizeOrder).toBeDefined();
    expect(disposeOrder).toBeDefined();

    if (
      bootOrder === undefined ||
      replayOrder === undefined ||
      finalizeOrder === undefined ||
      disposeOrder === undefined
    ) {
      return;
    }

    expect(bootOrder).toBeLessThan(replayOrder);
    expect(replayOrder).toBeLessThan(finalizeOrder);
    expect(finalizeOrder).toBeLessThan(disposeOrder);
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
    const mockBackend = {
      boot: vi.fn().mockResolvedValue(undefined),
      replayWithTiming: vi.fn().mockRejectedValue(replayError),
      finalizeVideo: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    mocks.GhosttyWebBackend.mockImplementation(
      function MockGhosttyWebBackend() {
        return mockBackend;
      },
    );

    await expect(
      generateWebmExport({
        sessionId: 'session-01',
        sessionDir: '/tmp/agent-terminal/sessions/session-01',
        manifest: createManifest(),
        events: createEvents(),
        outputPath: '/tmp/exports/recording-1-webm.webm',
      }),
    ).rejects.toThrow(replayError);

    expect(mockBackend.finalizeVideo).not.toHaveBeenCalled();
    expect(mockBackend.dispose).toHaveBeenCalledTimes(1);
  });
});
