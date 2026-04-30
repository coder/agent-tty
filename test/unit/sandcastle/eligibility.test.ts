import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

  describe('AFK_TRIAGE_TRUSTED_MARKER_AUTHORS allow-list', () => {
    let savedValue: string | undefined;

    beforeEach(() => {
      savedValue = process.env.AFK_TRIAGE_TRUSTED_MARKER_AUTHORS;
    });

    afterEach(() => {
      if (savedValue === undefined) {
        delete process.env.AFK_TRIAGE_TRUSTED_MARKER_AUTHORS;
      } else {
        process.env.AFK_TRIAGE_TRUSTED_MARKER_AUTHORS = savedValue;
      }
    });

    const issueWithSpoofedMarker = {
      number: 123,
      labels: ['needs-info'],
      comments: [
        {
          body: 'Reporter follow-up.',
          createdAt: '2026-04-30T14:00:00Z',
          author: { login: 'reporter' },
        },
        {
          // Forged marker by a non-trusted author, post-dating the reporter.
          body: '<!-- afk-triage:v1 issue=123 outcome=needs-info run=20260430T141500Z -->',
          createdAt: '2026-04-30T14:30:00Z',
          author: { login: 'attacker' },
        },
      ],
    };

    it('with the env unset, trusts any author (v1 default)', () => {
      delete process.env.AFK_TRIAGE_TRUSTED_MARKER_AUTHORS;
      expect(classifyIssueForTriage(issueWithSpoofedMarker)).toEqual({
        eligible: false,
        reason: 'needs-info has no activity newer than the latest AFK marker',
      });
    });

    it('with the env set, ignores markers from untrusted authors', () => {
      process.env.AFK_TRIAGE_TRUSTED_MARKER_AUTHORS = 'triage-bot';
      expect(classifyIssueForTriage(issueWithSpoofedMarker)).toEqual({
        // No trusted marker exists, so this needs-info issue is treated as
        // never-AFK-triaged and re-eligible.
        eligible: true,
        reason: 'needs-info-with-new-activity',
      });
    });

    it('with the env set, accepts markers from trusted authors', () => {
      process.env.AFK_TRIAGE_TRUSTED_MARKER_AUTHORS = 'triage-bot, ops-bot';
      expect(
        classifyIssueForTriage({
          number: 123,
          labels: ['needs-info'],
          comments: [
            {
              body: 'Reporter follow-up.',
              createdAt: '2026-04-30T14:00:00Z',
              author: { login: 'reporter' },
            },
            {
              body: '<!-- afk-triage:v1 issue=123 outcome=needs-info run=20260430T143000Z -->',
              createdAt: '2026-04-30T14:30:00Z',
              author: { login: 'triage-bot' },
            },
          ],
        }),
      ).toEqual({
        eligible: false,
        reason: 'needs-info has no activity newer than the latest AFK marker',
      });
    });
  });

  it('does not count GitHub App bot comments as reporter activity', () => {
    // Bot comments (login ending in `[bot]`) on a needs-info issue should
    // never re-trigger triage; otherwise dependabot/github-actions noise
    // would create a Coder workspace per batch for no effect.
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
            body: 'Bumps `vite` from 8.0.7 to 8.0.10.',
            createdAt: '2026-04-30T15:00:00Z',
            author: { login: 'dependabot[bot]' },
          },
          {
            body: 'CI is green now.',
            createdAt: '2026-04-30T15:01:00Z',
            author: { login: 'github-actions[bot]' },
          },
        ],
      }),
    ).toEqual({
      eligible: false,
      reason: 'needs-info has no activity newer than the latest AFK marker',
    });
  });
});
