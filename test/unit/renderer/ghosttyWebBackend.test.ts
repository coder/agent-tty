import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

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
      page: {
        evaluate,
        isClosed: () => false,
      },
    });

    await expect(backend.snapshot({ includeCells: true })).rejects.toThrow(
      'snapshot cell line 0 cell count must not exceed the terminal width',
    );
  });

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
  });

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

    const evaluate = vi.fn().mockResolvedValue(undefined);
    const screenshot = vi.fn(
      async (options: {
        animations: 'disabled';
        caret: 'hide';
        path: string;
        type: 'png';
      }) => {
        expect(options).toEqual({
          animations: 'disabled',
          caret: 'hide',
          path: outputPath,
          type: 'png',
        });
        await writeFile(outputPath, pngBuffer);
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
      });
      expect(evaluate).toHaveBeenCalledTimes(2);
      expect(evaluate.mock.calls[0]?.[1]).toBe(false);
      expect(locator).toHaveBeenCalledWith('#terminal');
      expect(screenshot).toHaveBeenCalledTimes(1);
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it('uses initial caret capture when showCursor is enabled', async () => {
    const backend = createBackend();
    // oxfmt-ignore
    const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), 'ghostty-web-backend-cursor-')));
    const outputPath = join(temporaryDirectory, 'screenshot.png');
    const pngBuffer = createPngBuffer(640, 480);
    const expectedSha256 = createHash('sha256').update(pngBuffer).digest('hex');

    const evaluate = vi.fn().mockResolvedValue(undefined);
    const screenshot = vi.fn(
      async (options: {
        animations: 'disabled';
        caret: 'initial';
        path: string;
        type: 'png';
      }) => {
        expect(options).toEqual({
          animations: 'disabled',
          caret: 'initial',
          path: outputPath,
          type: 'png',
        });
        await writeFile(outputPath, pngBuffer);
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
      });
      expect(evaluate).toHaveBeenCalledTimes(2);
      expect(evaluate.mock.calls[0]?.[1]).toBe(true);
      expect(locator).toHaveBeenCalledWith('#terminal');
      expect(screenshot).toHaveBeenCalledTimes(1);
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
});
