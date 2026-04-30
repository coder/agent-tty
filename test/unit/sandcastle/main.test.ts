import { describe, expect, it } from 'vitest';

import {
  buildTriageBatchSummary,
  pLimit,
  parseRunnerArgs,
} from '../../../.sandcastle/main.js';

describe('pLimit', () => {
  it('does not exceed the configured concurrency', async () => {
    const limit = pLimit(2);
    let active = 0;
    let maxActive = 0;

    await Promise.all(
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
});
