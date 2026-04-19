import { invariant } from '../../src/util/assert.js';

export type ScheduledWorkItem = { key: string };

export type SchedulerItemSettlement<R> =
  | { status: 'fulfilled'; value: R }
  | { status: 'rejected'; reason: unknown };

export interface SchedulerOptions<
  T extends ScheduledWorkItem = ScheduledWorkItem,
  R = unknown,
> {
  concurrency: number;
  logLine?: (line: string) => void;
  onItemStart?: (item: T) => void | Promise<void>;
  onItemFinish?: (
    item: T,
    settled: SchedulerItemSettlement<R>,
  ) => void | Promise<void>;
}

export type SettledResult<T, R> =
  | { item: T; status: 'fulfilled'; value: R }
  | { item: T; status: 'rejected'; reason: unknown };

export async function runScheduled<T extends ScheduledWorkItem, R>(
  items: readonly T[],
  executor: (item: T) => Promise<R>,
  options: SchedulerOptions<T, R>,
): Promise<SettledResult<T, R>[]> {
  invariant(Array.isArray(items), 'items must be an array');
  invariant(
    Number.isInteger(options.concurrency) && options.concurrency > 0,
    'options.concurrency must be a positive integer',
  );

  const onItemStart = options.onItemStart;
  invariant(
    onItemStart === undefined || typeof onItemStart === 'function',
    'options.onItemStart must be a function or undefined',
  );

  const onItemFinish = options.onItemFinish;
  invariant(
    onItemFinish === undefined || typeof onItemFinish === 'function',
    'options.onItemFinish must be a function or undefined',
  );

  if (items.length === 0) {
    return [];
  }

  const settlements: Array<SettledResult<T, R> | undefined> = Array.from(
    { length: items.length },
    () => undefined,
  );
  const workerCount = Math.min(options.concurrency, items.length);
  const logLine = options.logLine;
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      if (index >= items.length) {
        return;
      }
      nextIndex += 1;

      const item = items[index];
      invariant(
        item !== undefined,
        `Missing scheduled item at index ${String(index)}`,
      );

      logLine?.(`[${item.key}] start`);
      await onItemStart?.(item);

      try {
        const value = await executor(item);
        const settled: SchedulerItemSettlement<R> = {
          status: 'fulfilled',
          value,
        };
        settlements[index] = { item, ...settled };
        await onItemFinish?.(item, settled);
        logLine?.(`[${item.key}] ok`);
      } catch (reason) {
        const settled: SchedulerItemSettlement<R> = {
          status: 'rejected',
          reason,
        };
        settlements[index] = { item, ...settled };
        await onItemFinish?.(item, settled);
        logLine?.(`[${item.key}] failed: ${String(reason)}`);
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return settlements.map((settlement, index) => {
    invariant(
      settlement !== undefined,
      `Missing scheduler settlement for item at index ${String(index)}`,
    );
    return settlement;
  });
}
