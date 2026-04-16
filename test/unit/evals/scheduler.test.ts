import { describe, expect, it } from 'vitest';

import { runScheduled } from '../../../evals/lib/scheduler.js';
import type { SettledResult } from '../../../evals/lib/scheduler.js';

interface TestItem {
  key: string;
  delayMs?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function expectRejectedError(
  settlement: SettledResult<TestItem, string> | undefined,
  message: string,
): void {
  expect(settlement).toBeDefined();
  if (settlement === undefined) {
    throw new Error('Expected settlement');
  }

  expect(settlement.status).toBe('rejected');
  if (settlement.status !== 'rejected') {
    throw new Error('Expected rejected settlement');
  }

  expect(settlement.reason).toBeInstanceOf(Error);
  if (!(settlement.reason instanceof Error)) {
    throw new Error('Expected Error rejection reason');
  }

  expect(settlement.reason.message).toBe(message);
}

describe('runScheduled', () => {
  it('respects max concurrency', async () => {
    const items = Array.from({ length: 6 }, (_, index) => ({
      key: `item-${String(index)}`,
    }));
    let inFlight = 0;
    let maxInFlight = 0;

    const results = await runScheduled(
      items,
      async (item) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(20);
        inFlight -= 1;
        return item.key;
      },
      { concurrency: 2 },
    );

    expect(results).toHaveLength(items.length);
    expect(inFlight).toBe(0);
    expect(maxInFlight).toBe(2);
  });

  it('returns an empty array for empty items', async () => {
    let called = false;

    const results = await runScheduled(
      [],
      () => {
        called = true;
        return Promise.resolve('unused');
      },
      { concurrency: 1 },
    );

    expect(results).toEqual([]);
    expect(called).toBe(false);
  });

  it('captures synchronous throws as rejected settlements', async () => {
    const items: TestItem[] = [{ key: 'sync-throw' }];

    const results = await runScheduled(
      items,
      (): Promise<string> => {
        throw new Error('sync boom');
      },
      { concurrency: 1 },
    );

    expectRejectedError(results[0], 'sync boom');
    expect(results[0]).toMatchObject({ item: items[0], status: 'rejected' });
  });

  it('captures async rejects as rejected settlements', async () => {
    const items: TestItem[] = [{ key: 'async-reject' }];

    const results = await runScheduled(
      items,
      () => Promise.reject(new Error('async boom')),
      { concurrency: 1 },
    );

    expectRejectedError(results[0], 'async boom');
    expect(results[0]).toMatchObject({ item: items[0], status: 'rejected' });
  });

  it('continues running successful siblings after failures', async () => {
    const items: TestItem[] = [
      { key: 'success-1', delayMs: 15 },
      { key: 'fail-1', delayMs: 5 },
      { key: 'success-2', delayMs: 1 },
      { key: 'fail-2', delayMs: 10 },
    ];

    const results = await runScheduled(
      items,
      async (item) => {
        await delay(item.delayMs ?? 0);
        if (item.key.startsWith('fail')) {
          throw new Error(`${item.key} failed`);
        }
        return `${item.key} ok`;
      },
      { concurrency: 2 },
    );

    expect(results).toHaveLength(items.length);
    expect(results.map((settlement) => settlement.status)).toEqual([
      'fulfilled',
      'rejected',
      'fulfilled',
      'rejected',
    ]);

    const [first, second, third, fourth] = results;
    expect(first).toMatchObject({
      item: items[0],
      status: 'fulfilled',
      value: 'success-1 ok',
    });
    expect(second).toMatchObject({ item: items[1], status: 'rejected' });
    expect(third).toMatchObject({
      item: items[2],
      status: 'fulfilled',
      value: 'success-2 ok',
    });
    expect(fourth).toMatchObject({ item: items[3], status: 'rejected' });
  });

  it('preserves input order in returned settlements', async () => {
    const items: TestItem[] = [
      { key: 'item-0', delayMs: 30 },
      { key: 'item-1', delayMs: 20 },
      { key: 'item-2', delayMs: 10 },
      { key: 'item-3', delayMs: 0 },
    ];

    const results = await runScheduled(
      items,
      async (item) => {
        await delay(item.delayMs ?? 0);
        return item.key;
      },
      { concurrency: items.length },
    );

    expect(results.map((settlement) => settlement.item.key)).toEqual(
      items.map((item) => item.key),
    );
    expect(
      results.map((settlement) =>
        settlement.status === 'fulfilled' ? settlement.value : 'rejected',
      ),
    ).toEqual(items.map((item) => item.key));
  });

  it('logs lifecycle lines with the work-item key prefix', async () => {
    const items: TestItem[] = [{ key: 'alpha' }, { key: 'beta' }];
    const lines: string[] = [];

    await runScheduled(
      items,
      (item) => {
        if (item.key === 'beta') {
          throw new Error('beta failed');
        }
        return Promise.resolve(`${item.key} ok`);
      },
      {
        concurrency: 1,
        logLine: (line) => lines.push(line),
      },
    );

    expect(lines).toEqual([
      '[alpha] start',
      '[alpha] ok',
      '[beta] start',
      '[beta] failed: Error: beta failed',
    ]);
    for (const item of items) {
      expect(lines.some((line) => line.startsWith(`[${item.key}]`))).toBe(true);
    }
  });

  it('asserts on invalid concurrency values', async () => {
    const items: TestItem[] = [{ key: 'item-0' }];

    for (const concurrency of [0, -1, 1.5]) {
      await expect(
        runScheduled(items, (item) => Promise.resolve(item.key), {
          concurrency,
        }),
      ).rejects.toThrow('options.concurrency must be a positive integer');
    }
  });
});
