import { invariant } from '../../src/util/assert.js';
import { assertIssueNumber } from './afkIdentity.js';
import {
  latestAfkMarkerCreatedAt,
  latestReporterActivity,
  loadTrustedMarkerAuthors,
  type ActivityFilters,
} from './commentActivity.js';

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

  const trusted = loadTrustedMarkerAuthors(process.env);
  const filters: ActivityFilters =
    trusted === undefined ? {} : { trustedMarkerAuthors: trusted };

  const latestMarkerCreatedAt = latestAfkMarkerCreatedAt(
    issueNumber,
    issue.comments,
    filters,
  );
  if (latestMarkerCreatedAt === undefined) {
    return { eligible: true, reason: 'needs-info-with-new-activity' };
  }

  const latestActivity = latestReporterActivity(issueNumber, issue.comments);
  if (latestActivity !== undefined && latestActivity > latestMarkerCreatedAt) {
    return { eligible: true, reason: 'needs-info-with-new-activity' };
  }

  return {
    eligible: false,
    reason: 'needs-info has no activity newer than the latest AFK marker',
  };
}
