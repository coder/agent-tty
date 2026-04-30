import { describe, expect, it } from 'vitest';

import { classifyIssueForTriage } from '../../../.sandcastle/lib/eligibility.js';

describe('classifyIssueForTriage', () => {
  it('marks needs-triage issues as eligible', () => {
    expect(
      classifyIssueForTriage({
        number: 123,
        labels: ['needs-triage'],
        comments: [],
      }),
    ).toEqual({ eligible: true, reason: 'needs-triage' });
  });

  it('marks needs-info issues with no AFK marker as eligible', () => {
    expect(
      classifyIssueForTriage({
        number: 123,
        labels: ['needs-info'],
        comments: [],
      }),
    ).toEqual({
      eligible: true,
      reason: 'needs-info-with-new-activity',
    });
  });

  it('marks needs-info issues with activity newer than the latest AFK marker as eligible', () => {
    expect(
      classifyIssueForTriage({
        number: 123,
        labels: ['needs-info'],
        comments: [
          {
            body: '<!-- afk-triage:v1 issue=123 outcome=needs-info run=20260430T141500Z -->',
            createdAt: '2026-04-30T14:15:00Z',
          },
          {
            body: 'Here is the requested detail.',
            createdAt: '2026-04-30T14:16:00Z',
          },
        ],
      }),
    ).toEqual({
      eligible: true,
      reason: 'needs-info-with-new-activity',
    });
  });

  it('skips needs-info issues without activity newer than the latest marker', () => {
    expect(
      classifyIssueForTriage({
        number: 123,
        labels: ['needs-info'],
        comments: [
          {
            body: 'Earlier activity.',
            createdAt: '2026-04-30T14:14:00Z',
          },
          {
            body: '<!-- afk-triage:v1 issue=123 outcome=needs-info run=20260430T141500Z -->',
            createdAt: '2026-04-30T14:15:00Z',
          },
        ],
      }),
    ).toEqual({
      eligible: false,
      reason: 'needs-info has no activity newer than the latest AFK marker',
    });
  });

  it('skips issues without a target state label', () => {
    expect(
      classifyIssueForTriage({
        number: 123,
        labels: ['bug'],
        comments: [],
      }),
    ).toEqual({
      eligible: false,
      reason: 'issue does not have needs-triage or needs-info',
    });
  });
});
