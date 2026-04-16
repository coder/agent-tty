import { invariant } from '../../src/util/assert.js';

export interface SchedulerOptions {
  concurrency: number;
  logLine?: (line: string) => void;
}

export type ScheduledWorkItem = { key: string };

export type SettledResult<T, R> =
  | { item: T; status: 'fulfilled'; value: R }
  | { item: T; status: 'rejected'; reason: unknown };

export async function runScheduled<T extends ScheduledWorkItem, R>(
  items: readonly T[],
  executor: (item: T) => Promise<R>,
  options: SchedulerOptions,
): Promise<SettledResult<T, R>[]> {
  invariant(Array.isArray(items), 'items must be an array');
  invariant(
    Number.isInteger(options.concurrency) && options.concurrency > 0,
    'options.concurrency must be a positive integer',
  );

  if (items.length === 0) {
    return [];
  }

  const settlements: Array<SettledResult<T, R> | undefined> = new Array(
    items.length,
  );
  const workerCount = Math.min(options.concurrency, items.length);
  const logLine = options.logLine;
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      if (index >= items.length) {
        return;
      }
      nextIndex += 1;

      const item = items[index];
      invariant(item !== undefined, `Missing scheduled item at index ${index}`);

      logLine?.(`[${item.key}] start`);
      try {
        const value = await executor(item);
        settlements[index] = { item, status: 'fulfilled', value };
        logLine?.(`[${item.key}] ok`);
      } catch (reason) {
        settlements[index] = { item, status: 'rejected', reason };
        logLine?.(`[${item.key}] failed: ${String(reason)}`);
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return settlements.map((settlement, index) => {
    invariant(
      settlement !== undefined,
      `Missing scheduler settlement for item at index ${index}`,
    );
    return settlement;
  });
}
