import { invariant } from '../../src/util/assert.js';
import { assertRunId } from './branchName.js';
import { assertIssueNumber } from './issueNumber.js';

export type TriageState =
  | 'needs-info'
  | 'ready-for-agent'
  | 'ready-for-human'
  | 'wontfix'
  | 'needs-triage';

const TRIAGE_STATES = new Set<TriageState>([
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

  if (!assertRunIdOrNull(runRaw)) {
    return null;
  }

  return {
    issue,
    outcome: outcomeRaw,
    run: runRaw,
  };
}

function assertRunIdOrNull(value: string): boolean {
  try {
    assertRunId(value);
    return true;
  } catch {
    return false;
  }
}
