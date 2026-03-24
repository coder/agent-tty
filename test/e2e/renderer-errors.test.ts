import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ERROR_CODES } from '../../src/protocol/errors.js';
import { ScreenshotParamsSchema } from '../../src/protocol/messages.js';
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

function repeatCharacter(length: number): string {
  return 'x'.repeat(length);
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

  it('returns an error for screenshot profiles beyond the schema maximum length', () => {
    const sessionId = createSession(testHome);
    createdSessionIds.push(sessionId);
    const oversizedProfile = repeatCharacter(101);
    const profileValidation = ScreenshotParamsSchema.safeParse({
      profile: oversizedProfile,
    });

    const envelope = runCliErrorEnvelope(
      ['screenshot', sessionId, '--profile', oversizedProfile],
      { AGENT_TERMINAL_HOME: testHome },
    );

    expect(profileValidation.success).toBe(false);
    if (profileValidation.success) {
      throw new Error(
        'Oversized screenshot profile should fail schema validation',
      );
    }
    // This assertion is tied to Zod's current error format (v4.x). If Zod is
    // upgraded and the issue shape or message text changes, update this test.
    expect(profileValidation.error.issues).toContainEqual(
      expect.objectContaining({
        code: 'too_big',
        maximum: 100,
        path: ['profile'],
        message: 'Too big: expected string to have <=100 characters',
      }),
    );
    expect(envelope.command).toBe('screenshot');
    expect(envelope.error.code).toBe(ERROR_CODES.INVALID_INPUT);
    expect(envelope.error.message).toBe('Screenshot request is invalid.');
    expect(envelope.error.details).toMatchObject({
      profile: oversizedProfile,
    });
  });

  it('succeeds for snapshot requests after the session has exited', () => {
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

    const result = runCli(['snapshot', sessionId, '--json'], {
      AGENT_TERMINAL_HOME: testHome,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.length).toBeGreaterThan(0);

    const envelope = JSON.parse(result.stdout) as {
      ok: boolean;
      command: string;
      result: {
        format: string;
        sessionId: string;
        capturedAtSeq: number;
      };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe('snapshot');
    expect(envelope.result.format).toBe('structured');
    expect(envelope.result.sessionId).toBe(sessionId);
    expect(typeof envelope.result.capturedAtSeq).toBe('number');
  });

  it('returns an error for wait text beyond the schema maximum length', () => {
    const sessionId = createSession(testHome);
    createdSessionIds.push(sessionId);

    const envelope = runCliErrorEnvelope(
      ['wait', sessionId, '--text', repeatCharacter(1001)],
      { AGENT_TERMINAL_HOME: testHome },
      15_000,
    );

    expect(envelope.command).toBe('wait');
    expect(envelope.error.code).toBe(ERROR_CODES.RPC_ERROR);
    expect(envelope.error.message).toContain('1000');
    expect(envelope.error.message).toContain('text');
  });

  it('returns an error for wait regex beyond the schema maximum length', () => {
    const sessionId = createSession(testHome);
    createdSessionIds.push(sessionId);

    const envelope = runCliErrorEnvelope(
      ['wait', sessionId, '--regex', repeatCharacter(201)],
      { AGENT_TERMINAL_HOME: testHome },
      15_000,
    );

    expect(envelope.command).toBe('wait');
    expect(envelope.error.code).toBe(ERROR_CODES.RPC_ERROR);
    expect(envelope.error.message).toContain('200');
    expect(envelope.error.message).toContain('regex');
  });

  it('returns an error for wait regex patterns with nested quantifiers', () => {
    const sessionId = createSession(testHome);
    createdSessionIds.push(sessionId);

    const envelope = runCliErrorEnvelope(
      ['wait', sessionId, '--regex', '(a+)+'],
      { AGENT_TERMINAL_HOME: testHome },
      15_000,
    );

    expect(envelope.command).toBe('wait');
    expect(envelope.error.code).toBe(ERROR_CODES.INVALID_INPUT);
    expect(envelope.error.message).toContain('nested quantifiers');
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
