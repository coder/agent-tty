import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CliError } from '../../../src/cli/errors.js';
import { ERROR_CODES } from '../../../src/protocol/errors.js';
import {
  MAX_CONSECUTIVE_POLL_FAILURES,
  assertSessionCommandable,
  isSessionCommandable,
  normalizeExitSignal,
  resolveHostRendererName,
} from '../../../src/host/hostMain.js';
import { SessionState } from '../../../src/host/sessionState.js';
import { HOST_RENDERER_ENV_KEY } from '../../../src/config/defaults.js';
import {
  DEFAULT_RENDERER_NAME,
  type RendererName,
} from '../../../src/renderer/names.js';
import type {
  SessionRecord,
  SessionStatus,
} from '../../../src/protocol/schemas.js';

function makeSessionState(status: SessionStatus): SessionState {
  const terminal = status === 'exited' || status === 'failed';
  const record: SessionRecord = {
    version: 1,
    sessionId: 'session-01',
    createdAt: '2026-03-19T12:00:00.000Z',
    updatedAt: '2026-03-19T12:00:01.000Z',
    status,
    command: ['/bin/sh'],
    cwd: '/tmp/workspace',
    cols: 80,
    rows: 24,
    hostPid: terminal ? null : 123,
    childPid: terminal ? null : 456,
    exitCode: status === 'exited' ? 0 : null,
    exitSignal: null,
  };

  return new SessionState(record);
}

describe('waitForRender polling limits', () => {
  it('exports the consecutive renderer failure cap', () => {
    expect(MAX_CONSECUTIVE_POLL_FAILURES).toBe(10);
  });
});

describe('normalizeExitSignal', () => {
  it('maps null to null', () => {
    expect(normalizeExitSignal(null)).toBeNull();
  });

  it('maps 0 to null (a clean exit carries no signal)', () => {
    expect(normalizeExitSignal(0)).toBeNull();
  });

  it('stringifies a positive signal number', () => {
    expect(normalizeExitSignal(9)).toBe('9');
    expect(normalizeExitSignal(15)).toBe('15');
  });

  it('rejects a negative signal', () => {
    expect(() => normalizeExitSignal(-1)).toThrow();
  });

  it('rejects a non-integer signal', () => {
    expect(() => normalizeExitSignal(2.5)).toThrow();
  });
});

describe('isSessionCommandable / assertSessionCommandable', () => {
  it('treats a running session as commandable', () => {
    const state = makeSessionState('running');
    expect(isSessionCommandable(state)).toBe(true);
    expect(() => {
      assertSessionCommandable(state);
    }).not.toThrow();
  });

  it('treats an exiting session as not commandable', () => {
    const state = makeSessionState('exiting');
    expect(isSessionCommandable(state)).toBe(false);
    expect(() => {
      assertSessionCommandable(state);
    }).toThrow(CliError);
  });

  it('treats a terminal (exited) session as not commandable', () => {
    const state = makeSessionState('exited');
    expect(isSessionCommandable(state)).toBe(false);

    try {
      assertSessionCommandable(state);
      expect.unreachable('assertSessionCommandable should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe(ERROR_CODES.SESSION_NOT_RUNNING);
      expect((error as CliError).message).toBe('Session is not running.');
    }
  });
});

describe('resolveHostRendererName', () => {
  // vi.stubEnv tracks and restores process.env so each case starts from a known
  // state and nothing leaks into other tests. Passing undefined clears the var.
  beforeEach(() => {
    vi.stubEnv(HOST_RENDERER_ENV_KEY, undefined);
    vi.stubEnv('AGENT_TTY_RENDERER', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves an explicit input over the environment', () => {
    vi.stubEnv(HOST_RENDERER_ENV_KEY, 'ghostty-web');
    expect(resolveHostRendererName('libghostty-vt')).toBe('libghostty-vt');
  });

  it('falls back to the host renderer env var when input is undefined', () => {
    vi.stubEnv(HOST_RENDERER_ENV_KEY, 'libghostty-vt');
    expect(resolveHostRendererName(undefined)).toBe('libghostty-vt');
  });

  it('falls back to the default renderer when input and env are absent', () => {
    const expected: RendererName = DEFAULT_RENDERER_NAME;
    expect(resolveHostRendererName(undefined)).toBe(expected);
  });

  it('throws INVALID_INPUT for an unknown renderer name', () => {
    try {
      resolveHostRendererName('nope');
      expect.unreachable('resolveHostRendererName should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe(ERROR_CODES.INVALID_INPUT);
    }
  });
});
