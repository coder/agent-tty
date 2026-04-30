import { invariant } from '../../src/util/assert.js';

export const DEFAULT_PARALLELISM = 5;
export const MAX_PARALLELISM = 20;

export function parseParallelism(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_PARALLELISM;
  }

  const parsed = Number(raw);

  invariant(Number.isInteger(parsed), 'parallelism must be an integer');
  invariant(parsed >= 1, 'parallelism must be at least 1');
  // Cap fan-out to avoid surprising Coder workspace creation and API pressure.
  invariant(
    parsed <= MAX_PARALLELISM,
    `parallelism must be at most ${MAX_PARALLELISM}`,
  );

  return parsed;
}
