import { invariant } from '../../src/util/assert.js';
import { parseAfkMarker } from './afkMarker.js';
import { assertIssueNumber } from './issueNumber.js';

// Unset trusts any marker; set this for bot-only idempotency.
const TRUSTED_MARKER_AUTHORS_ENV = 'AFK_TRIAGE_TRUSTED_MARKER_AUTHORS';

function trustedMarkerAuthors(): readonly string[] | undefined {
  const raw = process.env[TRUSTED_MARKER_AUTHORS_ENV]?.trim();
  if (raw === undefined || raw === '') {
    return undefined;
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export interface TriageComment {
  readonly body: string;
  readonly createdAt: string;
  readonly author?: {
    readonly login?: string;
  };
}

export interface TriageIssue {
  readonly number: number;
  readonly labels: readonly string[];
  readonly comments: readonly TriageComment[];
}

export type IssueEligibility =
  | {
      readonly eligible: true;
      readonly reason: 'needs-triage' | 'needs-info-with-new-activity';
    }
  | {
      readonly eligible: false;
      readonly reason: string;
    };

export function classifyIssueForTriage(issue: TriageIssue): IssueEligibility {
  const issueNumber = assertIssueNumber(issue.number);
  invariant(Array.isArray(issue.labels), 'issue labels must be an array');
  invariant(Array.isArray(issue.comments), 'issue comments must be an array');

  const labels = new Set(issue.labels);

  if (labels.has('needs-triage')) {
    return { eligible: true, reason: 'needs-triage' };
  }

  if (!labels.has('needs-info')) {
    return {
      eligible: false,
      reason: 'issue does not have needs-triage or needs-info',
    };
  }

  const latestMarkerCreatedAt = latestAfkMarkerCreatedAt(
    issueNumber,
    issue.comments,
  );
  if (latestMarkerCreatedAt === undefined) {
    return { eligible: true, reason: 'needs-info-with-new-activity' };
  }

  const latestActivity = latestNonAfkActivity(issueNumber, issue.comments);
  if (latestActivity !== undefined && latestActivity > latestMarkerCreatedAt) {
    return { eligible: true, reason: 'needs-info-with-new-activity' };
  }

  return {
    eligible: false,
    reason: 'needs-info has no activity newer than the latest AFK marker',
  };
}

// Use the marker comment timestamp, not the embedded batch-start run ID.
function latestAfkMarkerCreatedAt(
  issueNumber: number,
  comments: readonly TriageComment[],
): number | undefined {
  const trusted = trustedMarkerAuthors();
  const markerTimestamps = comments
    .filter((comment) => {
      const marker = parseAfkMarker(comment.body);
      if (marker === null || marker.issue !== issueNumber) {
        return false;
      }
      if (trusted === undefined) {
        return true;
      }
      const login = comment.author?.login;
      return typeof login === 'string' && trusted.includes(login);
    })
    .map((comment) => Date.parse(comment.createdAt))
    .filter((timestamp) => Number.isFinite(timestamp))
    .sort((left, right) => left - right);

  return markerTimestamps.at(-1);
}

// GitHub App noise must not re-eligibilize needs-info issues.
function isBotComment(comment: TriageComment): boolean {
  const login = comment.author?.login;
  return typeof login === 'string' && login.endsWith('[bot]');
}

function latestNonAfkActivity(
  issueNumber: number,
  comments: readonly TriageComment[],
): number | undefined {
  const timestamps = comments
    .filter((comment) => {
      if (isBotComment(comment)) {
        return false;
      }
      const marker = parseAfkMarker(comment.body);
      return marker === null || marker.issue !== issueNumber;
    })
    .map((comment) => Date.parse(comment.createdAt))
    .filter((timestamp) => Number.isFinite(timestamp))
    .sort((left, right) => left - right);

  return timestamps.at(-1);
}
