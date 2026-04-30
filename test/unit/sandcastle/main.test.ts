import { describe, expect, it } from 'vitest';

import {
  buildTriageBatchSummary,
  pLimit,
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
    // Guard against a regression where `limit` resolves with `undefined`,
    // which would silently break runBatch's `Promise.all` of
    // `TriageIssueSummary` records.
    expect(results).toEqual([0, 1, 2, 3, 4]);
  });

  it('rejects when the limited task throws synchronously', async () => {
    const limit = pLimit(1);
    // A non-async function that throws synchronously must surface as a
    // rejection, not crash the runner. Without the wrapping
    // `Promise.resolve().then(task)`, the `.finally()` decrement would
    // be skipped and the concurrency slot would leak permanently.
    await expect(
      limit((() => {
        throw new Error('sync throw');
      }) as unknown as () => Promise<unknown>),
    ).rejects.toThrow('sync throw');

    // The slot must be released so subsequent tasks can run.
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
