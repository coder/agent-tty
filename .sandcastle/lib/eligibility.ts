import { invariant } from '../../src/util/assert.js';
import { parseAfkMarker } from './afkMarker.js';
import { assertIssueNumber } from './issueNumber.js';

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

  const latestMarkerRun = latestAfkMarkerRun(issueNumber, issue.comments);
  if (latestMarkerRun === undefined) {
    return { eligible: true, reason: 'needs-info-with-new-activity' };
  }

  const latestActivity = latestNonAfkActivity(issueNumber, issue.comments);
  if (
    latestActivity !== undefined &&
    latestActivity > runIdToEpochMs(latestMarkerRun)
  ) {
    return { eligible: true, reason: 'needs-info-with-new-activity' };
  }

  return {
    eligible: false,
    reason: 'needs-info has no activity newer than the latest AFK marker',
  };
}

function latestAfkMarkerRun(
  issueNumber: number,
  comments: readonly TriageComment[],
): string | undefined {
  const runs = comments
    .map((comment) => parseAfkMarker(comment.body))
    .filter(
      (marker): marker is NonNullable<typeof marker> =>
        marker !== null && marker.issue === issueNumber,
    )
    .map((marker) => marker.run)
    .sort();

  return runs.at(-1);
}

function latestNonAfkActivity(
  issueNumber: number,
  comments: readonly TriageComment[],
): number | undefined {
  const timestamps = comments
    .filter((comment) => {
      const marker = parseAfkMarker(comment.body);
      return marker === null || marker.issue !== issueNumber;
    })
    .map((comment) => Date.parse(comment.createdAt))
    .filter((timestamp) => Number.isFinite(timestamp))
    .sort((left, right) => left - right);

  return timestamps.at(-1);
}

function runIdToEpochMs(runId: string): number {
  const year = Number(runId.slice(0, 4));
  const month = Number(runId.slice(4, 6));
  const day = Number(runId.slice(6, 8));
  const hour = Number(runId.slice(9, 11));
  const minute = Number(runId.slice(11, 13));
  const second = Number(runId.slice(13, 15));
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second);

  invariant(
    Number.isFinite(timestamp),
    'AFK marker run ID must parse to a date',
  );

  return timestamp;
}
