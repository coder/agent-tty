import { invariant } from '../../src/util/assert.js';

export function assertIssueNumber(value: unknown): number {
  invariant(
    typeof value === 'number' &&
      Number.isFinite(value) &&
      Number.isInteger(value) &&
      value > 0,
    'issue number must be a positive integer',
  );

  return value;
}
