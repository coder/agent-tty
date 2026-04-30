import { describe, expect, it } from 'vitest';

import { assertIssueNumber } from '../../../.sandcastle/lib/issueNumber.js';

describe('assertIssueNumber', () => {
  it('returns a valid issue number', () => {
    expect(assertIssueNumber(42)).toBe(42);
  });

  it('rejects zero and negative numbers', () => {
    expect(() => assertIssueNumber(0)).toThrow(/positive integer/u);
    expect(() => assertIssueNumber(-1)).toThrow(/positive integer/u);
  });

  it('rejects fractional and non-finite numbers', () => {
    expect(() => assertIssueNumber(1.5)).toThrow(/positive integer/u);
    expect(() => assertIssueNumber(Number.NaN)).toThrow(/positive integer/u);
    expect(() => assertIssueNumber(Number.POSITIVE_INFINITY)).toThrow(
      /positive integer/u,
    );
  });
});
