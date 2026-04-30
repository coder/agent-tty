import { describe, expect, it } from 'vitest';

import { workspaceNameForIssue } from '../../../.sandcastle/lib/workspaceName.js';

describe('workspaceNameForIssue', () => {
  it('builds the Coder workspace name for an issue', () => {
    expect(workspaceNameForIssue(123)).toBe('agent-tty-triage-123');
  });

  it('rejects an invalid issue number', () => {
    expect(() => workspaceNameForIssue(0)).toThrow(/positive integer/u);
  });
});
