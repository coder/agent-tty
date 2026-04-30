import { invariant } from '../../src/util/assert.js';
import { assertIssueNumber } from './issueNumber.js';

/** Compact UTC run ID: YYYYMMDDTHHMMSSZ. */
export const RUN_ID_PATTERN = /^\d{8}T\d{6}Z$/u;

const BRANCH_NAME_PATTERN = /^afk-triage\/\d+-\d{8}T\d{6}Z$/u;

export function assertRunId(value: unknown): string {
  invariant(
    typeof value === 'string' && RUN_ID_PATTERN.test(value),
    'run ID must use compact UTC format YYYYMMDDTHHMMSSZ',
  );

  return value;
}

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
