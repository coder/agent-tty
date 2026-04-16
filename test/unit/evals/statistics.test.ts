import { describe, expect, it } from 'vitest';

import {
  bootstrapPairedCI,
  computeConfidenceInterval,
  computeMean,
  computePairedDelta,
  computePassRate,
  computeStdDev,
  computeWinRate,
} from '../../../evals/lib/statistics.js';

function createPassResults(values: readonly boolean[]): { ok: boolean }[] {
  return values.map((ok) => ({ ok }));
}

describe('computeMean', () => {
  it('returns 0 for empty input', () => {
    expect(computeMean([])).toBe(0);
  });

  it('computes the arithmetic mean for finite values', () => {
    expect(computeMean([1, 2, 3, 4])).toBe(2.5);
  });

  it('throws for non-finite input values', () => {
    expect(() => computeMean([1, Number.NaN])).toThrow('finite number');
  });
});

describe('computeStdDev', () => {
  it('returns 0 for empty, singleton, and repeated values', () => {
    expect(computeStdDev([])).toBe(0);
    expect(computeStdDev([7])).toBe(0);
    expect(computeStdDev([5, 5, 5])).toBe(0);
  });

  it('computes the sample standard deviation and accepts an explicit mean', () => {
    expect(computeStdDev([1, 2, 3, 4])).toBeCloseTo(1.2909944487);
    expect(computeStdDev([1, 2, 3, 4], 2.5)).toBeCloseTo(1.2909944487);
  });

  it('throws for non-finite input values', () => {
    expect(() => computeStdDev([1, Number.POSITIVE_INFINITY])).toThrow(
      'finite number',
    );
  });
});

describe('computeConfidenceInterval', () => {
  it('uses t critical values for small samples', () => {
    const summary = computeConfidenceInterval([1, 2, 3, 4, 5]);

    expect(summary.mean).toBe(3);
    expect(summary.n).toBe(5);
    expect(summary.ci.lower).toBeCloseTo(1.0367568385);
    expect(summary.ci.upper).toBeCloseTo(4.9632431615);
  });

  it('uses z critical values for samples with at least 30 observations', () => {
    const summary = computeConfidenceInterval(
      Array.from({ length: 30 }, (_, index) => index + 1),
    );

    expect(summary.mean).toBe(15.5);
    expect(summary.n).toBe(30);
    expect(summary.ci.lower).toBeCloseTo(12.3497986356);
    expect(summary.ci.upper).toBeCloseTo(18.6502013644);
  });

  it('returns a point interval when fewer than two observations exist', () => {
    expect(computeConfidenceInterval([])).toEqual({
      mean: 0,
      ci: { lower: 0, upper: 0 },
      n: 0,
    });
    expect(computeConfidenceInterval([8])).toEqual({
      mean: 8,
      ci: { lower: 8, upper: 8 },
      n: 1,
    });
  });

  it('throws for invalid confidence values', () => {
    expect(() => computeConfidenceInterval([1, 2], 1)).toThrow(
      'confidence must be between 0 and 1',
    );
  });
});

describe('computePassRate', () => {
  it('returns stable defaults for empty input', () => {
    expect(computePassRate([])).toEqual({
      rate: 0,
      ci: { lower: 0, upper: 0 },
      n: 0,
      passed: 0,
    });
  });

  it('computes the Wilson score interval at 95% confidence', () => {
    const summary = computePassRate(
      createPassResults([true, true, false, true]),
    );

    expect(summary.rate).toBe(0.75);
    expect(summary.passed).toBe(3);
    expect(summary.n).toBe(4);
    expect(summary.ci.lower).toBeCloseTo(0.3006418423);
    expect(summary.ci.upper).toBeCloseTo(0.9544127392);
  });

  it('throws when a result does not expose a boolean ok flag', () => {
    expect(() =>
      computePassRate([{ ok: true }, { ok: 1 }] as unknown as readonly {
        ok: boolean;
      }[]),
    ).toThrow('boolean ok flag');
  });
});

describe('computePairedDelta', () => {
  it('marks a positive paired delta as significant when the CI excludes zero', () => {
    expect(computePairedDelta([1, 2, 3, 4], [2, 3, 4, 5])).toEqual({
      mean: 1,
      ci: { lower: 1, upper: 1 },
      n: 4,
      significant: true,
    });
  });

  it('marks a paired delta as not significant when the CI crosses zero', () => {
    const summary = computePairedDelta([1, 2, 3, 4], [2, 1, 4, 3]);

    expect(summary.mean).toBe(0);
    expect(summary.significant).toBe(false);
    expect(summary.ci.lower).toBeLessThan(0);
    expect(summary.ci.upper).toBeGreaterThan(0);
  });

  it('throws for paired-length mismatches', () => {
    expect(() => computePairedDelta([1], [1, 2])).toThrow('equal length');
  });
});

describe('computeWinRate', () => {
  it('counts wins, losses, and ties across paired scores', () => {
    expect(computeWinRate([1, 2, 3, 4], [2, 1, 3, 5])).toEqual({
      wins: 2,
      losses: 1,
      ties: 1,
      n: 4,
      winRate: 0.5,
    });
  });
});

describe('bootstrapPairedCI', () => {
  it('is deterministic for the same seed', () => {
    const first = bootstrapPairedCI([1, 2, 3, 4], [1, 4, 2, 6], {
      iterations: 1000,
      seed: 7,
    });
    const second = bootstrapPairedCI([1, 2, 3, 4], [1, 4, 2, 6], {
      iterations: 1000,
      seed: 7,
    });

    expect(first).toEqual(second);
    expect(first).toEqual({
      mean: 0.75,
      ci: {
        lower: -0.5062499999999943,
        upper: 2,
      },
      n: 4,
      significant: false,
    });
  });

  it('reports significance when the bootstrap CI excludes zero', () => {
    const summary = bootstrapPairedCI([1, 2, 3, 4], [2, 3, 5, 6], {
      iterations: 1000,
      seed: 42,
    });

    expect(summary.mean).toBe(1.5);
    expect(summary.ci).toEqual({ lower: 1, upper: 2 });
    expect(summary.significant).toBe(true);
  });

  it('throws for invalid confidence, invalid iterations, and length mismatches', () => {
    expect(() => bootstrapPairedCI([1, 2], [1, 2], { confidence: 0 })).toThrow(
      'confidence must be between 0 and 1',
    );
    expect(() => bootstrapPairedCI([1, 2], [1, 2], { iterations: 99 })).toThrow(
      'iterations must be an integer greater than or equal to 100',
    );
    expect(() => bootstrapPairedCI([1], [1, 2])).toThrow('equal length');
  });
});
