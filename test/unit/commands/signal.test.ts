import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ERROR_CODES } from '../../../src/protocol/errors.js';

const mocks = vi.hoisted(() => ({
  emitSuccess: vi.fn(),
  resolveCommandTarget: vi.fn(),
  sendRpc: vi.fn(),
}));

vi.mock('../../../src/cli/commandTarget.js', () => ({
  resolveCommandTarget: mocks.resolveCommandTarget,
}));

vi.mock('../../../src/cli/output.js', () => ({
  emitSuccess: mocks.emitSuccess,
}));

vi.mock('../../../src/host/rpcClient.js', () => ({
  sendRpc: mocks.sendRpc,
}));

import { runSignalCommand } from '../../../src/cli/commands/signal.js';
import { createLogger } from '../../../src/util/logger.js';

const TEST_CONTEXT = {
  home: '/tmp/agent-tty',
  timeoutMs: undefined,
  colorEnabled: true,
  logLevel: 'info',
  logger: createLogger('info', () => undefined),
  profileDefault: undefined,
  rendererDefault: 'ghostty-web',
  explicitHome: false,
  configFile: null,
} as const;

const COMMAND_TARGET = {
  sessionId: 'session-01',
  sessionDirectory: '/tmp/agent-tty/sessions/session-01',
  manifestPath: '/tmp/agent-tty/sessions/session-01/session.json',
  socketPath: '/tmp/agent-tty/sockets/session-01.sock',
  manifest: { status: 'running' },
};

describe('signal command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveCommandTarget.mockResolvedValue(COMMAND_TARGET);
  });

  it('sends an allowed signal to a command target and emits delivery', async () => {
    await runSignalCommand({
      context: TEST_CONTEXT,
      json: false,
      sessionId: 'session-01',
      signal: 'SIGUSR1',
    });

    expect(mocks.resolveCommandTarget).toHaveBeenCalledWith({
      home: '/tmp/agent-tty',
      sessionId: 'session-01',
    });
    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-tty/sockets/session-01.sock',
      'signal',
      { signal: 'SIGUSR1' },
    );
    expect(mocks.emitSuccess).toHaveBeenCalledWith({
      command: 'signal',
      json: false,
      result: { signal: 'SIGUSR1', delivered: true },
      lines: ['Signal SIGUSR1 delivered to session.'],
    });
  });

  it('rejects invalid signals after resolving the command target', async () => {
    await expect(
      runSignalCommand({
        context: TEST_CONTEXT,
        json: false,
        sessionId: 'session-01',
        signal: 'BAD',
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_SIGNAL,
      message:
        'Signal must be one of: SIGTERM, SIGINT, SIGKILL, SIGHUP, SIGUSR1, SIGUSR2.',
    });

    expect(mocks.resolveCommandTarget).toHaveBeenCalledWith({
      home: '/tmp/agent-tty',
      sessionId: 'session-01',
    });
    expect(mocks.sendRpc).not.toHaveBeenCalled();
  });
});
