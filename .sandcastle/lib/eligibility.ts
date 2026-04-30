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

/**
 * Epoch-ms `createdAt` of the most recent AFK-marker comment for this issue.
 *
 * Compared to the previous implementation, which used the marker's embedded
 * `run` ID as the cutoff: that ID encodes the batch start time on the
 * orchestrator host, but the marker comment is posted minutes later, after
 * workspace creation, agent startup, and triage. Reporter comments arriving
 * between batch-start and marker-posted were misclassified as "new
 * activity" and triggered unnecessary re-triage. Using the marker comment's
 * GitHub `createdAt` is a single time source on the same clock as the
 * comments we compare against.
 */
function latestAfkMarkerCreatedAt(
  issueNumber: number,
  comments: readonly TriageComment[],
): number | undefined {
  const markerTimestamps = comments
    .filter((comment) => {
      const marker = parseAfkMarker(comment.body);
      return marker !== null && marker.issue === issueNumber;
    })
    .map((comment) => Date.parse(comment.createdAt))
    .filter((timestamp) => Number.isFinite(timestamp))
    .sort((left, right) => left - right);

  return markerTimestamps.at(-1);
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
