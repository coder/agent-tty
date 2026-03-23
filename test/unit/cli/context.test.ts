import { describe, expect, it } from 'vitest';

import {
  parseTimeoutMsOption,
  resolveCommandContext,
  resolveLogLevel,
} from '../../../src/cli/context.js';
import { ERROR_CODES } from '../../../src/protocol/errors.js';

const TEST_ENV_HOME = '/tmp/from-env';

describe('CLI context resolution', () => {
  it('prefers --home over AGENT_TERMINAL_HOME', () => {
    const context = resolveCommandContext(
      { home: '/tmp/from-flag' },
      { AGENT_TERMINAL_HOME: TEST_ENV_HOME },
    );

    expect(context.home).toBe('/tmp/from-flag');
  });

  it('falls back to AGENT_TERMINAL_HOME when --home is absent', () => {
    const context = resolveCommandContext(
      {},
      { AGENT_TERMINAL_HOME: TEST_ENV_HOME },
    );

    expect(context.home).toBe(TEST_ENV_HOME);
  });

  it('defaults color-enabled output and respects --no-color', () => {
    expect(resolveCommandContext({}, {}).colorEnabled).toBe(true);
    expect(resolveCommandContext({ color: false }, {}).colorEnabled).toBe(
      false,
    );
  });

  it('preserves an explicit shared timeout', () => {
    expect(resolveCommandContext({ timeoutMs: 2500 }, {}).timeoutMs).toBe(2500);
    expect(resolveCommandContext({}, {}).timeoutMs).toBeUndefined();
  });

  it('resolves logLevel from flag, env, and default precedence', () => {
    expect(resolveCommandContext({}, {}).logLevel).toBe('info');
    expect(
      resolveCommandContext(
        { logLevel: 'warn' },
        { AGENT_TERMINAL_LOG_LEVEL: 'error' },
      ).logLevel,
    ).toBe('warn');
    expect(
      resolveCommandContext({}, { AGENT_TERMINAL_LOG_LEVEL: 'debug' }).logLevel,
    ).toBe('debug');
  });

  it('resolves profileDefault from flag, env, and default precedence', () => {
    expect(resolveCommandContext({}, {}).profileDefault).toBeUndefined();
    expect(
      resolveCommandContext(
        { profileDefault: 'flag-profile' },
        { AGENT_TERMINAL_PROFILE: 'env-profile' },
      ).profileDefault,
    ).toBe('flag-profile');
    expect(
      resolveCommandContext({}, { AGENT_TERMINAL_PROFILE: 'env-profile' })
        .profileDefault,
    ).toBe('env-profile');
  });

  it('rejects a relative --home path', () => {
    expect(() => resolveCommandContext({ home: './relative' }, {})).toThrow(
      expect.objectContaining({
        code: ERROR_CODES.INVALID_INPUT,
        message: '--home must be an absolute path.',
      }),
    );
  });

  it('parses timeout-ms as a non-negative integer', () => {
    expect(parseTimeoutMsOption('0')).toBe(0);
    expect(parseTimeoutMsOption('2500')).toBe(2500);
  });

  it('rejects invalid timeout-ms values', () => {
    expect(() => parseTimeoutMsOption('-1')).toThrow(
      expect.objectContaining({
        code: ERROR_CODES.INVALID_DURATION,
        message: '--timeout-ms must be a non-negative integer.',
      }),
    );
    expect(() => parseTimeoutMsOption('12.5')).toThrow(
      expect.objectContaining({
        code: ERROR_CODES.INVALID_DURATION,
      }),
    );
  });

  it('resolves and validates log levels', () => {
    expect(resolveLogLevel()).toBe('info');
    expect(resolveLogLevel('error')).toBe('error');
    expect(() => resolveLogLevel('trace')).toThrow(
      expect.objectContaining({
        code: ERROR_CODES.INVALID_INPUT,
        message: 'Log level must be one of debug, info, warn, or error.',
      }),
    );
  });
});
