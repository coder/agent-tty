import { describe, expect, it } from 'vitest';

import {
  latestAfkMarkerCreatedAt,
  latestReporterActivity,
  loadTrustedMarkerAuthors,
} from '../../../.sandcastle/lib/commentActivity.js';
import type { TriageComment } from '../../../.sandcastle/lib/eligibility.js';

const ISSUE = 123;
const OTHER_ISSUE = 456;

const markerForIssue = (issueNumber: number, runId: string): string =>
  `<!-- afk-triage:v1 issue=${issueNumber} outcome=needs-info run=${runId} -->`;

describe('loadTrustedMarkerAuthors', () => {
  it('returns undefined when the env var is unset', () => {
    expect(loadTrustedMarkerAuthors({})).toBeUndefined();
  });

  it('returns undefined when the env var is empty', () => {
    expect(
      loadTrustedMarkerAuthors({ AFK_TRIAGE_TRUSTED_MARKER_AUTHORS: '' }),
    ).toBeUndefined();
  });

  it('returns undefined when the env var is whitespace-only', () => {
    expect(
      loadTrustedMarkerAuthors({
        AFK_TRIAGE_TRUSTED_MARKER_AUTHORS: '   ',
      }),
    ).toBeUndefined();
  });

  it('returns a single-entry list', () => {
    expect(
      loadTrustedMarkerAuthors({
        AFK_TRIAGE_TRUSTED_MARKER_AUTHORS: 'triage-bot',
      }),
    ).toEqual(['triage-bot']);
  });

  it('parses a comma list with whitespace and drops empties', () => {
    expect(
      loadTrustedMarkerAuthors({
        AFK_TRIAGE_TRUSTED_MARKER_AUTHORS: ' triage-bot , , ops-bot ',
      }),
    ).toEqual(['triage-bot', 'ops-bot']);
  });

  it('returns the empty allow-list when only commas remain after trimming', () => {
    // A non-empty env value that yields no usable entries is "trust no
    // author" — the secure default for an opt-in allow-list. Returning
    // `undefined` here would silently mean "trust everyone" and invert
    // the security posture for a malformed env value.
    expect(
      loadTrustedMarkerAuthors({ AFK_TRIAGE_TRUSTED_MARKER_AUTHORS: ' , , ' }),
    ).toEqual([]);
  });
});

describe('latestAfkMarkerCreatedAt', () => {
  it('returns undefined when there are no comments', () => {
    expect(latestAfkMarkerCreatedAt(ISSUE, [], {})).toBeUndefined();
  });

  it('returns the latest of multiple AFK markers for the same issue', () => {
    const earlier: TriageComment = {
      body: markerForIssue(ISSUE, '20260430T141500Z'),
      createdAt: '2026-04-30T14:15:00Z',
    };
    const later: TriageComment = {
      body: markerForIssue(ISSUE, '20260430T150000Z'),
      createdAt: '2026-04-30T15:00:00Z',
    };

    expect(latestAfkMarkerCreatedAt(ISSUE, [earlier, later], {})).toBe(
      Date.parse('2026-04-30T15:00:00Z'),
    );
  });

  it('ignores AFK markers whose embedded issue number does not match', () => {
    const otherIssueMarker: TriageComment = {
      body: markerForIssue(OTHER_ISSUE, '20260430T150000Z'),
      createdAt: '2026-04-30T15:00:00Z',
    };

    expect(
      latestAfkMarkerCreatedAt(ISSUE, [otherIssueMarker], {}),
    ).toBeUndefined();
  });

  it('respects the trusted-author allow-list', () => {
    const trustedMarker: TriageComment = {
      body: markerForIssue(ISSUE, '20260430T150000Z'),
      createdAt: '2026-04-30T15:00:00Z',
      author: { login: 'triage-bot' },
    };
    const spoofedMarker: TriageComment = {
      body: markerForIssue(ISSUE, '20260430T160000Z'),
      createdAt: '2026-04-30T16:00:00Z',
      author: { login: 'attacker' },
    };

    expect(
      latestAfkMarkerCreatedAt(ISSUE, [trustedMarker, spoofedMarker], {
        trustedMarkerAuthors: ['triage-bot'],
      }),
    ).toBe(Date.parse('2026-04-30T15:00:00Z'));
  });

  it('ignores invalid createdAt timestamps', () => {
    const invalid: TriageComment = {
      body: markerForIssue(ISSUE, '20260430T150000Z'),
      createdAt: 'not a real date',
    };

    expect(latestAfkMarkerCreatedAt(ISSUE, [invalid], {})).toBeUndefined();
  });
});

describe('latestReporterActivity', () => {
  it('ignores comments authored by GitHub Apps (login ending in [bot])', () => {
    const botComment: TriageComment = {
      body: 'Bumps `vite`.',
      createdAt: '2026-04-30T15:00:00Z',
      author: { login: 'dependabot[bot]' },
    };

    expect(latestReporterActivity(ISSUE, [botComment])).toBeUndefined();
  });

  it('ignores AFK markers for the same issue', () => {
    const localMarker: TriageComment = {
      body: markerForIssue(ISSUE, '20260430T150000Z'),
      createdAt: '2026-04-30T15:00:00Z',
    };

    expect(latestReporterActivity(ISSUE, [localMarker])).toBeUndefined();
  });

  it('counts AFK markers for a different issue as activity', () => {
    const otherIssueMarker: TriageComment = {
      body: markerForIssue(OTHER_ISSUE, '20260430T150000Z'),
      createdAt: '2026-04-30T15:00:00Z',
    };

    expect(latestReporterActivity(ISSUE, [otherIssueMarker])).toBe(
      Date.parse('2026-04-30T15:00:00Z'),
    );
  });

  it('returns the latest qualifying timestamp across mixed comments', () => {
    const comments: readonly TriageComment[] = [
      {
        body: 'Reporter follow-up.',
        createdAt: '2026-04-30T14:00:00Z',
        author: { login: 'reporter' },
      },
      {
        body: markerForIssue(ISSUE, '20260430T141500Z'),
        createdAt: '2026-04-30T14:15:00Z',
      },
      {
        body: 'Bumps `vite`.',
        createdAt: '2026-04-30T15:00:00Z',
        author: { login: 'dependabot[bot]' },
      },
      {
        body: 'Another reporter note.',
        createdAt: '2026-04-30T15:30:00Z',
        author: { login: 'reporter' },
      },
    ];

    expect(latestReporterActivity(ISSUE, comments)).toBe(
      Date.parse('2026-04-30T15:30:00Z'),
    );
  });
});
