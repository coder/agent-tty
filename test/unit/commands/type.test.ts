import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  emitSuccess: vi.fn(),
  resolveCommandTarget: vi.fn(),
  resolveCommandInputText: vi.fn(),
  sendRpc: vi.fn(),
}));

vi.mock('../../../src/cli/commandTarget.js', () => ({
  resolveCommandTarget: mocks.resolveCommandTarget,
}));

vi.mock('../../../src/cli/output.js', () => ({
  emitSuccess: mocks.emitSuccess,
}));

vi.mock('../../../src/cli/commands/inputSource.js', () => ({
  resolveCommandInputText: mocks.resolveCommandInputText,
}));

vi.mock('../../../src/host/rpcClient.js', () => ({
  sendRpc: mocks.sendRpc,
}));

import { runTypeCommand } from '../../../src/cli/commands/type.js';
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

describe('type command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveCommandTarget.mockResolvedValue(COMMAND_TARGET);
    mocks.resolveCommandInputText.mockResolvedValue('hello');
    mocks.sendRpc.mockResolvedValue({ seq: 7 });
  });

  it('appends exactly one newline to positional text when requested', async () => {
    await runTypeCommand({
      context: TEST_CONTEXT,
      json: false,
      sessionId: 'session-01',
      text: 'hello',
      appendNewline: true,
    });

    expect(mocks.resolveCommandInputText).toHaveBeenCalledWith({
      commandName: 'type',
      text: 'hello',
      file: undefined,
    });
    expect(mocks.resolveCommandTarget).toHaveBeenCalledWith({
      home: '/tmp/agent-tty',
      sessionId: 'session-01',
    });
    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-tty/sockets/session-01.sock',
      'type',
      { text: 'hello\n' },
    );
    expect(mocks.emitSuccess).toHaveBeenCalledWith({
      command: 'type',
      json: false,
      result: { seq: 7 },
      lines: ['Typed text into session at seq 7.'],
    });
  });

  it('appends exactly one newline to file-backed text when requested', async () => {
    mocks.resolveCommandInputText.mockResolvedValueOnce('from-file');

    await runTypeCommand({
      context: TEST_CONTEXT,
      json: false,
      sessionId: 'session-01',
      text: undefined,
      file: '/tmp/input.txt',
      appendNewline: true,
    });

    expect(mocks.resolveCommandInputText).toHaveBeenCalledWith({
      commandName: 'type',
      text: undefined,
      file: '/tmp/input.txt',
    });
    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-tty/sockets/session-01.sock',
      'type',
      { text: 'from-file\n' },
    );
  });

  it('always appends one more newline even when the source already ends with one', async () => {
    mocks.resolveCommandInputText.mockResolvedValueOnce('hello\n');

    await runTypeCommand({
      context: TEST_CONTEXT,
      json: false,
      sessionId: 'session-01',
      text: 'hello\n',
      appendNewline: true,
    });

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-tty/sockets/session-01.sock',
      'type',
      { text: 'hello\n\n' },
    );
  });

  it('sends text unchanged when appendNewline is not set', async () => {
    await runTypeCommand({
      context: TEST_CONTEXT,
      json: false,
      sessionId: 'session-01',
      text: 'hello',
    });

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-tty/sockets/session-01.sock',
      'type',
      { text: 'hello' },
    );
  });

  it('forwards an empty resolved string when appendNewline is enabled', async () => {
    mocks.resolveCommandInputText.mockResolvedValueOnce('');

    await runTypeCommand({
      context: TEST_CONTEXT,
      json: false,
      sessionId: 'session-01',
      text: '',
      appendNewline: true,
    });

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-tty/sockets/session-01.sock',
      'type',
      { text: '\n' },
    );
  });

  it('preserves JSON mode in the success envelope', async () => {
    await runTypeCommand({
      context: TEST_CONTEXT,
      json: true,
      sessionId: 'session-01',
      text: 'hello',
    });

    expect(mocks.emitSuccess).toHaveBeenCalledWith({
      command: 'type',
      json: true,
      result: { seq: 7 },
      lines: ['Typed text into session at seq 7.'],
    });
  });

  it('rejects malformed type RPC responses', async () => {
    mocks.sendRpc.mockResolvedValueOnce({ seq: -1 });

    await expect(
      runTypeCommand({
        context: TEST_CONTEXT,
        json: false,
        sessionId: 'session-01',
        text: 'hello',
      }),
    ).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
      message: 'Unexpected response from host',
    });
    expect(mocks.emitSuccess).not.toHaveBeenCalled();
  });
});
