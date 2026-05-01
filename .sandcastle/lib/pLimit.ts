import { invariant } from '../../src/util/assert.js';

export function pLimit(concurrency: number) {
  invariant(
    Number.isInteger(concurrency) && concurrency > 0,
    'concurrency must be a positive integer',
  );

  let active = 0;
  const queue: Array<() => void> = [];

  function runNext(): void {
    if (active >= concurrency) {
      return;
    }

    const next = queue.shift();
    if (next === undefined) {
      return;
    }

    active += 1;
    next();
  }

  return function limit<T>(task: () => Promise<T>): Promise<T> {
    invariant(typeof task === 'function', 'limited task must be a function');

    return new Promise<T>((resolve, reject) => {
      const run = (): void => {
        // Wrap `task()` in `Promise.resolve().then(...)` so a synchronous
        // throw inside a non-async caller still becomes a rejection. Without
        // this, a sync throw would skip the `.finally()` decrement, leaking
        // a concurrency slot permanently and stalling the batch after
        // `concurrency` such failures.
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            runNext();
          });
      };

      if (active < concurrency) {
        active += 1;
        run();
        return;
      }

      queue.push(run);
    });
  };
}
