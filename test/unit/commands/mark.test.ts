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

import { runMarkCommand } from '../../../src/cli/commands/mark.js';
import { createLogger } from '../../../src/util/logger.js';

const TEST_CONTEXT = {
  home: '/tmp/agent-tty',
  timeoutMs: undefined,
  colorEnabled: true,
  logLevel: 'info',
  logger: createLogger('info', () => undefined),
  profileDefault: undefined,
  rendererDefault: 'ghostty-web',
  rendererVisualDefault: 'ghostty-web',
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

describe('mark command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveCommandTarget.mockResolvedValue(COMMAND_TARGET);
    mocks.sendRpc.mockResolvedValue({ seq: 12 });
  });

  it('sends the mark RPC for a command target and emits the committed seq', async () => {
    await runMarkCommand({
      context: TEST_CONTEXT,
      json: false,
      sessionId: 'session-01',
      label: 'checkpoint',
    });

    expect(mocks.resolveCommandTarget).toHaveBeenCalledWith({
      home: '/tmp/agent-tty',
      sessionId: 'session-01',
    });
    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-tty/sockets/session-01.sock',
      'mark',
      { label: 'checkpoint' },
    );
    expect(mocks.emitSuccess).toHaveBeenCalledWith({
      command: 'mark',
      json: false,
      result: { seq: 12 },
      lines: ['Marker set at seq 12.'],
    });
  });

  it('accepts an empty label', async () => {
    mocks.sendRpc.mockResolvedValue({ seq: 7 });

    await runMarkCommand({
      context: TEST_CONTEXT,
      json: false,
      sessionId: 'session-01',
      label: '',
    });

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-tty/sockets/session-01.sock',
      'mark',
      { label: '' },
    );
    expect(mocks.emitSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'mark',
        result: { seq: 7 },
      }),
    );
  });

  it('preserves JSON mode and includes seq in the result envelope', async () => {
    mocks.sendRpc.mockResolvedValue({ seq: 99 });

    await runMarkCommand({
      context: TEST_CONTEXT,
      json: true,
      sessionId: 'session-01',
      label: 'json-marker',
    });

    expect(mocks.emitSuccess).toHaveBeenCalledWith({
      command: 'mark',
      json: true,
      result: { seq: 99 },
      lines: ['Marker set at seq 99.'],
    });
  });

  it('rejects PROTOCOL_ERROR responses without sending success output', async () => {
    mocks.sendRpc.mockResolvedValueOnce({ unexpected: true });

    await expect(
      runMarkCommand({
        context: TEST_CONTEXT,
        json: false,
        sessionId: 'session-01',
        label: 'broken',
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.PROTOCOL_ERROR,
      message: 'Unexpected response from host',
    });
    expect(mocks.emitSuccess).not.toHaveBeenCalled();
  });
});
