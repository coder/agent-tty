import { describe, expect, it } from 'vitest';

import {
  parseTimeoutMsOption,
  resolveCommandContext,
} from '../../../src/cli/context.js';
import { ERROR_CODES } from '../../../src/protocol/errors.js';

describe('CLI context resolution', () => {
  it('prefers --home over AGENT_TERMINAL_HOME', () => {
    const context = resolveCommandContext(
      { home: '/tmp/from-flag' },
      { AGENT_TERMINAL_HOME: '/tmp/from-env' },
    );

    expect(context.home).toBe('/tmp/from-flag');
  });

  it('falls back to AGENT_TERMINAL_HOME when --home is absent', () => {
    const context = resolveCommandContext(
      {},
      { AGENT_TERMINAL_HOME: '/tmp/from-env' },
    );

    expect(context.home).toBe('/tmp/from-env');
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
});
