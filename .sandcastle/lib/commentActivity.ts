import { parseAfkMarker } from './afkIdentity.js';
import type { TriageComment } from './eligibility.js';

// Unset trusts any marker; set this for bot-only idempotency.
const TRUSTED_MARKER_AUTHORS_ENV = 'AFK_TRIAGE_TRUSTED_MARKER_AUTHORS';

export interface ActivityFilters {
  readonly trustedMarkerAuthors?: readonly string[];
}

/**
 * Parse the comma-separated `AFK_TRIAGE_TRUSTED_MARKER_AUTHORS` allow-list.
 * Returns `undefined` when unset or empty so callers can default to "trust
 * any author" (the v1 behavior). The function never reads `process.env`
 * itself; callers pass an env object so tests do not need to mutate globals.
 */
export function loadTrustedMarkerAuthors(
  env: NodeJS.ProcessEnv,
): readonly string[] | undefined {
  const raw = env[TRUSTED_MARKER_AUTHORS_ENV]?.trim();
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length === 0 ? undefined : entries;
}

/**
 * Use the marker comment timestamp, not the embedded batch-start run ID,
 * because a long-running Triage Batch can post a marker minutes after the
 * run started.
 */
export function latestAfkMarkerCreatedAt(
  issueNumber: number,
  comments: readonly TriageComment[],
  filters: ActivityFilters,
): number | undefined {
  const trusted = filters.trustedMarkerAuthors;
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
 * Latest reporter-side activity on the issue: non-bot, non-AFK-marker
 * comments. AFK markers for *other* issue numbers count as activity here
 * because they are not the local AFK noise the eligibility check is
 * trying to ignore.
 */
export function latestReporterActivity(
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

// GitHub App noise must not re-eligibilize needs-info issues.
function isBotComment(comment: TriageComment): boolean {
  const login = comment.author?.login;
  return typeof login === 'string' && login.endsWith('[bot]');
}
