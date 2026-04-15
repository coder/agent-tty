import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SKILL_CONDITIONS } from '../../../evals/lib/matrix.js';
import {
  parseCliArgs,
  resolveRequestedConditions,
  runEvalCli,
} from '../../../evals/run.js';

function getWrittenStdout(calls: readonly unknown[][]): string {
  return calls
    .map((call) => {
      const [chunk] = call;
      expect(typeof chunk).toBe('string');
      if (typeof chunk !== 'string') {
        throw new Error('expected stdout to be written as a string');
      }
      return chunk;
    })
    .join('');
}

function resolveRepoPath(...segments: string[]): string {
  return resolve(fileURLToPath(new URL('../../..', import.meta.url)), ...segments);
}

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe('runEvalCli dry-run output', () => {
  it('prints the resolved output directory in human-readable output', async () => {
    const stdoutWriteSpy = vi
      .spyOn(process.stdout, 'write')
      .mockReturnValue(true);
    const outputDir = resolveRepoPath('evals', 'reports', 'test-dry-run-human');

    const exitCode = await runEvalCli([
      '--provider',
      'stub',
      '--lane',
      'execution',
      '--case',
      'hello-prompt',
      '--condition',
      'none',
      '--condition',
      'preloaded',
      '--output',
      'evals/reports/test-dry-run-human',
      '--dry-run',
    ]);

    expect(exitCode).toBe(0);
    expect(getWrittenStdout(stdoutWriteSpy.mock.calls as unknown[][])).toContain(
      `Output directory: ${outputDir}\n`,
    );
  });

  it('emits the resolved output directory in the JSON summary', async () => {
    const stdoutWriteSpy = vi
      .spyOn(process.stdout, 'write')
      .mockReturnValue(true);
    const outputDir = resolveRepoPath('evals', 'reports', 'test-dry-run-json');

    const exitCode = await runEvalCli([
      '--provider',
      'stub',
      '--lane',
      'execution',
      '--case',
      'hello-prompt',
      '--condition',
      'none',
      '--condition',
      'preloaded',
      '--output',
      'evals/reports/test-dry-run-json',
      '--dry-run',
      '--json',
    ]);

    expect(exitCode).toBe(0);
    expect(
      JSON.parse(
        getWrittenStdout(stdoutWriteSpy.mock.calls as unknown[][]),
      ) as { outputBaseDir: string },
    ).toMatchObject({ outputBaseDir: outputDir });
  });
});
