import { Command } from 'commander';
import type * as ResolveConfigModule from '../../../src/config/resolveConfig.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadConfigFile: vi.fn(),
}));

vi.mock('../../../src/config/resolveConfig.js', async () => {
  const actual = await vi.importActual<typeof ResolveConfigModule>(
    '../../../src/config/resolveConfig.js',
  );
  return {
    ...actual,
    loadConfigFile: mocks.loadConfigFile,
  };
});

import {
  getCommandContext,
  parseTimeoutMsOption,
  resolveCommandContext,
  resolveLogLevel,
  resolveRendererDefault,
  setCommandContext,
} from '../../../src/cli/context.js';
import { ERROR_CODES } from '../../../src/protocol/errors.js';
import { createLogger } from '../../../src/util/logger.js';

const TEST_ENV_HOME = '/tmp/from-env';
const TEST_FLAG_HOME = '/tmp/from-flag';

describe('CLI context resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfigFile.mockResolvedValue(null);
  });

  it('prefers --home over AGENT_TTY_HOME', async () => {
    const context = await resolveCommandContext(
      { home: TEST_FLAG_HOME },
      { AGENT_TTY_HOME: TEST_ENV_HOME },
    );

    expect(context.home).toBe(TEST_FLAG_HOME);
    expect(context.explicitHome).toBe(true);
  });

  it('falls back to AGENT_TTY_HOME when --home is absent', async () => {
    const context = await resolveCommandContext(
      {},
      { AGENT_TTY_HOME: TEST_ENV_HOME },
    );

    expect(context.home).toBe(TEST_ENV_HOME);
    expect(context.explicitHome).toBe(true);
  });

  it('marks the home as explicit only when --home or AGENT_TTY_HOME is set', async () => {
    // Neither flag nor env → the default Home; gc treats this as the
    // cross-Home sweep trigger.
    await expect(resolveCommandContext({}, {})).resolves.toMatchObject({
      explicitHome: false,
    });
    await expect(
      resolveCommandContext({ home: TEST_FLAG_HOME }, {}),
    ).resolves.toMatchObject({ explicitHome: true });
    await expect(
      resolveCommandContext({}, { AGENT_TTY_HOME: TEST_ENV_HOME }),
    ).resolves.toMatchObject({ explicitHome: true });
  });

  it('loads config files during context resolution', async () => {
    const configFile = {
      logLevel: 'warn',
      defaultProfile: 'config-profile',
      idleTimeoutMs: 1234,
    } as const;
    mocks.loadConfigFile.mockResolvedValue(configFile);

    const context = await resolveCommandContext({ home: TEST_FLAG_HOME }, {});

    expect(mocks.loadConfigFile).toHaveBeenCalledWith(TEST_FLAG_HOME);
    expect(context.configFile).toEqual(configFile);
  });

  it('defaults color-enabled output and respects --no-color', async () => {
    await expect(
      resolveCommandContext({ home: TEST_FLAG_HOME }, {}),
    ).resolves.toMatchObject({ colorEnabled: true });
    await expect(
      resolveCommandContext({ home: TEST_FLAG_HOME, color: false }, {}),
    ).resolves.toMatchObject({ colorEnabled: false });
  });

  it('preserves an explicit shared timeout', async () => {
    await expect(
      resolveCommandContext({ home: TEST_FLAG_HOME, timeoutMs: 2500 }, {}),
    ).resolves.toMatchObject({ timeoutMs: 2500 });
    await expect(
      resolveCommandContext({ home: TEST_FLAG_HOME }, {}),
    ).resolves.toMatchObject({ timeoutMs: undefined });
  });

  it('resolves logLevel from flag, env, config, and default precedence', async () => {
    mocks.loadConfigFile.mockResolvedValue({ logLevel: 'warn' });

    await expect(
      resolveCommandContext({ home: TEST_FLAG_HOME, logLevel: 'error' }, {}),
    ).resolves.toMatchObject({ logLevel: 'error' });
    await expect(
      resolveCommandContext(
        { home: TEST_FLAG_HOME },
        {
          AGENT_TTY_HOME: TEST_ENV_HOME,
          AGENT_TTY_LOG_LEVEL: 'debug',
        },
      ),
    ).resolves.toMatchObject({ logLevel: 'debug' });
    await expect(
      resolveCommandContext({ home: TEST_FLAG_HOME }, {}),
    ).resolves.toMatchObject({ logLevel: 'warn' });

    mocks.loadConfigFile.mockResolvedValue(null);
    await expect(
      resolveCommandContext({ home: TEST_FLAG_HOME }, {}),
    ).resolves.toMatchObject({ logLevel: 'info' });
  });

  it('resolves profileDefault from flag, env, config, and default precedence', async () => {
    mocks.loadConfigFile.mockResolvedValue({
      defaultProfile: 'config-profile',
    });

    await expect(
      resolveCommandContext(
        { home: TEST_FLAG_HOME, profileDefault: 'flag-profile' },
        {},
      ),
    ).resolves.toMatchObject({ profileDefault: 'flag-profile' });
    await expect(
      resolveCommandContext(
        { home: TEST_FLAG_HOME },
        {
          AGENT_TTY_HOME: TEST_ENV_HOME,
          AGENT_TTY_PROFILE: 'env-profile',
        },
      ),
    ).resolves.toMatchObject({ profileDefault: 'env-profile' });
    await expect(
      resolveCommandContext({ home: TEST_FLAG_HOME }, {}),
    ).resolves.toMatchObject({ profileDefault: 'config-profile' });

    mocks.loadConfigFile.mockResolvedValue(null);
    await expect(
      resolveCommandContext({ home: TEST_FLAG_HOME }, {}),
    ).resolves.toMatchObject({ profileDefault: undefined });
  });

  it('resolves rendererDefault from flag, env, config, and default precedence', async () => {
    mocks.loadConfigFile.mockResolvedValue({
      defaultRenderer: 'libghostty-vt',
    });

    await expect(
      resolveCommandContext(
        { home: TEST_FLAG_HOME, renderer: 'ghostty-web' },
        {},
      ),
    ).resolves.toMatchObject({ rendererDefault: 'ghostty-web' });
    await expect(
      resolveCommandContext(
        { home: TEST_FLAG_HOME },
        {
          AGENT_TTY_HOME: TEST_ENV_HOME,
          AGENT_TTY_RENDERER: 'ghostty-web',
        },
      ),
    ).resolves.toMatchObject({ rendererDefault: 'ghostty-web' });
    await expect(
      resolveCommandContext({ home: TEST_FLAG_HOME }, {}),
    ).resolves.toMatchObject({ rendererDefault: 'libghostty-vt' });

    mocks.loadConfigFile.mockResolvedValue(null);
    await expect(
      resolveCommandContext({ home: TEST_FLAG_HOME }, {}),
    ).resolves.toMatchObject({ rendererDefault: 'ghostty-web' });
  });

  it('rejects invalid renderer names', async () => {
    await expect(
      resolveCommandContext({ home: TEST_FLAG_HOME, renderer: 'canvas' }, {}),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT,
      message: 'Renderer must be one of: ghostty-web, libghostty-vt.',
    });
  });

  it('keeps resolving when the config file is missing', async () => {
    mocks.loadConfigFile.mockResolvedValue(null);

    const context = await resolveCommandContext(
      { home: TEST_FLAG_HOME },
      { AGENT_TTY_LOG_LEVEL: 'debug' },
    );

    expect(context.logger.getLevel()).toBe('debug');
    expect(context.logger.shouldLog('debug')).toBe(true);
    expect(context.logLevel).toBe('debug');
    expect(context.configFile).toBeNull();
  });

  it('rejects a relative --home path', async () => {
    await expect(
      resolveCommandContext({ home: './relative' }, {}),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT,
      message: '--home must be an absolute path.',
    });
  });

  it('returns a promise from getCommandContext', async () => {
    const program = new Command();
    const command = program.command('version');
    const cachedContext = Object.freeze({
      home: TEST_FLAG_HOME,
      explicitHome: true,
      timeoutMs: undefined,
      colorEnabled: true,
      logLevel: 'info' as const,
      logger: createLogger('info', () => undefined),
      profileDefault: 'default-profile',
      rendererDefault: 'ghostty-web',
      configFile: null,
    });
    setCommandContext(command, cachedContext);

    const contextPromise = getCommandContext(command);

    expect(contextPromise).toBeInstanceOf(Promise);
    await expect(contextPromise).resolves.toBe(cachedContext);
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

  it('resolves and validates renderer names', () => {
    expect(resolveRendererDefault()).toBe('ghostty-web');
    expect(resolveRendererDefault('libghostty-vt')).toBe('libghostty-vt');
    expect(() => resolveRendererDefault('canvas')).toThrow(
      expect.objectContaining({
        code: ERROR_CODES.INVALID_INPUT,
        message: 'Renderer must be one of: ghostty-web, libghostty-vt.',
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
