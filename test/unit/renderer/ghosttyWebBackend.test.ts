import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ReplayTimingOptions } from '../../../src/renderer/backend.js';
import type { ReplayInput } from '../../../src/renderer/types.js';
import { BUNDLED_FONT_ASSETS } from '../../../src/renderer/bundledFont.js';
import { hashProfile, resolveProfile } from '../../../src/renderer/profiles.js';
import { GhosttyWebBackend } from '../../../src/renderer/ghosttyWeb/index.js';
import { Logger } from '../../../src/util/logger.js';
import { ResourceScope } from '../../../src/util/resourceScope.js';

const PROFILE = resolveProfile('reference-dark');

function createBackend(): GhosttyWebBackend {
  return new GhosttyWebBackend('renderer-unit-session', PROFILE);
}

function createPngBuffer(width: number, height: number): Buffer {
  const pngSignature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const ihdrChunk = Buffer.alloc(16);
  ihdrChunk.writeUInt32BE(13, 0);
  ihdrChunk.write('IHDR', 4, 'ascii');
  ihdrChunk.writeUInt32BE(width, 8);
  ihdrChunk.writeUInt32BE(height, 12);
  return Buffer.concat([pngSignature, ihdrChunk]);
}

function asciiCellGraphemes(cols: number, rows: number): string[][] {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => 'a'),
  );
}

function createHarnessSnapshotPayload(overrides: Record<string, unknown> = {}) {
  return {
    cols: 3,
    rows: 1,
    cursorRow: 0,
    cursorCol: 2,
    isAltScreen: false,
    visibleLines: [{ row: 0, text: 'hey' }],
    ...overrides,
  };
}

describe('GhosttyWebBackend unit guards', () => {
  it('splits large output batches before bridging them into the page', async () => {
    const backend = createBackend();
    const recordedBatchSizes: number[] = [];
    const recordedChunks: string[] = [];

    (
      backend as unknown as {
        writeBatchBridge: (page: object, dataChunks: string[]) => Promise<void>;
      }
    ).writeBatchBridge = vi.fn((_page: object, dataChunks: string[]) => {
      recordedBatchSizes.push(dataChunks.length);
      recordedChunks.push(...dataChunks);
      return Promise.resolve();
    });

    const chunks = Array.from(
      { length: 2_501 },
      (_, index) => `chunk-${String(index)}`,
    );

    await (
      backend as unknown as {
        flushOutputBatch: (page: object, dataChunks: string[]) => Promise<void>;
      }
    ).flushOutputBatch({}, chunks);

    expect(recordedBatchSizes).toEqual([1000, 1000, 501]);
    expect(recordedChunks).toEqual(chunks);
  });

  it('notes painted graphemes after each bridge batch of a split flush', async () => {
    const backend = createBackend();
    const calls: string[] = [];
    (
      backend as unknown as {
        writeBatchBridge: (page: object, dataChunks: string[]) => Promise<void>;
      }
    ).writeBatchBridge = vi.fn((_page: object, dataChunks: string[]) => {
      calls.push(`write ${String(dataChunks.length)}`);
      return Promise.resolve();
    });

    const chunks = Array.from(
      { length: 2_501 },
      (_, index) => `chunk-${String(index)}`,
    );
    await (
      backend as unknown as {
        flushOutputBatch: (
          page: object,
          dataChunks: string[],
          afterEachBatch?: () => Promise<void>,
        ) => Promise<void>;
      }
    ).flushOutputBatch({}, chunks, () => {
      calls.push('note');
      return Promise.resolve();
    });

    expect(calls).toEqual([
      'write 1000',
      'note',
      'write 1000',
      'note',
      'write 501',
      'note',
    ]);
  });

  it('notes painted graphemes after each output flush of a timed replay', async () => {
    const backend = createBackend();
    const calls: string[] = [];
    Object.assign(backend as object, {
      isBooted: true,
      page: { isClosed: () => false },
      resizeBridge: () => Promise.resolve(),
      writeBatchBridge: (_page: object, dataChunks: string[]) => {
        calls.push(`write ${dataChunks.join(',')}`);
        return Promise.resolve();
      },
      notePaintedGraphemes: () => {
        calls.push('note');
        return Promise.resolve();
      },
      checkPaintedGlyphs: () => Promise.resolve({}),
      readHarnessSnapshot: () =>
        Promise.resolve(
          createHarnessSnapshotPayload({
            cols: 80,
            rows: 24,
            cursorRow: 0,
            cursorCol: 0,
          }),
        ),
    });

    await backend.replayWithTiming(
      {
        sessionId: 'renderer-unit-session',
        initialCols: 80,
        initialRows: 24,
        targetSeq: 2,
        events: [
          {
            seq: 0,
            ts: '2026-03-19T12:00:00.000Z',
            type: 'output',
            payload: { data: 'first' },
          },
          {
            seq: 1,
            ts: '2026-03-19T12:00:00.010Z',
            type: 'input_text',
            payload: { data: 'x' },
          },
          {
            seq: 2,
            ts: '2026-03-19T12:00:00.020Z',
            type: 'output',
            payload: { data: 'second' },
          },
        ],
      },
      { mode: 'max-speed', minFrameHoldMs: 0, finalFrameHoldMs: 0 },
    );

    expect(calls).toEqual(['write first', 'note', 'write second', 'note']);
  });

  it('retries the painted-grapheme note after the backend reboots', async () => {
    const backend = createBackend();
    const graphemes = vi.fn(() => Promise.resolve({ missingGlyphs: [] }));
    const failingPage = {
      isClosed: () => false,
      evaluate: vi.fn(() => Promise.reject(new Error('page crashed'))),
    };
    Object.assign(backend as object, {
      glyphCheckMemo: { graphemes },
      isBooted: true,
      page: failingPage,
    });
    const notePaintedGraphemes = (
      backend as unknown as {
        notePaintedGraphemes: (page: object) => Promise<void>;
      }
    ).notePaintedGraphemes.bind(backend);

    await notePaintedGraphemes(failingPage);
    await expect(backend.recordedMissingGlyphs()).resolves.toEqual({});

    await backend.dispose();
    const healthyPage = {
      isClosed: () => false,
      evaluate: vi.fn(() => Promise.resolve({ seen: [], complete: true })),
    };
    Object.assign(backend as object, {
      glyphCheckMemo: { graphemes },
      isBooted: true,
      page: healthyPage,
    });

    await notePaintedGraphemes(healthyPage);
    await expect(backend.recordedMissingGlyphs()).resolves.toEqual({
      missingGlyphs: [],
    });
    expect(graphemes).toHaveBeenCalledTimes(1);
  });

  it('runs the recorded glyph check inside the final frame hold', async () => {
    vi.useFakeTimers();
    const backend = createBackend();
    const graphemes = vi.fn(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({ missingGlyphs: [{ codePoint: 'U+0378' }] });
          }, 300);
        }),
    );
    const page = {
      isClosed: () => false,
      evaluate: vi.fn(() =>
        Promise.resolve({ seen: ['\u0378'], complete: true }),
      ),
    };
    Object.assign(backend as object, {
      glyphCheckMemo: { graphemes },
      isBooted: true,
      page,
      resizeBridge: () => Promise.resolve(),
      flushOutputBatch: () => Promise.resolve(),
      readHarnessSnapshot: () =>
        Promise.resolve(
          createHarnessSnapshotPayload({
            cols: 80,
            rows: 24,
            cursorRow: 0,
            cursorCol: 0,
          }),
        ),
    });

    try {
      let settledAt: number | undefined;
      const replay = backend
        .replayWithTiming(
          {
            sessionId: 'renderer-unit-session',
            initialCols: 80,
            initialRows: 24,
            targetSeq: 0,
            events: [
              {
                seq: 0,
                ts: '2026-03-19T12:00:00.000Z',
                type: 'output',
                payload: { data: '\u0378' },
              },
            ],
          },
          { mode: 'recorded', finalFrameHoldMs: 1_000 },
        )
        .then(() => {
          settledAt = Date.now();
        });
      const startedAt = Date.now();
      await vi.advanceTimersByTimeAsync(2_000);
      await replay;

      expect(graphemes).toHaveBeenCalledTimes(1);
      expect(graphemes).toHaveBeenCalledWith(
        page,
        new Set(['\u0378']),
        true,
        1_000,
      );
      expect((settledAt ?? Infinity) - startedAt).toBeLessThanOrEqual(1_100);
      await expect(backend.recordedMissingGlyphs()).resolves.toEqual({
        missingGlyphs: [{ codePoint: 'U+0378' }],
      });
      expect(graphemes).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes and skips run_complete events during replay', async () => {
    const backend = createBackend();
    const flushedChunks: string[][] = [];
    const resizeBridge = vi.fn(() => Promise.resolve());
    const page = { isClosed: () => false };

    Object.assign(backend as object, {
      isBooted: true,
      page,
      resizeBridge,
      flushOutputBatch: (_page: object, dataChunks: string[]) => {
        flushedChunks.push([...dataChunks]);
        return Promise.resolve();
      },
      readHarnessSnapshot: () =>
        Promise.resolve(
          createHarnessSnapshotPayload({
            cols: 80,
            rows: 24,
            cursorRow: 0,
            cursorCol: 0,
            visibleLines: [{ row: 0, text: 'after' }],
          }),
        ),
    });

    const input: ReplayInput = {
      sessionId: 'renderer-unit-session',
      initialCols: 80,
      initialRows: 24,
      targetSeq: 2,
      events: [
        {
          seq: 0,
          ts: '2026-03-19T12:00:00.000Z',
          type: 'output',
          payload: { data: 'before' },
        },
        {
          seq: 1,
          ts: '2026-03-19T12:00:01.000Z',
          type: 'run_complete',
          payload: { marker: '__AT_MARKER_done__', inputRunSeq: 0 },
        },
        {
          seq: 2,
          ts: '2026-03-19T12:00:02.000Z',
          type: 'output',
          payload: { data: 'after' },
        },
      ],
    };

    await expect(backend.replayTo(input)).resolves.toMatchObject({
      lastSeq: 2,
      cols: 80,
      rows: 24,
    });
    expect(resizeBridge).toHaveBeenCalledWith(page, 80, 24);
    expect(flushedChunks).toEqual([['before'], ['after']]);
  });

  it('replays an empty event log to the initial size at seq -1', async () => {
    const backend = createBackend();
    const resizeBridge = vi.fn(() => Promise.resolve());
    const page = { isClosed: () => false };
    const harnessSnapshot = createHarnessSnapshotPayload({
      cols: 40,
      rows: 12,
      cursorCol: 0,
      visibleLines: [],
    });

    Object.assign(backend as object, {
      isBooted: true,
      page,
      resizeBridge,
      readHarnessSnapshot: () => Promise.resolve(harnessSnapshot),
    });

    await expect(backend.snapshot()).rejects.toThrow(
      'snapshot() requires replayTo() first',
    );
    await expect(
      backend.replayTo({
        sessionId: 'renderer-unit-session',
        initialCols: 40,
        initialRows: 12,
        targetSeq: -1,
        events: [],
      }),
    ).resolves.toMatchObject({ lastSeq: -1, cols: 40, rows: 12 });
    expect(resizeBridge).toHaveBeenCalledWith(page, 40, 12);
    await expect(backend.snapshot()).resolves.toMatchObject({
      capturedAtSeq: -1,
      cols: 40,
      rows: 12,
    });
  });

  it('rejects oversized bridge batches before page evaluation', async () => {
    const backend = createBackend();
    const evaluate = vi.fn();

    await expect(
      (
        backend as unknown as {
          writeBatchBridge: (
            page: { evaluate: typeof evaluate },
            dataChunks: string[],
          ) => Promise<void>;
        }
      ).writeBatchBridge(
        { evaluate },
        Array.from({ length: 1001 }, () => 'x'),
      ),
    ).rejects.toThrow(
      'writeBatchBridge batch size must not exceed MAX_REPLAY_BATCH_SIZE',
    );
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('includes structured cell data only when snapshot includeCells is requested', async () => {
    const backend = createBackend();
    const evaluate = vi.fn().mockResolvedValue(
      createHarnessSnapshotPayload({
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
      }),
    );

    Object.assign(backend as object, {
      isBooted: true,
      lastAppliedSeq: 42,
      initialReplayCols: 80,
      page: {
        evaluate,
        isClosed: () => false,
      },
    });

    await expect(backend.snapshot({ includeCells: true })).resolves.toEqual({
      sessionId: 'renderer-unit-session',
      capturedAtSeq: 42,
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
    });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0]?.[1]).toEqual({ includeCells: true });
  });

  it('omits structured cell data from default snapshots', async () => {
    const backend = createBackend();
    const evaluate = vi.fn().mockResolvedValue(createHarnessSnapshotPayload());

    Object.assign(backend as object, {
      isBooted: true,
      lastAppliedSeq: 7,
      initialReplayCols: 80,
      page: {
        evaluate,
        isClosed: () => false,
      },
    });

    const snapshot = await backend.snapshot();
    expect(snapshot.cells).toBeUndefined();
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0]?.[1]).toBeUndefined();
  });

  it('rejects structured snapshots whose cell lines do not map 1:1 to visible lines', async () => {
    const backend = createBackend();
    const evaluate = vi
      .fn()
      .mockResolvedValue(createHarnessSnapshotPayload({ cells: [] }));

    Object.assign(backend as object, {
      isBooted: true,
      lastAppliedSeq: 8,
      initialReplayCols: 80,
      page: {
        evaluate,
        isClosed: () => false,
      },
    });

    await expect(backend.snapshot({ includeCells: true })).rejects.toThrow(
      'snapshot cell line count must match visible line count',
    );
  });

  it('rejects structured snapshots whose cell widths exceed terminal columns', async () => {
    const backend = createBackend();
    const evaluate = vi.fn().mockResolvedValue(
      createHarnessSnapshotPayload({
        cells: [
          {
            lineNumber: 0,
            cells: [{ char: 'h' }, { char: 'e' }, { char: 'y' }, { char: '!' }],
          },
        ],
      }),
    );

    Object.assign(backend as object, {
      isBooted: true,
      lastAppliedSeq: 9,
      initialReplayCols: 80,
      page: {
        evaluate,
        isClosed: () => false,
      },
    });

    await expect(backend.snapshot({ includeCells: true })).rejects.toThrow(
      'snapshot cell line 0 cell count must not exceed the terminal width',
    );
  });

  // The only unit test that boots a real Chromium. On CI runners the cold
  // boot took up to 3.2 s and once passed the default 5 s timeout.
  it('serves all bundled font assets over the backend HTTP server', async () => {
    const backend = createBackend();

    try {
      await backend.boot();

      const serverOrigin = (
        backend as unknown as { serverOrigin: string | null }
      ).serverOrigin;
      expect(serverOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      if (serverOrigin === null) {
        throw new Error('expected ghostty-web backend server origin');
      }

      for (const bundledFontAsset of BUNDLED_FONT_ASSETS) {
        const response = await fetch(
          new URL(bundledFontAsset.route, serverOrigin).toString(),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain(
          bundledFontAsset.contentType,
        );

        const fontBody = Buffer.from(await response.arrayBuffer());
        expect(fontBody.byteLength).toBeGreaterThan(0);
        expect(fontBody.equals(bundledFontAsset.buffer)).toBe(true);
      }
    } finally {
      await backend.dispose();
    }
  }, 30_000);

  it('times out screenshot paint waits after 5 seconds', async () => {
    vi.useFakeTimers();
    const backend = createBackend();
    const evaluate = vi.fn(() => new Promise<void>(() => {}));

    try {
      const waitForPaintPromise = (
        backend as unknown as {
          waitForScreenshotPaint: (page: {
            evaluate: typeof evaluate;
          }) => Promise<void>;
        }
      ).waitForScreenshotPaint({ evaluate });
      const rejectionExpectation = expect(waitForPaintPromise).rejects.toThrow(
        'Screenshot paint wait timed out after 5s',
      );

      await vi.advanceTimersByTimeAsync(5_000);
      await rejectionExpectation;
      expect(evaluate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns screenshot metadata including png dimensions and hashes', async () => {
    const backend = createBackend();
    // oxfmt-ignore
    const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), 'ghostty-web-backend-')));
    const outputPath = join(temporaryDirectory, 'screenshot.png');
    const pngBuffer = createPngBuffer(800, 600);
    const expectedSha256 = createHash('sha256').update(pngBuffer).digest('hex');

    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(asciiCellGraphemes(80, 24));
    const screenshot = vi.fn(
      (options: { animations: 'disabled'; caret: 'hide'; type: 'png' }) => {
        expect(options).toEqual({
          animations: 'disabled',
          caret: 'hide',
          type: 'png',
        });
        return Promise.resolve(pngBuffer);
      },
    );
    const locator = vi.fn((selector: string) => {
      expect(selector).toBe('#terminal');
      return { screenshot };
    });

    Object.assign(backend as object, {
      isBooted: true,
      currentCols: 80,
      currentRows: 24,
      lastAppliedSeq: 42,
      initialReplayCols: 80,
      page: {
        evaluate,
        isClosed: () => false,
        locator,
      },
    });

    try {
      await expect(backend.screenshot(outputPath)).resolves.toEqual({
        sessionId: 'renderer-unit-session',
        capturedAtSeq: 42,
        profileName: 'reference-dark',
        cols: 80,
        rows: 24,
        artifactPath: outputPath,
        pngSizeBytes: pngBuffer.byteLength,
        cursorVisible: false,
        rendererBackend: 'ghostty-web',
        pixelWidth: 800,
        pixelHeight: 600,
        sha256: expectedSha256,
        renderProfileHash: hashProfile(PROFILE),
        missingGlyphs: [],
      });
      expect(evaluate).toHaveBeenCalledTimes(3);
      expect(evaluate.mock.calls[0]?.[1]).toBe(false);
      expect(locator).toHaveBeenCalledWith('#terminal');
      expect(screenshot).toHaveBeenCalledTimes(1);
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it('omits missingGlyphs when the profile font stack does not start with a bundled font', async () => {
    const backend = new GhosttyWebBackend('renderer-unit-session', {
      ...PROFILE,
      fontFamily: 'monospace',
    });
    // oxfmt-ignore
    const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), 'ghostty-web-backend-host-font-')));
    const outputPath = join(temporaryDirectory, 'screenshot.png');
    const evaluate = vi.fn().mockResolvedValue(undefined);
    Object.assign(backend as object, {
      isBooted: true,
      currentCols: 80,
      currentRows: 24,
      initialReplayCols: 80,
      lastAppliedSeq: 3,
      page: {
        evaluate,
        isClosed: () => false,
        locator: () => ({
          screenshot: () => Promise.resolve(createPngBuffer(80, 60)),
        }),
      },
    });

    try {
      const result = await backend.screenshot(outputPath);

      expect(result).not.toHaveProperty('missingGlyphs');
      expect(evaluate).toHaveBeenCalledTimes(2);
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it('still returns the screenshot, without missingGlyphs, when the glyph check fails', async () => {
    const logger = new Logger('debug');
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const backend = new GhosttyWebBackend(
      'renderer-unit-session',
      PROFILE,
      undefined,
      logger,
    );
    // oxfmt-ignore
    const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), 'ghostty-web-backend-glyph-fail-')));
    const outputPath = join(temporaryDirectory, 'screenshot.png');
    const pngBuffer = createPngBuffer(80, 60);
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('grapheme read failed'));
    Object.assign(backend as object, {
      isBooted: true,
      currentCols: 80,
      currentRows: 24,
      initialReplayCols: 80,
      lastAppliedSeq: 3,
      page: {
        evaluate,
        isClosed: () => false,
        locator: () => ({ screenshot: () => Promise.resolve(pngBuffer) }),
      },
    });

    try {
      const result = await backend.screenshot(outputPath);

      expect(result.sha256).toBe(
        createHash('sha256').update(pngBuffer).digest('hex'),
      );
      expect(result).not.toHaveProperty('missingGlyphs');
      expect(evaluate).toHaveBeenCalledTimes(3);
      expect(debugSpy).toHaveBeenCalledWith(
        'Missing-glyph check failed; the screenshot result omits missingGlyphs',
        'grapheme read failed',
      );
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it('omits the record export glyph fields, and does not fail, when reading the painted glyphs fails', async () => {
    const logger = new Logger('debug');
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const backend = new GhosttyWebBackend(
      'renderer-unit-session',
      PROFILE,
      undefined,
      logger,
    );
    Object.assign(backend as object, {
      isBooted: true,
      page: {
        evaluate: vi.fn().mockRejectedValue(new Error('painted read failed')),
        isClosed: () => false,
      },
    });

    await expect(backend.recordedMissingGlyphs()).resolves.toEqual({});
    expect(debugSpy).toHaveBeenCalledWith(
      'Missing-glyph check failed; the record export result omits missingGlyphs',
      'painted read failed',
    );
  });

  it('uses initial caret capture when showCursor is enabled', async () => {
    const backend = createBackend();
    // oxfmt-ignore
    const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), 'ghostty-web-backend-cursor-')));
    const outputPath = join(temporaryDirectory, 'screenshot.png');
    const pngBuffer = createPngBuffer(640, 480);
    const expectedSha256 = createHash('sha256').update(pngBuffer).digest('hex');

    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(asciiCellGraphemes(100, 30));
    const screenshot = vi.fn(
      (options: { animations: 'disabled'; caret: 'initial'; type: 'png' }) => {
        expect(options).toEqual({
          animations: 'disabled',
          caret: 'initial',
          type: 'png',
        });
        return Promise.resolve(pngBuffer);
      },
    );
    const locator = vi.fn((selector: string) => {
      expect(selector).toBe('#terminal');
      return { screenshot };
    });

    Object.assign(backend as object, {
      isBooted: true,
      currentCols: 100,
      currentRows: 30,
      lastAppliedSeq: 7,
      initialReplayCols: 80,
      page: {
        evaluate,
        isClosed: () => false,
        locator,
      },
    });

    try {
      await expect(
        backend.screenshot(outputPath, { showCursor: true }),
      ).resolves.toEqual({
        sessionId: 'renderer-unit-session',
        capturedAtSeq: 7,
        profileName: 'reference-dark',
        cols: 100,
        rows: 30,
        artifactPath: outputPath,
        pngSizeBytes: pngBuffer.byteLength,
        cursorVisible: true,
        rendererBackend: 'ghostty-web',
        pixelWidth: 640,
        pixelHeight: 480,
        sha256: expectedSha256,
        renderProfileHash: hashProfile(PROFILE),
        missingGlyphs: [],
      });
      expect(evaluate).toHaveBeenCalledTimes(3);
      expect(evaluate.mock.calls[0]?.[1]).toBe(true);
      expect(locator).toHaveBeenCalledWith('#terminal');
      expect(screenshot).toHaveBeenCalledTimes(1);
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it('does not create the output folder again when it goes while the video is finalized', async () => {
    const backend = createBackend();
    // oxfmt-ignore
    const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), 'ghostty-web-backend-video-')));
    const recordedVideo = join(temporaryDirectory, 'recorded.webm');
    await writeFile(recordedVideo, 'webm');
    const outputDirectory = join(temporaryDirectory, 'session-01', 'artifacts');
    await mkdir(outputDirectory, { recursive: true });
    const video = {
      path: () => Promise.resolve(recordedVideo),
      saveAs: async (path: string) => {
        await mkdir(dirname(path), { recursive: true });
        await copyFile(recordedVideo, path);
      },
    };

    Object.assign(backend as object, {
      isBooted: true,
      videoOptions: {},
      browserContext: { close: () => Promise.resolve() },
      page: {
        isClosed: () => false,
        video: () => video,
        close: () =>
          rm(join(temporaryDirectory, 'session-01'), {
            recursive: true,
            force: true,
          }),
      },
    });

    try {
      await expect(
        backend.finalizeVideo(join(outputDirectory, 'recording-1-webm.webm')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(existsSync(join(temporaryDirectory, 'session-01'))).toBe(false);
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it('logs each release failure via logger.warn in LIFO order with the original Error attached, and resolves dispose() successfully', async () => {
    const logger = new Logger('debug');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const backend = new GhosttyWebBackend(
      'renderer-unit-session',
      PROFILE,
      undefined,
      logger,
    );
    const scope = new ResourceScope();
    const browserError = new Error('browser close failed');
    const serverError = new Error('server close failed');

    scope.add('server', () => {
      throw serverError;
    });
    scope.add('browser', () => {
      throw browserError;
    });

    Object.assign(backend as object, { resourceScope: scope });

    await expect(backend.dispose()).resolves.toBeUndefined();

    // DEREM-16: LIFO release means 'browser' fails first, 'server' second.
    // DEREM-2: failure.error is passed as the second logger.warn arg so
    //          formatLogDetail's `instanceof Error` branch keeps the
    //          original Error instance instead of stringifying it to '{}'.
    const warnCalls = warnSpy.mock.calls.map((args) => ({
      message: args[0],
      detail: args[1],
    }));
    expect(warnCalls).toEqual([
      {
        message: 'ghostty-web renderer cleanup failure: browser',
        detail: browserError,
      },
      {
        message: 'ghostty-web renderer cleanup failure: server',
        detail: serverError,
      },
    ]);
  });

  it('waits for an in-flight boot to settle before disposing (DEREM-24, disposeAfterBoot bootPromise wait)', async () => {
    const backend = new GhosttyWebBackend('renderer-unit-session', PROFILE);
    const events: string[] = [];

    let resolveBootGate!: () => void;
    const bootGate = new Promise<void>((resolve) => {
      resolveBootGate = resolve;
    });

    const scope = new ResourceScope();
    scope.add('resource', () => {
      events.push('released');
    });

    Object.assign(backend as object, {
      bootPromise: bootGate.then(() => {
        events.push('boot-settled');
      }),
      resourceScope: scope,
    });

    const disposePromise = backend.dispose();

    // Yield several microtasks so disposeAfterBoot has every chance to
    // observe a still-pending bootPromise. With the DEREM-5 fix in place,
    // the release closure must NOT have run yet because dispose is parked
    // on bootPromise.
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    expect(events).toEqual([]);

    resolveBootGate();
    await disposePromise;

    expect(events).toEqual(['boot-settled', 'released']);
  });

  it('still resolves dispose() when an in-flight boot rejects (DEREM-26, disposeAfterBoot swallows boot failure)', async () => {
    const backend = new GhosttyWebBackend('renderer-unit-session', PROFILE);
    const events: string[] = [];

    let rejectBootGate!: (reason: Error) => void;
    const bootGate = new Promise<void>((_resolve, reject) => {
      rejectBootGate = reject;
    });

    const scope = new ResourceScope();
    scope.add('resource', () => {
      events.push('released');
    });

    Object.assign(backend as object, {
      bootPromise: bootGate.catch((error: unknown) => {
        events.push('boot-rejected');
        throw error;
      }),
      resourceScope: scope,
    });

    const disposePromise = backend.dispose();

    // Yield several microtasks so disposeAfterBoot is parked on the
    // pending bootPromise. Once we reject it, the try/catch must swallow
    // the boot rejection and disposeInternal must run cleanly so the
    // ADR 0003 contract (dispose resolves successfully) holds.
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    expect(events).toEqual([]);

    rejectBootGate(new Error('boot failed'));

    await expect(disposePromise).resolves.toBeUndefined();
    expect(events).toEqual(['boot-rejected', 'released']);
  });

  it('still resolves dispose() when logger.warn itself throws (DEREM-19, EPIPE during shutdown)', async () => {
    const logger = new Logger('debug');
    vi.spyOn(logger, 'warn').mockImplementation(() => {
      // Simulate stderr broken pipe during process shutdown.
      throw new Error('write EPIPE');
    });

    const backend = new GhosttyWebBackend(
      'renderer-unit-session',
      PROFILE,
      undefined,
      logger,
    );
    const scope = new ResourceScope();
    scope.add('browser', () => {
      throw new Error('browser close failed');
    });
    Object.assign(backend as object, { resourceScope: scope });

    // ADR 0003 contract: dispose() resolves successfully even when
    // cleanup logging itself fails.
    await expect(backend.dispose()).resolves.toBeUndefined();
  });

  it('does not log the same scope close failures twice when closeResourceScopeAndLog is called twice on the same scope (DEREM-20, loggedScopes dedup)', async () => {
    const logger = new Logger('debug');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const backend = new GhosttyWebBackend(
      'renderer-unit-session',
      PROFILE,
      undefined,
      logger,
    );
    const scope = new ResourceScope();
    const browserError = new Error('browser close failed');
    scope.add('browser', () => {
      throw browserError;
    });

    // DEREM-25: drive the private helper twice on the same scope to prove
    // the loggedScopes WeakSet dedup itself: the second call observes the
    // memoized rejection from the first scope.close() and must short-circuit
    // before re-iterating failures. The mechanism behaves the same when
    // the two callers are sequential or concurrent (ResourceScope.close()
    // is memoized).
    const closeAndLog = (
      backend as unknown as {
        closeResourceScopeAndLog: (s: ResourceScope) => Promise<void>;
      }
    ).closeResourceScopeAndLog.bind(backend);

    await closeAndLog(scope);
    await closeAndLog(scope);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      'ghostty-web renderer cleanup failure: browser',
      browserError,
    );
  });
});

describe('GhosttyWebBackend replayWithTiming output pacing', () => {
  const FIRST_EVENT_AT_MS = 16;
  const RECORDED: ReplayTimingOptions = {
    mode: 'recorded',
    finalFrameHoldMs: 1_000,
  };
  const MAX_SPEED: ReplayTimingOptions = {
    mode: 'max-speed',
    minFrameHoldMs: 16,
    finalFrameHoldMs: 500,
  };
  const BASE_TIMESTAMP_MS = Date.parse('2026-03-19T12:00:00.000Z');

  afterEach(() => {
    vi.useRealTimers();
  });

  function outputEvent(
    seq: number,
    offsetMs: number,
  ): ReplayInput['events'][number] {
    return {
      seq,
      ts: new Date(BASE_TIMESTAMP_MS + offsetMs).toISOString(),
      type: 'output',
      payload: { data: `out${String(seq)}` },
    };
  }

  function exitEvent(
    seq: number,
    offsetMs: number,
  ): ReplayInput['events'][number] {
    return {
      seq,
      ts: new Date(BASE_TIMESTAMP_MS + offsetMs).toISOString(),
      type: 'exit',
      payload: { exitCode: 0, exitSignal: null },
    };
  }

  async function replayAndRecordFlushes(
    events: ReplayInput['events'],
    timing: ReplayTimingOptions,
    flushCostMs = 0,
    onFlush: () => void = () => {},
  ): Promise<{ atMs: number; chunks: string[] }[]> {
    vi.useFakeTimers();
    const backend = createBackend();
    const flushes: { atMs: number; chunks: string[] }[] = [];
    let replayStartedAtMs = 0;

    Object.assign(backend as object, {
      isBooted: true,
      page: { isClosed: () => false },
      resizeBridge: () => {
        replayStartedAtMs = performance.now();
        return Promise.resolve();
      },
      flushOutputBatch: (_page: object, dataChunks: string[]) => {
        flushes.push({ atMs: performance.now(), chunks: [...dataChunks] });
        onFlush();
        return new Promise<void>((resolve) => {
          setTimeout(resolve, flushCostMs);
        });
      },
      readHarnessSnapshot: () =>
        Promise.resolve(
          createHarnessSnapshotPayload({
            cols: 80,
            rows: 24,
            visibleLines: [],
          }),
        ),
    });

    const replay = backend.replayWithTiming(
      {
        sessionId: 'renderer-unit-session',
        initialCols: 80,
        initialRows: 24,
        targetSeq: Math.max(...events.map((event) => event.seq)),
        events,
      },
      timing,
    );
    await vi.runAllTimersAsync();
    await replay;

    return flushes.map((flush) => ({
      atMs: flush.atMs - replayStartedAtMs,
      chunks: flush.chunks,
    }));
  }

  it('shows each output at its recorded time when the outputs are far apart', async () => {
    const flushes = await replayAndRecordFlushes(
      [
        outputEvent(0, 0),
        outputEvent(1, 200),
        outputEvent(2, 400),
        exitEvent(3, 600),
      ],
      RECORDED,
    );

    expect(flushes).toEqual([
      { atMs: FIRST_EVENT_AT_MS, chunks: ['out0'] },
      { atMs: FIRST_EVENT_AT_MS + 200, chunks: ['out1'] },
      { atMs: FIRST_EVENT_AT_MS + 400, chunks: ['out2'] },
    ]);
  });

  it('keeps outputs that arrive within one frame hold in a single flush', async () => {
    const flushes = await replayAndRecordFlushes(
      [
        outputEvent(0, 0),
        outputEvent(1, 5),
        outputEvent(2, 10),
        exitEvent(3, 500),
      ],
      RECORDED,
    );

    expect(flushes).toEqual([
      { atMs: FIRST_EVENT_AT_MS + 10, chunks: ['out0', 'out1', 'out2'] },
    ]);
  });

  it('keeps the recorded pace when each flush costs more than a frame hold', async () => {
    const events = Array.from({ length: 101 }, (_, index) =>
      outputEvent(index, index * 10),
    );
    events.push(exitEvent(101, 1_000));
    const flushes = await replayAndRecordFlushes(events, RECORDED, 30);

    expect(flushes.length).toBeGreaterThanOrEqual(10);
    expect(flushes.at(-1)?.atMs).toBeLessThanOrEqual(FIRST_EVENT_AT_MS + 1_060);
    expect(flushes.flatMap((flush) => flush.chunks)).toEqual(
      events.slice(0, 101).map((event) => `out${String(event.seq)}`),
    );
  });

  it('keeps the pace when the wall clock jumps during the replay', async () => {
    const flushes = await replayAndRecordFlushes(
      [
        outputEvent(0, 0),
        outputEvent(1, 200),
        outputEvent(2, 400),
        exitEvent(3, 600),
      ],
      RECORDED,
      0,
      () => {
        vi.setSystemTime(Date.now() + 60_000);
      },
    );

    expect(flushes.map((flush) => flush.atMs)).toEqual([
      FIRST_EVENT_AT_MS,
      FIRST_EVENT_AT_MS + 200,
      FIRST_EVENT_AT_MS + 400,
    ]);
  });

  it('paces accelerated output on the capped schedule with its own frame hold', async () => {
    const accelerated: ReplayTimingOptions = {
      mode: 'accelerated',
      maxGapMs: 400,
      minFrameHoldMs: 100,
      finalFrameHoldMs: 1_000,
    };
    const flushes = await replayAndRecordFlushes(
      [
        outputEvent(0, 0),
        outputEvent(1, 150),
        outputEvent(2, 300),
        outputEvent(3, 340),
        outputEvent(4, 2_300),
        exitEvent(5, 2_500),
      ],
      accelerated,
    );

    expect(flushes).toEqual([
      { atMs: 100, chunks: ['out0'] },
      { atMs: 250, chunks: ['out1'] },
      { atMs: 440, chunks: ['out2', 'out3'] },
      { atMs: 840, chunks: ['out4'] },
    ]);
  });

  it('keeps max-speed outputs in one flush so frame holds cannot outlast the export timeout', async () => {
    const flushes = await replayAndRecordFlushes(
      [outputEvent(0, 0), outputEvent(1, 200), outputEvent(2, 400)],
      MAX_SPEED,
    );

    expect(flushes).toEqual([
      { atMs: FIRST_EVENT_AT_MS, chunks: ['out0', 'out1', 'out2'] },
    ]);
  });

  it('refreshes continuous output at least once per frame hold', async () => {
    const events = Array.from({ length: 21 }, (_, index) =>
      outputEvent(index, index * 10),
    );
    events.push(exitEvent(21, 300));
    const flushes = await replayAndRecordFlushes(events, RECORDED);

    expect(flushes.length).toBeGreaterThanOrEqual(8);
    expect(flushes[0]?.atMs).toBeLessThanOrEqual(FIRST_EVENT_AT_MS + 20);
    expect(flushes.flatMap((flush) => flush.chunks)).toEqual(
      events.slice(0, 21).map((event) => `out${String(event.seq)}`),
    );
  });

  it('keeps the recorded pace when continuous output fills every frame hold', async () => {
    const events = Array.from({ length: 101 }, (_, index) =>
      outputEvent(index, index * 10),
    );
    events.push(exitEvent(101, 1_000));
    const flushes = await replayAndRecordFlushes(events, RECORDED);

    expect(flushes.length).toBeGreaterThanOrEqual(30);
    expect(flushes.at(-1)?.atMs).toBeLessThanOrEqual(FIRST_EVENT_AT_MS + 1_020);
  });
});
