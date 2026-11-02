import process from 'node:process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CliError } from '../../../src/cli/errors.js';

import { emitCliError } from '../../../src/cli/output.js';
import { ERROR_CODES, makeCliError } from '../../../src/protocol/errors.js';

const originalArgv = process.argv;

function emitJsonEnvelope(
  command: string,
  error: CliError,
): Record<string, unknown> {
  process.argv = [...originalArgv, '--json'];
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  emitCliError(command, error);
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
});
