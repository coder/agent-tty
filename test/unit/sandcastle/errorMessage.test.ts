import { describe, expect, it } from 'vitest';

import {
  conciseErrorMessage,
  errorMessage,
  isLockError,
} from '../../../.sandcastle/lib/errorMessage.js';

describe('errorMessage', () => {
  it('returns Error.message for Error instances', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('stringifies non-Error values safely', () => {
    expect(errorMessage('plain string')).toBe('plain string');
    expect(errorMessage(undefined)).toBe('undefined');
    expect(errorMessage({ toString: () => 'object' })).toBe('object');
  });
});

describe('conciseErrorMessage', () => {
  it('returns the trimmed first line', () => {
    expect(conciseErrorMessage(new Error('first\nsecond\nthird'))).toBe(
      'first',
    );
  });

  it('falls back to a default when the first line is empty', () => {
    expect(conciseErrorMessage(new Error(''))).toBe('unknown error');
    expect(conciseErrorMessage(new Error('   \nreal cause'))).toBe(
      'unknown error',
    );
  });
});

describe('isLockError', () => {
  const workspace = 'agent-tty-triage-79';

  it('matches a realistic Coder workspace-conflict message', () => {
    const error = new Error(
      `Error: A workspace named "${workspace}" already exists in your account.`,
    );
    expect(isLockError(error, workspace)).toBe(true);
  });

  it('matches case-insensitively on the workspace name', () => {
    const error = new Error(
      `Workspace ${workspace.toUpperCase()} ALREADY EXISTS in this organization.`,
    );
    expect(isLockError(error, workspace)).toBe(true);
  });

  it('rejects unrelated errors that mention the workspace name without the conflict phrase', () => {
    const error = new Error(
      `ssh dial to ${workspace}.coder failed: connection refused`,
    );
    expect(isLockError(error, workspace)).toBe(false);
  });

  it('rejects "already exists" messages that target a different entity', () => {
    const error = new Error(
      'Error: A template version named "v1" already exists.',
    );
    expect(isLockError(error, workspace)).toBe(false);
  });

  it('rejects multi-line errors when the first line lacks both anchors', () => {
    const error = new Error(
      `network unreachable\nA workspace named "${workspace}" already exists in your account.`,
    );
    expect(isLockError(error, workspace)).toBe(false);
  });

  it('rejects non-Error inputs that do not contain the anchors', () => {
    expect(isLockError('timeout', workspace)).toBe(false);
    expect(isLockError(undefined, workspace)).toBe(false);
  });
});
