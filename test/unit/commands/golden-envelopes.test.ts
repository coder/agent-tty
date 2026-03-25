import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildVersionResult } from '../../../src/cli/commands/version.js';
import {
  createErrorEnvelope,
  createSuccessEnvelope,
} from '../../../src/protocol/envelope.js';
import { ERROR_CODES, makeCliError } from '../../../src/protocol/errors.js';
import { InspectResultSchema } from '../../../src/protocol/messages.js';

function createSessionRecord() {
  return {
    version: 1,
    sessionId: 'session-01',
    createdAt: '2026-03-19T12:00:00.000Z',
    updatedAt: '2026-03-19T12:00:01.000Z',
    status: 'exited' as const,
    command: ['/bin/sh', '-lc', 'echo hello'],
    cwd: '/tmp/workspace',
    cols: 80,
    rows: 24,
    hostPid: null,
    childPid: null,
    exitCode: 0,
    exitSignal: null,
  };
}

describe('JSON envelope contracts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-25T15:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('locks the inspect success envelope shape', () => {
    const result = InspectResultSchema.parse({
      session: createSessionRecord(),
      eventCount: 2,
      uptime: 1_000,
      lastEventSeq: 1,
      terminationCategory: 'clean-exit',
      artifacts: {
        total: 2,
        byKind: {
          screenshot: 1,
          snapshot: 1,
        },
        missingCount: 0,
        health: 'healthy',
      },
      usedOfflineReplay: true,
    });

    expect(createSuccessEnvelope('inspect', result)).toEqual({
      ok: true,
      command: 'inspect',
      timestamp: '2026-03-25T15:00:00.000Z',
      result,
    });
  });

  it('locks the version success envelope shape', async () => {
    const result = await buildVersionResult();

    expect(createSuccessEnvelope('version', result)).toEqual({
      ok: true,
      command: 'version',
      timestamp: '2026-03-25T15:00:00.000Z',
      result,
    });
  });

  it('locks the SESSION_NOT_FOUND error envelope shape', () => {
    const error = makeCliError(ERROR_CODES.SESSION_NOT_FOUND, {
      message: 'Session "missing-session" was not found.',
      details: {
        sessionId: 'missing-session',
        manifestPath:
          '/tmp/agent-terminal/sessions/missing-session/session.json',
      },
    });

    expect(
      createErrorEnvelope('inspect', {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: error.details,
      }),
    ).toEqual({
      ok: false,
      command: 'inspect',
      timestamp: '2026-03-25T15:00:00.000Z',
      error: {
        code: 'SESSION_NOT_FOUND',
        message: 'Session "missing-session" was not found.',
        retryable: false,
        details: {
          sessionId: 'missing-session',
          manifestPath:
            '/tmp/agent-terminal/sessions/missing-session/session.json',
        },
      },
    });
  });

  it('locks a retryable transport-style error envelope shape', () => {
    const error = makeCliError(ERROR_CODES.HOST_UNREACHABLE, {
      details: {
        sessionId: 'session-01',
      },
    });

    expect(
      createErrorEnvelope('inspect', {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: error.details,
      }),
    ).toEqual({
      ok: false,
      command: 'inspect',
      timestamp: '2026-03-25T15:00:00.000Z',
      error: {
        code: 'HOST_UNREACHABLE',
        message: 'Session host is unreachable.',
        retryable: true,
        details: {
          sessionId: 'session-01',
        },
      },
    });
  });
});
