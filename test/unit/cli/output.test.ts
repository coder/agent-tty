import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliError } from '../../../src/cli/errors.js';
import type * as OutputModule from '../../../src/cli/output.js';

import { ERROR_CODES, makeCliError } from '../../../src/protocol/errors.js';

const originalArgv = process.argv;
let output: typeof OutputModule;

beforeEach(async () => {
  vi.resetModules();
  output = await import('../../../src/cli/output.js');
});

function emitJsonEnvelope(
  command: string,
  error: CliError,
): Record<string, unknown> {
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  output.emitCliError(command, error, true);
  const calls = write.mock.calls.map(([chunk]) => String(chunk));
  write.mockRestore();
  expect(calls).toHaveLength(1);
  return JSON.parse(calls[0] ?? '') as Record<string, unknown>;
}

describe('emitCliError', () => {
  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = undefined;
  });

  it('copies the error result into the JSON error envelope', () => {
    const envelope = emitJsonEnvelope(
      'wait',
      makeCliError(ERROR_CODES.WAIT_TIMEOUT, {
        details: { sessionId: 'session-01', timeoutMs: 1000 },
        result: { matched: false, timedOut: true, capturedAtSeq: 7 },
      }),
    );

    expect(envelope).toMatchObject({
      ok: false,
      command: 'wait',
      error: {
        code: 'WAIT_TIMEOUT',
        retryable: false,
        details: { sessionId: 'session-01', timeoutMs: 1000 },
      },
      result: { matched: false, timedOut: true, capturedAtSeq: 7 },
    });
    expect(process.exitCode).toBe(11);
  });

  it('omits result when the error carries none', () => {
    const envelope = emitJsonEnvelope(
      'inspect',
      makeCliError(ERROR_CODES.SESSION_NOT_FOUND),
    );

    expect(envelope.ok).toBe(false);
    expect(envelope).not.toHaveProperty('result');
    expect(process.exitCode).toBe(3);
  });

  it('writes the error to stderr when a JSON envelope is already on stdout', () => {
    process.argv = [...originalArgv, '--json'];
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    output.emitSuccess({
      command: 'version',
      json: true,
      result: { cliVersion: '0.0.0' },
      lines: [],
    });
    output.emitCliError(
      'version',
      makeCliError(ERROR_CODES.SESSION_NOT_FOUND, { message: 'late error' }),
      true,
    );
    const stdoutCalls = stdout.mock.calls.map(([chunk]) => String(chunk));
    const stderrCalls = stderr.mock.calls.map(([chunk]) => String(chunk));
    stdout.mockRestore();
    stderr.mockRestore();

    expect(stdoutCalls).toHaveLength(1);
    expect(JSON.parse(stdoutCalls[0] ?? '')).toMatchObject({ ok: true });
    expect(stderrCalls).toEqual(['SESSION_NOT_FOUND: late error\n']);
    expect(process.exitCode).toBe(3);
  });
});

describe('writeHumanErrorLines', () => {
  it('writes the lines to stderr, without color when color is off', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    output.setColorEnabled(false);
    output.writeHumanErrorLines([
      '\u001b[31mSession s-1\u001b[0m failed.',
      'next',
    ]);
    const stderrCalls = stderr.mock.calls.map(([chunk]) => String(chunk));
    const stdoutCalls = stdout.mock.calls.length;
    stderr.mockRestore();
    stdout.mockRestore();

    expect(stderrCalls).toEqual(['Session s-1 failed.\nnext\n']);
    expect(stdoutCalls).toBe(0);
  });
});

describe('argvHasFlag', () => {
  afterEach(() => {
    process.argv = originalArgv;
  });

  it('finds a flag only before the first --', () => {
    process.argv = ['node', 'main.ts', '--no-color', 'create', '--json'];
    expect(output.argvHasFlag('--no-color')).toBe(true);
    expect(output.argvHasFlag('--json')).toBe(true);

    process.argv = ['node', 'main.ts', 'create', '--', 'sh', '--no-color'];
    expect(output.argvHasFlag('--no-color')).toBe(false);
  });
});
