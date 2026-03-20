import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ERROR_CODES } from '../../src/protocol/errors.js';
import {
  DEFAULT_CLI_TIMEOUT_MS,
  cleanupHome,
  createIsolatedHome,
  createSession,
  destroySession,
  runCli,
} from './helpers.js';

interface ErrorEnvelope {
  ok: false;
  command: string;
  timestamp: string;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

function runCliErrorEnvelope(
  args: string[],
  env: Record<string, string>,
  timeout = DEFAULT_CLI_TIMEOUT_MS,
): ErrorEnvelope {
  const result = runCli([...args, '--json'], env, timeout);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout.length).toBeGreaterThan(0);

  const envelope = JSON.parse(result.stdout) as ErrorEnvelope;
  expect(envelope.ok).toBe(false);
  return envelope;
}

describe('renderer error paths e2e', { timeout: 120_000 }, () => {
  let testHome = '';
  let createdSessionIds: string[] = [];

  beforeEach(async () => {
    testHome = await createIsolatedHome();
    createdSessionIds = [];
  });

  afterEach(async () => {
    for (const sessionId of createdSessionIds) {
      destroySession(testHome, sessionId);
    }

    await cleanupHome(testHome);
  });

  it('returns an error for unknown screenshot profiles', () => {
    const sessionId = createSession(testHome);
    createdSessionIds.push(sessionId);

    const envelope = runCliErrorEnvelope(
      ['screenshot', sessionId, '--profile', 'nonexistent-profile'],
      { AGENT_TERMINAL_HOME: testHome },
    );

    expect(envelope.command).toBe('screenshot');
    expect(envelope.error.code).toBe(ERROR_CODES.INVALID_INPUT);
    expect(envelope.error.message).toContain('unknown render profile');
  });

  it('returns an error for snapshot requests after the session has exited', () => {
    const sessionId = createSession(testHome, [
      '/bin/sh',
      '-c',
      'printf done\\n; exit 0',
    ]);
    createdSessionIds.push(sessionId);

    const waitResult = runCli(
      ['wait', sessionId, '--exit', '--timeout', '10000', '--json'],
      { AGENT_TERMINAL_HOME: testHome },
      15_000,
    );
    expect(waitResult.exitCode).toBe(0);
    expect(waitResult.stderr).toBe('');

    const envelope = runCliErrorEnvelope(['snapshot', sessionId], {
      AGENT_TERMINAL_HOME: testHome,
    });

    expect(envelope.command).toBe('snapshot');
    expect(envelope.error.code).toBe(ERROR_CODES.SESSION_NOT_RUNNING);
    expect(envelope.error.message).toContain('is not running');
    expect(envelope.error.details).toMatchObject({
      sessionId,
      status: 'exited',
    });
  });

  it('returns an error for malformed wait regex patterns', () => {
    const sessionId = createSession(testHome);
    createdSessionIds.push(sessionId);

    const envelope = runCliErrorEnvelope(
      ['wait', sessionId, '--regex', '[invalid('],
      { AGENT_TERMINAL_HOME: testHome },
      15_000,
    );

    expect(envelope.command).toBe('wait');
    expect(envelope.error.code).toBe(ERROR_CODES.INVALID_INPUT);
    expect(envelope.error.message).toContain('Invalid regex pattern');
  });

  it('returns an error for mutually exclusive wait text and regex filters', () => {
    const sessionId = createSession(testHome);
    createdSessionIds.push(sessionId);

    const envelope = runCliErrorEnvelope(
      ['wait', sessionId, '--text', 'hello', '--regex', 'world'],
      { AGENT_TERMINAL_HOME: testHome },
    );

    expect(envelope.command).toBe('wait');
    expect(envelope.error.code).toBe(ERROR_CODES.INVALID_INPUT);
    expect(envelope.error.message).toContain('mutually exclusive');
  });

  it('returns an error when mixing legacy and render wait flags', () => {
    const sessionId = createSession(testHome);
    createdSessionIds.push(sessionId);

    const envelope = runCliErrorEnvelope(
      ['wait', sessionId, '--exit', '--text', 'hello'],
      { AGENT_TERMINAL_HOME: testHome },
    );

    expect(envelope.command).toBe('wait');
    expect(envelope.error.code).toBe(ERROR_CODES.INVALID_INPUT);
    expect(envelope.error.message).toContain('Cannot mix legacy wait flags');
  });
});
