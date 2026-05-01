import { CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';

import { pLimit } from '../../../.sandcastle/lib/pLimit.js';
import {
  buildTriageBatchSummary,
  parseRunnerArgs,
} from '../../../.sandcastle/main.js';

describe('pLimit', () => {
  it('does not exceed the configured concurrency and returns each task result', async () => {
    const limit = pLimit(2);
    let active = 0;
    let maxActive = 0;

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        limit(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await Promise.resolve();
          active -= 1;
          return index;
        }),
      ),
    );

    expect(maxActive).toBeLessThanOrEqual(2);
    expect(results).toEqual([0, 1, 2, 3, 4]);
  });

  it('rejects when the limited task throws synchronously', async () => {
    const limit = pLimit(1);
    await expect(
      limit((() => {
        throw new Error('sync throw');
      }) as unknown as () => Promise<unknown>),
    ).rejects.toThrow('sync throw');

    await expect(limit(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });
});

describe('buildTriageBatchSummary', () => {
  it('counts totals and sorts per-issue records deterministically', () => {
    expect(
      buildTriageBatchSummary('20260430T141500Z', [
        { issueNumber: 3, status: 'failed', message: 'boom' },
        { issueNumber: 1, status: 'success' },
        { issueNumber: 2, status: 'skipped', message: 'dry-run' },
        { issueNumber: 4, status: 'locked', message: 'exists' },
      ]),
    ).toEqual({
      runId: '20260430T141500Z',
      totals: {
        success: 1,
        locked: 1,
        failed: 1,
        skipped: 1,
      },
      perIssue: [
        { issueNumber: 1, status: 'success' },
        { issueNumber: 2, status: 'skipped', message: 'dry-run' },
        { issueNumber: 3, status: 'failed', message: 'boom' },
        { issueNumber: 4, status: 'locked', message: 'exists' },
      ],
    });
  });
});

describe('parseRunnerArgs', () => {
  it('returns defaults when no flags or env are set', () => {
    expect(parseRunnerArgs([], {})).toEqual({
      parallelism: 5,
      includeNeedsInfo: true,
      dryRun: false,
    });
  });

  it('parses CLI flags and env defaults', () => {
    expect(parseRunnerArgs(['--dry-run'], { TRIAGE_PARALLELISM: '7' })).toEqual(
      {
        parallelism: 7,
        includeNeedsInfo: true,
        dryRun: true,
      },
    );

    expect(
      parseRunnerArgs(['--parallelism=2', '--no-include-needs-info'], {}),
    ).toEqual({
      parallelism: 2,
      includeNeedsInfo: false,
      dryRun: false,
    });
  });

  it('accepts space-separated --parallelism N (commander default)', () => {
    expect(parseRunnerArgs(['--parallelism', '3'], {})).toEqual({
      parallelism: 3,
      includeNeedsInfo: true,
      dryRun: false,
    });
  });

  it('CLI --parallelism overrides TRIAGE_PARALLELISM env', () => {
    expect(
      parseRunnerArgs(['--parallelism=4'], { TRIAGE_PARALLELISM: '9' }),
    ).toEqual({
      parallelism: 4,
      includeNeedsInfo: true,
      dryRun: false,
    });
  });

  it('throws a CommanderError for unknown flags', () => {
    expect(() => parseRunnerArgs(['--bogus'], {})).toThrow(CommanderError);
  });

  it('throws a CommanderError when --parallelism is missing its value', () => {
    expect(() => parseRunnerArgs(['--parallelism'], {})).toThrow(
      CommanderError,
    );
  });
});
