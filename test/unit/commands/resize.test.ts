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

import { runResizeCommand } from '../../../src/cli/commands/resize.js';
import { createLogger } from '../../../src/util/logger.js';

const TEST_CONTEXT = {
  home: '/tmp/agent-tty',
  timeoutMs: undefined,
  colorEnabled: true,
  logLevel: 'info',
  logger: createLogger('info', () => undefined),
  profileDefault: undefined,
  rendererDefault: 'ghostty-web',
  configFile: null,
} as const;

const COMMAND_TARGET = {
  sessionId: 'session-01',
  sessionDirectory: '/tmp/agent-tty/sessions/session-01',
  manifestPath: '/tmp/agent-tty/sessions/session-01/session.json',
  socketPath: '/tmp/agent-tty/sockets/session-01.sock',
  manifest: { status: 'running' },
};

describe('resize command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveCommandTarget.mockResolvedValue(COMMAND_TARGET);
  });

  it('sends resize dimensions to a command target and emits dimensions', async () => {
    await runResizeCommand({
      context: TEST_CONTEXT,
      json: false,
      sessionId: 'session-01',
      cols: 100,
      rows: 30,
    });

    expect(mocks.resolveCommandTarget).toHaveBeenCalledWith({
      home: '/tmp/agent-tty',
      sessionId: 'session-01',
    });
    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-tty/sockets/session-01.sock',
      'resize',
      { cols: 100, rows: 30 },
    );
    expect(mocks.emitSuccess).toHaveBeenCalledWith({
      command: 'resize',
      json: false,
      result: { cols: 100, rows: 30 },
      lines: ['Resized session to 100x30.'],
    });
  });

  it('rejects invalid dimensions after resolving the command target', async () => {
    await expect(
      runResizeCommand({
        context: TEST_CONTEXT,
        json: false,
        sessionId: 'session-01',
        cols: 0,
        rows: 30,
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_DIMENSIONS,
      message: 'Resize dimensions must be positive integers.',
    });

    expect(mocks.resolveCommandTarget).toHaveBeenCalledWith({
      home: '/tmp/agent-tty',
      sessionId: 'session-01',
    });
    expect(mocks.sendRpc).not.toHaveBeenCalled();
  });
});
