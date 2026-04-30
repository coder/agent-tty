import { invariant } from '../../src/util/assert.js';
import { assertIssueNumber } from './issueNumber.js';

const WORKSPACE_NAME_PATTERN = /^agent-tty-triage-\d+$/u;

export function workspaceNameForIssue(issueNumber: number): string {
  const checkedIssueNumber = assertIssueNumber(issueNumber);
  const workspaceName = `agent-tty-triage-${checkedIssueNumber}`;

  invariant(
    WORKSPACE_NAME_PATTERN.test(workspaceName),
    'workspace name must match the AFK triage naming convention',
  );

  return workspaceName;
}
