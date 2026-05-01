import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  runCommand,
  runCommandAsync,
  runJson,
} from '../../../.sandcastle/lib/gh.js';

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
    expect(() =>
      runJson('gh', ['issue', 'list'], schema, () => ({
        stdout: '{',
        stderr: '',
        status: 0,
      })),
    ).toThrow(/gh issue list returned invalid JSON: /u);
  });

  it('throws a Zod validation error when stdout shape does not match the schema', () => {
    expect(() =>
      runJson('gh', ['issue', 'list'], schema, () => ({
        stdout: '{"value":1}',
        stderr: '',
        status: 0,
      })),
    ).toThrow(/expected string.*received number/iu);
  });
});

describe('runCommand ENOENT handling', () => {
  const missingBinary = 'agent-tty-nonexistent-binary-for-test';

  it('returns a string-typed CommandResult when the binary is missing', () => {
    const result = runCommand(missingBinary, []);
    expect(typeof result.stdout).toBe('string');
    expect(typeof result.stderr).toBe('string');
    expect(typeof result.status).toBe('number');
    expect(result.status).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('runJson surfaces a structured error when the binary is missing', () => {
    expect(() =>
      runJson('coder', ['whoami'], schema, (args) =>
        runCommand(missingBinary, args),
      ),
    ).toThrow(/coder whoami failed: /u);
  });
});

describe('runCommandAsync', () => {
  it('captures stdout from a successful command', async () => {
    const result = await runCommandAsync('node', [
      '-e',
      'process.stdout.write("ok")',
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('ok');
    expect(result.stderr).toBe('');
  });

  it('captures stderr and a non-zero status from a failing command', async () => {
    const result = await runCommandAsync('node', [
      '-e',
      'process.stderr.write("boom"); process.exit(2);',
    ]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('boom');
  });

  it('returns a string-typed CommandResult when the binary is missing', async () => {
    const result = await runCommandAsync(
      'agent-tty-nonexistent-binary-for-async-test',
      [],
    );
    expect(typeof result.stdout).toBe('string');
    expect(typeof result.stderr).toBe('string');
    expect(typeof result.status).toBe('number');
    expect(result.status).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('keeps the event loop responsive while the child runs', async () => {
    let ticks = 0;
    const interval = setInterval(() => {
      ticks += 1;
    }, 5);
    try {
      await runCommandAsync('node', [
        '-e',
        'setTimeout(() => process.exit(0), 100);',
      ]);
    } finally {
      clearInterval(interval);
    }
    expect(ticks).toBeGreaterThanOrEqual(5);
  });
});
