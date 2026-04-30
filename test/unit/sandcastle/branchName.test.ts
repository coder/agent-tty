import { describe, expect, it } from 'vitest';

import { branchNameForIssue } from '../../../.sandcastle/lib/branchName.js';

describe('branchNameForIssue', () => {
  it('builds the triage branch name for an issue and run ID', () => {
    expect(branchNameForIssue(123, '20260430T141500Z')).toBe(
      'afk-triage/123-20260430T141500Z',
    );
  });

  it('rejects an invalid run ID', () => {
    expect(() => branchNameForIssue(123, '2026-04-30T14:15:00Z')).toThrow(
      /compact UTC/u,
    );
  });

  it('rejects an invalid issue number', () => {
    expect(() => branchNameForIssue(0, '20260430T141500Z')).toThrow(
      /positive integer/u,
    );
  });
});
