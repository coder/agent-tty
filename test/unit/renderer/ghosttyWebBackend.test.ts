import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { hashProfile, resolveProfile } from '../../../src/renderer/profiles.js';
import { GhosttyWebBackend } from '../../../src/renderer/ghosttyWeb/index.js';

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
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), 'ghostty-web-backend-'),
    );
    const outputPath = join(temporaryDirectory, 'screenshot.png');
    const pngBuffer = createPngBuffer(800, 600);
    const expectedSha256 = createHash('sha256')
      .update(pngBuffer)
      .digest('hex');

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
        rendererBackend: 'ghostty-web',
        pixelWidth: 800,
        pixelHeight: 600,
        sha256: expectedSha256,
        renderProfileHash: hashProfile(PROFILE),
      });
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(locator).toHaveBeenCalledWith('#terminal');
      expect(screenshot).toHaveBeenCalledTimes(1);
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
