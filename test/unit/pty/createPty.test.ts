import { describe, expect, it } from 'vitest';

import { resolvePtyEnv } from '../../../src/pty/createPty.js';

describe('resolvePtyEnv', () => {
  it('defaults PROMPT_EOL_MARK to empty when the caller does not set it', () => {
    const resolved = resolvePtyEnv({}, 'xterm-256color', {});

    expect(resolved.PROMPT_EOL_MARK).toBe('');
  });

  it('lets a caller-supplied PROMPT_EOL_MARK win, including an explicit empty one', () => {
    expect(
      resolvePtyEnv({ PROMPT_EOL_MARK: '%' }, 'xterm-256color', {})
        .PROMPT_EOL_MARK,
    ).toBe('%');
    expect(
      resolvePtyEnv({ PROMPT_EOL_MARK: '' }, 'xterm-256color', {})
        .PROMPT_EOL_MARK,
    ).toBe('');
  });

  it('overrides an inherited PROMPT_EOL_MARK when the caller does not set it', () => {
    const resolved = resolvePtyEnv({}, 'xterm-256color', {
      PROMPT_EOL_MARK: '%',
    });

    expect(resolved.PROMPT_EOL_MARK).toBe('');
  });

  it('keeps an inherited PROMPT_EOL_MARK only when the caller re-supplies it', () => {
    const resolved = resolvePtyEnv({ PROMPT_EOL_MARK: '%B%S%#%s%b' }, 'vt100', {
      PROMPT_EOL_MARK: 'stale',
    });

    expect(resolved.PROMPT_EOL_MARK).toBe('%B%S%#%s%b');
  });

  it('always forces TERM to the provided value over inherited and caller env', () => {
    const resolved = resolvePtyEnv({ TERM: 'caller' }, 'vt100', {
      TERM: 'inherited',
    });

    expect(resolved.TERM).toBe('vt100');
  });

  it('passes through inherited and caller env entries and drops undefined values', () => {
    const resolved = resolvePtyEnv({ FOO: 'bar' }, 'xterm-256color', {
      BAZ: 'qux',
      EMPTY: undefined,
    });

    expect(resolved.FOO).toBe('bar');
    expect(resolved.BAZ).toBe('qux');
    expect(Object.prototype.hasOwnProperty.call(resolved, 'EMPTY')).toBe(false);
  });
});
