import { describe, expect, it, vi } from 'vitest';

import { resolveProfile } from '../../../src/renderer/profiles.js';
import { GhosttyWebBackend } from '../../../src/renderer/ghosttyWeb/index.js';

const PROFILE = resolveProfile('reference-dark');

function createBackend(): GhosttyWebBackend {
  return new GhosttyWebBackend('renderer-unit-session', PROFILE);
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
});
