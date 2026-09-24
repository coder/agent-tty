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

  it('strips host-only renderer defaults from inherited env', () => {
    const resolved = resolvePtyEnv({}, 'xterm-256color', {
      AGENT_TTY_HOST_RENDERER: 'libghostty-vt',
      AGENT_TTY_RENDERER: 'ghostty-web',
    });

    expect(resolved.AGENT_TTY_HOST_RENDERER).toBeUndefined();
    expect(resolved.AGENT_TTY_RENDERER).toBe('ghostty-web');
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

  it('sets AGENT_TTY_ACTIVE and AGENT_TTY_SESSION_ID when sessionId is provided', () => {
    const resolved = resolvePtyEnv(
      {},
      'xterm-256color',
      {},
      'test-session-123',
    );
    expect(resolved.AGENT_TTY_ACTIVE).toBe('true');
    expect(resolved.AGENT_TTY_SESSION_ID).toBe('test-session-123');
  });

  it('sets no session variables when sessionId is not provided', () => {
    const resolved = resolvePtyEnv({}, 'xterm-256color', {});
    expect(
      Object.prototype.hasOwnProperty.call(resolved, 'AGENT_TTY_ACTIVE'),
    ).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(resolved, 'AGENT_TTY_SESSION_ID'),
    ).toBe(false);
  });

  it('strips inherited outer session variables when sessionId is not provided', () => {
    const resolved = resolvePtyEnv({}, 'xterm-256color', {
      AGENT_TTY_ACTIVE: 'true',
      AGENT_TTY_SESSION_ID: 'outer-session',
      OTHER: 'kept',
    });

    expect(
      Object.prototype.hasOwnProperty.call(resolved, 'AGENT_TTY_ACTIVE'),
    ).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(resolved, 'AGENT_TTY_SESSION_ID'),
    ).toBe(false);
    expect(resolved.OTHER).toBe('kept');
  });

  it('lets caller-supplied env set session variables when sessionId is not provided', () => {
    const resolved = resolvePtyEnv(
      { AGENT_TTY_ACTIVE: 'custom', AGENT_TTY_SESSION_ID: 'custom-id' },
      'xterm-256color',
      { AGENT_TTY_ACTIVE: 'true', AGENT_TTY_SESSION_ID: 'outer-session' },
    );

    expect(resolved.AGENT_TTY_ACTIVE).toBe('custom');
    expect(resolved.AGENT_TTY_SESSION_ID).toBe('custom-id');
  });

  it('rejects an empty sessionId', () => {
    expect(() => resolvePtyEnv({}, 'xterm-256color', {}, '')).toThrow(
      /sessionId must be non-empty/,
    );
  });

  it('replaces an inherited outer session id with the session id', () => {
    const resolved = resolvePtyEnv(
      {},
      'xterm-256color',
      { AGENT_TTY_ACTIVE: 'outer', AGENT_TTY_SESSION_ID: 'outer-session' },
      'inner-session',
    );

    expect(resolved.AGENT_TTY_ACTIVE).toBe('true');
    expect(resolved.AGENT_TTY_SESSION_ID).toBe('inner-session');
  });

  it('lets caller-supplied env override the injected session variables', () => {
    const resolved = resolvePtyEnv(
      { AGENT_TTY_ACTIVE: 'custom', AGENT_TTY_SESSION_ID: 'custom-id' },
      'xterm-256color',
      { AGENT_TTY_SESSION_ID: 'outer-session' },
      'inner-session',
    );

    expect(resolved.AGENT_TTY_ACTIVE).toBe('custom');
    expect(resolved.AGENT_TTY_SESSION_ID).toBe('custom-id');
  });

  it('lets an explicit empty caller value override the injected session variables', () => {
    const resolved = resolvePtyEnv(
      { AGENT_TTY_ACTIVE: '', AGENT_TTY_SESSION_ID: '' },
      'xterm-256color',
      {},
      'inner-session',
    );

    expect(resolved.AGENT_TTY_ACTIVE).toBe('');
    expect(resolved.AGENT_TTY_SESSION_ID).toBe('');
  });
});
