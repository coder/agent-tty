import { invariant } from '../../src/util/assert.js';

// =============================================================================
// Issue numbers
// =============================================================================

export function assertIssueNumber(value: unknown): number {
  invariant(
    typeof value === 'number' &&
      Number.isFinite(value) &&
      Number.isInteger(value) &&
      value > 0,
    'issue number must be a positive integer',
  );

  return value;
}

// =============================================================================
// Run IDs
// =============================================================================

/** Compact UTC run ID: YYYYMMDDTHHMMSSZ. */
export const RUN_ID_PATTERN = /^\d{8}T\d{6}Z$/u;

export function assertRunId(value: unknown): string {
  invariant(
    typeof value === 'string' && RUN_ID_PATTERN.test(value),
    'run ID must use compact UTC format YYYYMMDDTHHMMSSZ',
  );

  return value;
}

export function createRunId(date = new Date()): string {
  const runId = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(
    date.getUTCDate(),
  )}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(
    date.getUTCSeconds(),
  )}Z`;

  return assertRunId(runId);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

// =============================================================================
// Branch and Coder workspace names
// =============================================================================

const BRANCH_NAME_PATTERN = /^afk-triage\/\d+-\d{8}T\d{6}Z$/u;
const WORKSPACE_NAME_PATTERN = /^agent-tty-triage-\d+$/u;

export function branchNameForIssue(issueNumber: number, runId: string): string {
  const checkedIssueNumber = assertIssueNumber(issueNumber);
  const checkedRunId = assertRunId(runId);
  const branchName = `afk-triage/${checkedIssueNumber}-${checkedRunId}`;

  invariant(
    BRANCH_NAME_PATTERN.test(branchName),
    'branch name must match the AFK triage naming convention',
  );

  return branchName;
}

export function workspaceNameForIssue(issueNumber: number): string {
  const checkedIssueNumber = assertIssueNumber(issueNumber);
  const workspaceName = `agent-tty-triage-${checkedIssueNumber}`;

  invariant(
    WORKSPACE_NAME_PATTERN.test(workspaceName),
    'workspace name must match the AFK triage naming convention',
  );

  return workspaceName;
}

// =============================================================================
// Triage states
// =============================================================================

export const TRIAGE_STATES = [
  'needs-info',
  'ready-for-agent',
  'ready-for-human',
  'wontfix',
  'needs-triage',
] as const;

export type TriageState = (typeof TRIAGE_STATES)[number];

export function isTriageState(value: string): value is TriageState {
  return TRIAGE_STATES.includes(value as TriageState);
}

// =============================================================================
// AFK markers
// =============================================================================

const MARKER_PATTERN =
  /<!--\s*afk-triage:v1\s+issue=(\d+)\s+outcome=([^\s]+)\s+run=([^\s]+)\s*-->/u;

export interface AfkMarker {
  readonly issue: number;
  readonly outcome: TriageState;
  readonly run: string;
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

  if (!RUN_ID_PATTERN.test(runRaw)) {
    return null;
  }

  return {
    issue,
    outcome: outcomeRaw,
    run: runRaw,
  };
}
