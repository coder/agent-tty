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

import { runSendKeysCommand } from '../../../src/cli/commands/send-keys.js';
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

describe('send-keys command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveCommandTarget.mockResolvedValue(COMMAND_TARGET);
    mocks.sendRpc.mockResolvedValue({
      accepted: ['Enter'],
      bytesWritten: 1,
      seq: 12,
    });
  });

  it('sends encoded key names to a command target and emits host results', async () => {
    await runSendKeysCommand({
      context: TEST_CONTEXT,
      json: false,
      sessionId: 'session-01',
      keys: ['Enter'],
    });

    expect(mocks.resolveCommandTarget).toHaveBeenCalledWith({
      home: '/tmp/agent-tty',
      sessionId: 'session-01',
    });
    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-tty/sockets/session-01.sock',
      'sendKeys',
      { keys: ['Enter'] },
    );
    expect(mocks.emitSuccess).toHaveBeenCalledWith({
      command: 'send-keys',
      json: false,
      result: {
        accepted: ['Enter'],
        bytesWritten: 1,
        seq: 12,
      },
      lines: ['Sent 1 key(s) (1 byte(s), seq 12).'],
    });
  });

  it('rejects PROTOCOL_ERROR responses without sending success output', async () => {
    mocks.sendRpc.mockResolvedValueOnce({ unexpected: true });

    await expect(
      runSendKeysCommand({
        context: TEST_CONTEXT,
        json: false,
        sessionId: 'session-01',
        keys: ['Enter'],
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.PROTOCOL_ERROR,
      message: 'Unexpected response from host',
    });
    expect(mocks.emitSuccess).not.toHaveBeenCalled();
  });
});
