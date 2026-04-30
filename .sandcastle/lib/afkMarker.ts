import { invariant } from '../../src/util/assert.js';
import { assertRunId } from './branchName.js';
import { assertIssueNumber } from './issueNumber.js';

export type TriageState =
  | 'needs-info'
  | 'ready-for-agent'
  | 'ready-for-human'
  | 'wontfix'
  | 'needs-triage';

/**
 * Canonical set of valid AFK Triage state labels. Exported so dependent
 * modules (e.g. `labelInvariants.ts`) can reuse the single source of truth
 * instead of duplicating the membership check.
 */
export const TRIAGE_STATES = new Set<TriageState>([
  'needs-info',
  'ready-for-agent',
  'ready-for-human',
  'wontfix',
  'needs-triage',
]);

const MARKER_PATTERN =
  /<!--\s*afk-triage:v1\s+issue=(\d+)\s+outcome=([^\s]+)\s+run=([^\s]+)\s*-->/u;

export interface AfkMarker {
  readonly issue: number;
  readonly outcome: TriageState;
  readonly run: string;
}

export function isTriageState(value: string): value is TriageState {
  return TRIAGE_STATES.has(value as TriageState);
}

/**
 * Round-trip companion to {@link parseAfkMarker}.
 *
 * At runtime AFK markers are emitted by the in-workspace Claude agent, which
 * follows `MARKER_PATTERN` from the triage prompt. This formatter is the
 * canonical machine-generated form and exists primarily to give
 * `parseAfkMarker` a partner the test suite can round-trip against, so the
 * regex and the prompt's documented format cannot drift apart silently.
 * Keep it exported so external tooling (future AFK-triage reapers, dogfood
 * scripts) can reuse the same canonical form when it eventually needs to
 * post markers without going through Claude.
 */
export function formatAfkMarker(input: AfkMarker): string {
  const issue = assertIssueNumber(input.issue);
  invariant(isTriageState(input.outcome), 'AFK marker outcome is invalid');
  const run = assertRunId(input.run);

  return `<!-- afk-triage:v1 issue=${issue} outcome=${input.outcome} run=${run} -->`;
}

export function parseAfkMarker(comment: string): AfkMarker | null {
  const match = MARKER_PATTERN.exec(comment);
  if (match === null) {
    return null;
  }

  const [, issueRaw, outcomeRaw, runRaw] = match;
  invariant(issueRaw !== undefined, 'AFK marker issue capture must exist');
  invariant(outcomeRaw !== undefined, 'AFK marker outcome capture must exist');
  invariant(runRaw !== undefined, 'AFK marker run capture must exist');

  const issue = Number(issueRaw);
  if (!Number.isInteger(issue) || issue <= 0) {
    return null;
  }

  if (!isTriageState(outcomeRaw)) {
    return null;
  }

  if (!isValidRunId(runRaw)) {
    return null;
  }

  return {
    issue,
    outcome: outcomeRaw,
    run: runRaw,
  };
}

function isValidRunId(value: string): boolean {
  try {
    assertRunId(value);
    return true;
  } catch {
    return false;
  }
}
