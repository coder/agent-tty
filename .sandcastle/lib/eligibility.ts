import { invariant } from '../../src/util/assert.js';
import { parseAfkMarker } from './afkMarker.js';
import { assertIssueNumber } from './issueNumber.js';

/**
 * Optional comma-separated allow-list of trusted GitHub authors whose
 * AFK-triage markers count for idempotency. When unset (the v1 default),
 * any author can post a syntactically valid `<!-- afk-triage:v1 ... -->`
 * marker and the eligibility module trusts it; this is acceptable for v1
 * controlled dogfood because the attack surface is narrow (marker must
 * post-date the reporter's reply on a `needs-info` issue, a single new
 * reporter comment re-enables eligibility, and the Coder template TTL
 * bounds operational cost). Production deployments should set
 * `AFK_TRIAGE_TRUSTED_MARKER_AUTHORS=triage-bot` (or similar) so only
 * markers from the dedicated bot identity gate idempotency.
 */
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
 *
 * Author trust: when `AFK_TRIAGE_TRUSTED_MARKER_AUTHORS` is set, only
 * markers whose `author.login` is on that list count. When it is unset
 * (v1 default for controlled dogfood), all syntactically valid markers
 * count — see {@link TRUSTED_MARKER_AUTHORS_ENV} for the documented
 * trade-off.
 */
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

/**
 * GitHub Apps emit comments under logins suffixed `[bot]` (dependabot[bot],
 * github-actions[bot], codecov[bot], etc.). For idempotency these must
 * NOT count as reporter activity, otherwise routine bot noise on a
 * `needs-info` issue would re-trigger triage every batch and create a
 * Coder workspace per false positive.
 */
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
      // Skip bot comments so dependabot/github-actions/codecov noise on a
      // needs-info issue does not falsely re-eligibilize it.
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
