import { describe, expect, it } from 'vitest';

import { SKILL_CONDITIONS } from '../../../evals/lib/matrix.js';
import {
  parseCliArgs,
  resolveRequestedConditions,
} from '../../../evals/run.js';

describe('parseCliArgs', () => {
  it('collects a single --condition value', () => {
    const options = parseCliArgs([
      '--provider',
      'stub',
      '--lane',
      'prompt',
      '--condition',
      'none',
    ]);

    expect(options.conditions).toEqual(['none']);
  });

  it('collects repeated --condition values in CLI order', () => {
    const options = parseCliArgs([
      '--provider',
      'stub',
      '--lane',
      'prompt',
      '--condition',
      'none',
      '--condition',
      'preloaded',
    ]);

    expect(options.conditions).toEqual(['none', 'preloaded']);
  });

  it('defaults to no explicit condition filters when --condition is omitted', () => {
    const options = parseCliArgs(['--provider', 'stub', '--lane', 'prompt']);

    expect(options.conditions).toEqual([]);
  });
});

describe('resolveRequestedConditions', () => {
  it('defaults to all conditions when no filters are provided', () => {
    expect(resolveRequestedConditions([])).toEqual(SKILL_CONDITIONS);
  });

  it('resolves a single condition', () => {
    expect(resolveRequestedConditions(['none'])).toEqual(['none']);
  });

  it('deduplicates repeated conditions and restores canonical ordering', () => {
    expect(
      resolveRequestedConditions(['preloaded', 'none', 'none', 'stale']),
    ).toEqual(['none', 'preloaded', 'stale']);
  });

  it('expands all when requested by itself', () => {
    expect(resolveRequestedConditions(['all'])).toEqual(SKILL_CONDITIONS);
    expect(resolveRequestedConditions(['all', 'all'])).toEqual(
      SKILL_CONDITIONS,
    );
  });

  it('rejects all when mixed with specific conditions', () => {
    expect(() => resolveRequestedConditions(['all', 'none'])).toThrow(
      '--condition all may not be combined with specific values',
    );
    expect(() => resolveRequestedConditions(['none', 'all'])).toThrow(
      '--condition all may not be combined with specific values',
    );
  });

  it('rejects invalid conditions', () => {
    expect(() => resolveRequestedConditions(['invalid'])).toThrow(
      'Unsupported condition: invalid. Expected one of none, self-load, preloaded, stale, all',
    );
  });
});
