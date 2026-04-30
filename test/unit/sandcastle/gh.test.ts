import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { runJson } from '../../../.sandcastle/lib/gh.js';

const schema = z
  .object({
    value: z.string(),
  })
  .strict();

describe('runJson', () => {
  it('parses JSON stdout through a schema', () => {
    expect(
      runJson('gh', ['issue', 'list'], schema, () => ({
        stdout: '{"value":"ok"}',
        stderr: '',
        status: 0,
      })),
    ).toEqual({ value: 'ok' });
  });

  it('includes the command label in the failure message when the command exits nonzero', () => {
    expect(() =>
      runJson('gh', ['issue', 'list'], schema, () => ({
        stdout: '',
        stderr: 'not authenticated',
        status: 1,
      })),
    ).toThrow(/^gh issue list failed: not authenticated$/u);
  });

  it('uses the supplied command label for non-gh callers', () => {
    expect(() =>
      runJson('coder', ['whoami', '-o', 'json'], schema, () => ({
        stdout: '',
        stderr: 'auth required',
        status: 1,
      })),
    ).toThrow(/^coder whoami -o json failed: auth required$/u);
  });

  it('falls back to the exit status when stderr is empty', () => {
    expect(() =>
      runJson('gh', ['issue', 'list'], schema, () => ({
        stdout: '',
        stderr: '',
        status: 7,
      })),
    ).toThrow(/^gh issue list failed: exit status 7$/u);
  });

  it('throws with the command label when stdout is not parseable JSON', () => {
    // Exercises the JSON.parse catch branch that DEREM-32 flagged as
    // never-tested. `{` triggers SyntaxError inside JSON.parse.
    expect(() =>
      runJson('gh', ['issue', 'list'], schema, () => ({
        stdout: '{',
        stderr: '',
        status: 0,
      })),
    ).toThrow(/gh issue list returned invalid JSON: /u);
  });

  it('throws a Zod validation error when stdout shape does not match the schema', () => {
    // Tighter than a bare .toThrow(): assert the error message contains
    // the Zod-specific shape so a coincidental throw from the runner
    // cannot satisfy this test (DEREM-33).
    expect(() =>
      runJson('gh', ['issue', 'list'], schema, () => ({
        stdout: '{"value":1}',
        stderr: '',
        status: 0,
      })),
    ).toThrow(/expected string.*received number/iu);
  });
});
