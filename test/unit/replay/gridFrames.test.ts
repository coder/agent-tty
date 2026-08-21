import { describe, expect, it } from 'vitest';

import type {
  RendererBackend,
  ScreenshotOptions,
  SnapshotOptions,
} from '../../../src/renderer/backend.js';
import type {
  ReplayInput,
  ReplayState,
  ScreenshotResult,
  SemanticSnapshot,
} from '../../../src/renderer/types.js';
import type {
  EventRecord,
  SessionRecord,
} from '../../../src/protocol/schemas.js';

import { renderGridFramesToSvg } from '../../../src/export/svg.js';
import { captureGridFrames } from '../../../src/replay/gridFrames.js';
import { resolveProfile } from '../../../src/renderer/profiles.js';

// The cursor-forward column test replays through the real libghostty-vt
// backend; skip it cleanly when the optional native package is unavailable.
let nativeAvailable = false;
try {
  await import('@coder/libghostty-vt-node');
  nativeAvailable = true;
} catch {
  nativeAvailable = false;
}
const maybeIt = nativeAvailable ? it : it.skip;

const SESSION_ID = 'session-01';
const PROFILE = resolveProfile('reference-dark');
const BASE_TS_MS = Date.parse('2026-03-19T12:00:02.000Z');

function isoAt(offsetMs: number): string {
  return new Date(BASE_TS_MS + offsetMs).toISOString();
}

function createSessionRecord(): SessionRecord {
  return {
    version: 1,
    sessionId: SESSION_ID,
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
  };
}

/**
 * Deterministic in-memory backend: the visible row-0 text is looked up from a
 * seq -> text table keyed by the last applied target seq.
 */
class FakeGridBackend implements RendererBackend {
  public readonly rendererBackend = 'fake-grid';
  public isBooted = false;
  public replayTargetSeqs: number[] = [];
  public snapshotCalls: Array<SnapshotOptions | undefined> = [];
  public eventsFed = 0;
  public disposed = false;

  private lastSeq = -1;

  public constructor(private readonly gridBySeq: Map<number, string>) {}

  public boot(): Promise<void> {
    this.isBooted = true;
    return Promise.resolve();
  }

  public replayTo(input: ReplayInput): Promise<ReplayState> {
    this.replayTargetSeqs.push(input.targetSeq);
    this.eventsFed += input.events.length;
    this.lastSeq = input.targetSeq;
    return Promise.resolve({
      lastSeq: input.targetSeq,
      cols: 4,
      rows: 2,
      cursorRow: 0,
      cursorCol: 0,
    });
  }

  public snapshot(options?: SnapshotOptions): Promise<SemanticSnapshot> {
    this.snapshotCalls.push(options);
    const text = this.gridBySeq.get(this.lastSeq);
    expect(text).toBeDefined();
    return Promise.resolve({
      sessionId: SESSION_ID,
      capturedAtSeq: this.lastSeq,
      cols: 4,
      rows: 2,
      cursorRow: 0,
      cursorCol: Math.min(text?.length ?? 0, 3),
      isAltScreen: false,
      visibleLines: [
        { row: 0, text: text ?? '' },
        { row: 1, text: '' },
      ],
      cells: [
        {
          lineNumber: 0,
          cells: (text ?? '').split('').map((char) => ({ char })),
        },
      ],
    });
  }

  public screenshot(
    _outputPath: string,
    _options?: ScreenshotOptions,
  ): Promise<ScreenshotResult> {
    throw new Error('screenshot must not be used by grid capture');
  }

  public getVisibleText(): Promise<string> {
    return Promise.resolve(this.gridBySeq.get(this.lastSeq) ?? '');
  }

  public dispose(): Promise<void> {
    this.disposed = true;
    return Promise.resolve();
  }
}

function createEvents(): EventRecord[] {
  return [
    { seq: 0, ts: isoAt(0), type: 'output', payload: { data: 'a' } },
    // Same instant as seq 0: coalesced into one frame boundary.
    { seq: 1, ts: isoAt(0), type: 'output', payload: { data: 'b' } },
    { seq: 2, ts: isoAt(500), type: 'output', payload: { data: 'c' } },
    // Non-visual event: never a frame boundary.
    { seq: 3, ts: isoAt(700), type: 'marker', payload: { label: 'mark' } },
    // Produces a grid identical to seq 2's: de-duplicated into held frame.
    { seq: 4, ts: isoAt(800), type: 'output', payload: { data: '' } },
  ];
}

function createGrids(): Map<number, string> {
  return new Map([
    [1, 'ab'],
    [2, 'abc'],
    [4, 'abc'],
  ]);
}

describe('captureGridFrames', () => {
  it('captures coalesced, de-duplicated timeline frames with recorded holds', async () => {
    const backend = new FakeGridBackend(createGrids());

    const capture = await captureGridFrames(
      {
        sessionId: SESSION_ID,
        manifest: createSessionRecord(),
        events: createEvents(),
        profile: PROFILE,
        mode: 'timeline',
      },
      { backendFactory: () => backend },
    );

    // Boundaries: seq 1 (coalesced 0+1), seq 2, seq 4 (marker skipped).
    expect(backend.replayTargetSeqs).toEqual([1, 2, 4]);
    // Event cursor: each of the 5 events is fed to the backend exactly once
    // across all incremental replays (no per-boundary full-array rescans).
    expect(backend.eventsFed).toBe(5);
    expect(backend.snapshotCalls).toEqual([
      { includeCells: true },
      { includeCells: true },
      { includeCells: true },
    ]);
    expect(backend.disposed).toBe(true);

    // Frame 'abc' at seq 4 deduplicates into the seq-2 frame, merging its
    // 300ms hold with the 1000ms final hold.
    expect(capture.frames).toHaveLength(2);
    expect(capture.frames[0]).toMatchObject({
      capturedAtSeq: 1,
      holdMs: 500,
    });
    expect(capture.frames[0]?.lines[0]?.map((cell) => cell.char)).toEqual([
      'a',
      'b',
    ]);
    expect(capture.frames[1]).toMatchObject({
      capturedAtSeq: 2,
      holdMs: 1_300,
    });
    expect(capture.frames[1]?.lines[0]?.map((cell) => cell.char)).toEqual([
      'a',
      'b',
      'c',
    ]);

    expect(capture).toMatchObject({
      capturedAtSeq: 4,
      cols: 4,
      rows: 2,
      rendererBackend: 'fake-grid',
      outputEventCount: 4,
      resizeEventCount: 0,
      timelineDurationMs: 1_800,
    });
  });

  it('captures only the final frame in final mode', async () => {
    const backend = new FakeGridBackend(createGrids());

    const capture = await captureGridFrames(
      {
        sessionId: SESSION_ID,
        manifest: createSessionRecord(),
        events: createEvents(),
        profile: PROFILE,
        mode: 'final',
      },
      { backendFactory: () => backend },
    );

    expect(backend.replayTargetSeqs).toEqual([4]);
    expect(capture.frames).toHaveLength(1);
    expect(capture.frames[0]).toMatchObject({
      capturedAtSeq: 4,
      holdMs: 1_000,
    });
    expect(capture.capturedAtSeq).toBe(4);
    expect(backend.disposed).toBe(true);
  });

  maybeIt(
    'renders cursor-forward gaps at their true columns through the native backend',
    async () => {
      // ESC[10C moves the cursor forward over 10 untouched columns; the 'X'
      // must land at col 10 (x = 10 * 8.4 = 84) with a single-cell textLength.
      const events: EventRecord[] = [
        {
          seq: 0,
          ts: isoAt(0),
          type: 'output',
          payload: { data: '\u001b[10CX' },
        },
      ];

      const capture = await captureGridFrames({
        sessionId: SESSION_ID,
        manifest: createSessionRecord(),
        events,
        profile: PROFILE,
        mode: 'final',
      });
      const svg = renderGridFramesToSvg({
        profile: PROFILE,
        frames: capture.frames,
        animate: false,
      });

      expect(capture.rendererBackend).toBe('libghostty-vt');
      expect(svg).toMatch(
        /<text x="84" y="14" textLength="8\.4"[^>]*>X<\/text>/u,
      );
    },
  );

  it('represents leading and trailing non-visual event-log gaps', async () => {
    // Timing model under test: the timeline spans the full event log (first
    // event ts to last event ts, any type) plus the 1s final viewing hold.
    // input_run at t=0 followed by 10s of silence must surface as a blank
    // initial frame held 10s; the trailing input at t=20s extends the final
    // frame's hold to the end of the recorded range.
    const events: EventRecord[] = [
      {
        seq: 0,
        ts: isoAt(0),
        type: 'input_run',
        payload: { command: 'slow-task', noWait: true },
      },
      { seq: 1, ts: isoAt(10_000), type: 'output', payload: { data: 'a' } },
      { seq: 2, ts: isoAt(11_000), type: 'output', payload: { data: 'b' } },
      { seq: 3, ts: isoAt(20_000), type: 'input_text', payload: { data: 'x' } },
    ];
    const backend = new FakeGridBackend(
      new Map([
        [0, ''],
        [1, 'a'],
        [2, 'ab'],
      ]),
    );

    const capture = await captureGridFrames(
      {
        sessionId: SESSION_ID,
        manifest: createSessionRecord(),
        events,
        profile: PROFILE,
        mode: 'timeline',
      },
      { backendFactory: () => backend },
    );

    // Pre-visual boundary at seq 0 (blank grid), visual boundaries at seqs
    // 1 and 2, then the trailing flush to targetSeq 3.
    expect(backend.replayTargetSeqs).toEqual([0, 1, 2, 3]);

    expect(capture.frames).toHaveLength(3);
    // Leading gap: blank frame held from t=0 until the first output at t=10s.
    expect(capture.frames[0]).toMatchObject({
      capturedAtSeq: 0,
      holdMs: 10_000,
    });
    expect(capture.frames[1]).toMatchObject({
      capturedAtSeq: 1,
      holdMs: 1_000,
    });
    // Trailing gap: 9s from the last output (t=11s) to the last event
    // (t=20s), plus the 1s final viewing hold.
    expect(capture.frames[2]).toMatchObject({
      capturedAtSeq: 2,
      holdMs: 10_000,
    });
    // 20s recorded range + 1s final viewing hold.
    expect(capture.timelineDurationMs).toBe(21_000);
  });

  maybeIt(
    'spans default-style wide glyphs across their full width through the native backend',
    async () => {
      const events: EventRecord[] = [
        {
          seq: 0,
          ts: isoAt(0),
          type: 'output',
          payload: { data: 'A漢B' },
        },
      ];

      const capture = await captureGridFrames({
        sessionId: SESSION_ID,
        manifest: createSessionRecord(),
        events,
        profile: PROFILE,
        mode: 'final',
      });
      const svg = renderGridFramesToSvg({
        profile: PROFILE,
        frames: capture.frames,
        animate: false,
      });

      // A(1) + 漢(2) + B(1) = one default-style run spanning 4 cells: 33.6.
      expect(svg).toMatch(
        /<text x="0" y="14" textLength="33\.6"[^>]*>A漢B<\/text>/u,
      );
    },
  );

  it('fails with a clear export error when the native backend cannot boot', async () => {
    const backend = new FakeGridBackend(createGrids());
    backend.boot = () =>
      Promise.reject(new Error('Cannot find module @coder/libghostty-vt-node'));

    await expect(
      captureGridFrames(
        {
          sessionId: SESSION_ID,
          manifest: createSessionRecord(),
          events: createEvents(),
          profile: PROFILE,
          mode: 'final',
        },
        { backendFactory: () => backend },
      ),
    ).rejects.toMatchObject({
      code: 'EXPORT_ERROR',
      message: expect.stringContaining('@coder/libghostty-vt-node') as string,
    });
    expect(backend.disposed).toBe(true);
  });
});
