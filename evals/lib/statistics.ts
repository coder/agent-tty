import { invariant } from '../../src/util/assert.js';

const DEFAULT_CONFIDENCE = 0.95;
const DEFAULT_BOOTSTRAP_ITERATIONS = 10_000;
const DEFAULT_BOOTSTRAP_SEED = 42;
const DEFAULT_ALPHA = 1 - DEFAULT_CONFIDENCE;
const T_CRITICAL_95 = [
  Number.NaN,
  12.706204736432095,
  4.302652729696142,
  3.182446305284264,
  2.7764451051977987,
  2.5705818366147395,
  2.446911846863915,
  2.3646242510102993,
  2.306004135204166,
  2.2621571628540993,
  2.2281388519649385,
  2.200985160082949,
  2.178812829663418,
  2.160368656461013,
  2.1447866879169273,
  2.131449545559323,
  2.1199052992210112,
  2.109815577833181,
  2.10092204024096,
  2.093024054408263,
  2.0859634472658364,
  2.079613844727662,
  2.0738730679040147,
  2.068657610419041,
  2.0638985616280205,
  2.059538552753294,
  2.055529438642871,
  2.0518305164802833,
  2.048407141795244,
  2.045229642132703,
] as const;

type Interval = {
  lower: number;
  upper: number;
};

function assertFiniteNumber(
  value: unknown,
  label: string,
): asserts value is number {
  invariant(
    typeof value === 'number' && Number.isFinite(value),
    `${label} must be a finite number`,
  );
}

function assertConfidence(confidence: number): void {
  invariant(
    Number.isFinite(confidence) && confidence > 0 && confidence < 1,
    'confidence must be between 0 and 1',
  );
}

function assertPairedLengths(
  baseline: readonly number[],
  candidate: readonly number[],
): void {
  invariant(
    baseline.length === candidate.length,
    'baseline and candidate must have equal length',
  );
}

function collectPairedDifferences(
  baseline: readonly number[],
  candidate: readonly number[],
): number[] {
  assertPairedLengths(baseline, candidate);

  const differences = new Array<number>(baseline.length);
  for (let index = 0; index < baseline.length; index += 1) {
    const baselineValue = baseline[index];
    const candidateValue = candidate[index];
    assertFiniteNumber(
      baselineValue,
      `baseline value at index ${String(index)}`,
    );
    assertFiniteNumber(
      candidateValue,
      `candidate value at index ${String(index)}`,
    );
    differences[index] = candidateValue - baselineValue;
  }

  return differences;
}

function buildPointInterval(value: number): Interval {
  return {
    lower: value,
    upper: value,
  };
}

function confidenceIntervalExcludesZero(ci: Interval): boolean {
  return ci.lower > 0 || ci.upper < 0;
}

function inverseStandardNormal(probability: number): number {
  invariant(
    probability > 0 && probability < 1,
    'normal quantile probability must be between 0 and 1',
  );

  const a1 = -39.69683028665376;
  const a2 = 220.9460984245205;
  const a3 = -275.9285104469687;
  const a4 = 138.357751867269;
  const a5 = -30.66479806614716;
  const a6 = 2.506628277459239;
  const b1 = -54.47609879822406;
  const b2 = 161.5858368580409;
  const b3 = -155.6989798598866;
  const b4 = 66.80131188771972;
  const b5 = -13.28068155288572;
  const c1 = -0.007784894002430293;
  const c2 = -0.3223964580411365;
  const c3 = -2.400758277161838;
  const c4 = -2.549732539343734;
  const c5 = 4.374664141464968;
  const c6 = 2.938163982698783;
  const d1 = 0.007784695709041462;
  const d2 = 0.3224671290700398;
  const d3 = 2.445134137142996;
  const d4 = 3.754408661907416;
  const lowerRegionBoundary = 0.02425;
  const upperRegionBoundary = 1 - lowerRegionBoundary;

  if (probability < lowerRegionBoundary) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (
      (((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
      ((((d1 * q + d2) * q + d3) * q + d4) * q + 1)
    );
  }

  if (probability <= upperRegionBoundary) {
    const q = probability - 0.5;
    const r = q * q;
    return (
      (((((a1 * r + a2) * r + a3) * r + a4) * r + a5) * r + a6) * q /
      (((((b1 * r + b2) * r + b3) * r + b4) * r + b5) * r + 1)
    );
  }

  const q = Math.sqrt(-2 * Math.log(1 - probability));
  return (
    -(((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
    ((((d1 * q + d2) * q + d3) * q + d4) * q + 1)
  );
}

function tCriticalValue(df: number, alpha: number): number {
  invariant(Number.isInteger(df) && df >= 1, 'df must be a positive integer');
  invariant(
    Number.isFinite(alpha) && alpha > 0 && alpha < 1,
    'alpha must be between 0 and 1',
  );

  if (Math.abs(alpha - DEFAULT_ALPHA) < 1e-9 && df < T_CRITICAL_95.length) {
    const critical = T_CRITICAL_95[df];
    invariant(
      critical !== undefined && Number.isFinite(critical),
      `Missing t critical value for df ${String(df)}`,
    );
    return critical;
  }

  const z = zCriticalValue(alpha);
  const z2 = z * z;
  const z3 = z2 * z;
  const z5 = z3 * z2;
  const z7 = z5 * z2;
  const df2 = df * df;
  const df3 = df2 * df;

  return (
    z +
    (z3 + z) / (4 * df) +
    (5 * z5 + 16 * z3 + 3 * z) / (96 * df2) +
    (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df3)
  );
}

function zCriticalValue(alpha: number): number {
  invariant(
    Number.isFinite(alpha) && alpha > 0 && alpha < 1,
    'alpha must be between 0 and 1',
  );
  return inverseStandardNormal(1 - alpha / 2);
}

function percentile(sortedValues: readonly number[], probability: number): number {
  invariant(sortedValues.length > 0, 'percentile input must not be empty');
  invariant(
    probability >= 0 && probability <= 1,
    'percentile probability must be between 0 and 1',
  );

  const lastIndex = sortedValues.length - 1;
  const rawIndex = probability * lastIndex;
  const lowerIndex = Math.floor(rawIndex);
  const upperIndex = Math.ceil(rawIndex);
  const lowerValue = sortedValues[lowerIndex];
  const upperValue = sortedValues[upperIndex];
  invariant(lowerValue !== undefined, 'percentile lower value must exist');
  invariant(upperValue !== undefined, 'percentile upper value must exist');

  if (lowerIndex === upperIndex) {
    return lowerValue;
  }

  const weight = rawIndex - lowerIndex;
  return lowerValue + (upperValue - lowerValue) * weight;
}

export function computeMean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }

  let total = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    assertFiniteNumber(value, `mean value at index ${String(index)}`);
    total += value;
  }

  return total / values.length;
}

export function computeStdDev(
  values: readonly number[],
  mean?: number,
): number {
  if (values.length === 0) {
    return 0;
  }

  let total = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    assertFiniteNumber(
      value,
      `standard deviation value at index ${String(index)}`,
    );
    total += value;
  }

  if (mean !== undefined) {
    assertFiniteNumber(mean, 'standard deviation mean');
  }

  if (values.length < 2) {
    return 0;
  }

  const resolvedMean = mean ?? total / values.length;
  let squaredDeviationTotal = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    invariant(
      value !== undefined,
      `Missing standard deviation value at ${String(index)}`,
    );
    const delta = value - resolvedMean;
    squaredDeviationTotal += delta * delta;
  }

  return Math.sqrt(squaredDeviationTotal / (values.length - 1));
}

export function computeConfidenceInterval(
  values: readonly number[],
  confidence = DEFAULT_CONFIDENCE,
): { mean: number; ci: Interval; n: number } {
  assertConfidence(confidence);

  const mean = computeMean(values);
  const n = values.length;
  if (n < 2) {
    return {
      mean,
      ci: buildPointInterval(mean),
      n,
    };
  }

  const stdDev = computeStdDev(values, mean);
  if (stdDev === 0) {
    return {
      mean,
      ci: buildPointInterval(mean),
      n,
    };
  }

  const alpha = 1 - confidence;
  const standardError = stdDev / Math.sqrt(n);
  const critical = n < 30 ? tCriticalValue(n - 1, alpha) : zCriticalValue(alpha);
  const margin = critical * standardError;

  return {
    mean,
    ci: {
      lower: mean - margin,
      upper: mean + margin,
    },
    n,
  };
}

export function computePassRate(
  results: readonly { ok: boolean }[],
): { rate: number; ci: Interval; n: number; passed: number } {
  const n = results.length;
  if (n === 0) {
    return {
      rate: 0,
      ci: buildPointInterval(0),
      n,
      passed: 0,
    };
  }

  let passed = 0;
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index] as unknown;
    invariant(
      typeof result === 'object' &&
        result !== null &&
        'ok' in result &&
        typeof result.ok === 'boolean',
      `pass-rate result at index ${String(index)} must include a boolean ok flag`,
    );
    if (result.ok) {
      passed += 1;
    }
  }

  const rate = passed / n;
  const z = zCriticalValue(DEFAULT_ALPHA);
  const zSquared = z * z;
  const denominator = 1 + zSquared / n;
  const center = (rate + zSquared / (2 * n)) / denominator;
  const margin =
    (z * Math.sqrt((rate * (1 - rate) + zSquared / (4 * n)) / n)) /
    denominator;

  return {
    rate,
    ci: {
      lower: Math.max(0, center - margin),
      upper: Math.min(1, center + margin),
    },
    n,
    passed,
  };
}

export function computePairedDelta(
  baseline: readonly number[],
  candidate: readonly number[],
): { mean: number; ci: Interval; n: number; significant: boolean } {
  const differences = collectPairedDifferences(baseline, candidate);
  const summary = computeConfidenceInterval(differences);

  return {
    ...summary,
    significant: confidenceIntervalExcludesZero(summary.ci),
  };
}

export function computeWinRate(
  baseline: readonly number[],
  candidate: readonly number[],
): {
  wins: number;
  losses: number;
  ties: number;
  n: number;
  winRate: number;
} {
  const differences = collectPairedDifferences(baseline, candidate);
  let wins = 0;
  let losses = 0;
  let ties = 0;

  for (const difference of differences) {
    if (difference > 0) {
      wins += 1;
      continue;
    }

    if (difference < 0) {
      losses += 1;
      continue;
    }

    ties += 1;
  }

  return {
    wins,
    losses,
    ties,
    n: differences.length,
    winRate: differences.length === 0 ? 0 : wins / differences.length,
  };
}

export function bootstrapPairedCI(
  baseline: readonly number[],
  candidate: readonly number[],
  options?: {
    confidence?: number;
    iterations?: number;
    seed?: number;
  },
): { mean: number; ci: Interval; n: number; significant: boolean } {
  const confidence = options?.confidence ?? DEFAULT_CONFIDENCE;
  const iterations = options?.iterations ?? DEFAULT_BOOTSTRAP_ITERATIONS;
  const seed = options?.seed ?? DEFAULT_BOOTSTRAP_SEED;
  assertConfidence(confidence);
  invariant(
    Number.isInteger(iterations) && iterations >= 100,
    'iterations must be an integer greater than or equal to 100',
  );

  const differences = collectPairedDifferences(baseline, candidate);
  const mean = computeMean(differences);
  const n = differences.length;
  const pointCi = buildPointInterval(mean);
  if (n < 2) {
    return {
      mean,
      ci: pointCi,
      n,
      significant: confidenceIntervalExcludesZero(pointCi),
    };
  }

  const random = mulberry32(seed);
  const bootstrapMeans = new Array<number>(iterations);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let sampledTotal = 0;
    for (let index = 0; index < n; index += 1) {
      const sampledIndex = Math.floor(random() * n);
      const difference = differences[sampledIndex];
      invariant(
        difference !== undefined,
        `bootstrap difference at index ${String(sampledIndex)} must exist`,
      );
      sampledTotal += difference;
    }
    bootstrapMeans[iteration] = sampledTotal / n;
  }

  bootstrapMeans.sort((left, right) => left - right);
  const alpha = 1 - confidence;
  const ci = {
    lower: percentile(bootstrapMeans, alpha / 2),
    upper: percentile(bootstrapMeans, 1 - alpha / 2),
  };

  return {
    mean,
    ci,
    n,
    significant: confidenceIntervalExcludesZero(ci),
  };
}

function mulberry32(seed: number): () => number {
  assertFiniteNumber(seed, 'bootstrap seed');

  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
