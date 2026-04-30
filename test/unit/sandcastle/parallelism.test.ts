import { describe, expect, it } from 'vitest';

import { parseParallelism } from '../../../.sandcastle/lib/parallelism.js';

describe('parseParallelism', () => {
  it('defaults to five', () => {
    expect(parseParallelism(undefined)).toBe(5);
  });

  it('accepts an explicit integer', () => {
    expect(parseParallelism('12')).toBe(12);
  });

  it('rejects non-integers', () => {
    expect(() => parseParallelism('1.5')).toThrow(/integer/u);
    expect(() => parseParallelism('abc')).toThrow(/integer/u);
  });

  it('rejects values outside the accepted bounds', () => {
    expect(() => parseParallelism('0')).toThrow(/at least 1/u);
    expect(() => parseParallelism('21')).toThrow(/at most 20/u);
  });
});
