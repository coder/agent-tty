import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  emitSuccess: vi.fn(),
  sendRpc: vi.fn(),
  readManifestIfExists: vi.fn(),
  sessionDir: vi.fn(),
  manifestPath: vi.fn(),
  socketPath: vi.fn(),
  resolveCommandInputText: vi.fn(),
}));

vi.mock('../../../src/cli/output.js', () => ({
  emitSuccess: mocks.emitSuccess,
}));

vi.mock('../../../src/host/rpcClient.js', () => ({
  sendRpc: mocks.sendRpc,
}));

vi.mock('../../../src/storage/manifests.js', () => ({
  readManifestIfExists: mocks.readManifestIfExists,
}));

vi.mock('../../../src/storage/sessionPaths.js', () => ({
  sessionDir: mocks.sessionDir,
  manifestPath: mocks.manifestPath,
  socketPath: mocks.socketPath,
}));

vi.mock('../../../src/cli/commands/inputSource.js', () => ({
  resolveCommandInputText: mocks.resolveCommandInputText,
}));

import { runTypeCommand } from '../../../src/cli/commands/type.js';

const TEST_CONTEXT = {
  home: '/tmp/agent-terminal',
  timeoutMs: undefined,
  colorEnabled: true,
  logLevel: 'info',
  profileDefault: undefined,
  configFile: null,
} as const;

function createSessionRecord(
  status: 'running' | 'exiting' | 'exited' = 'running',
) {
  return {
    version: 1,
    sessionId: 'session-01',
    createdAt: '2026-03-19T12:00:00.000Z',
    updatedAt: '2026-03-19T12:00:01.000Z',
    status,
    command: ['/bin/sh'],
    cwd: '/tmp/workspace',
    cols: 80,
    rows: 24,
    hostPid: status === 'running' ? 123 : null,
    childPid: status === 'running' ? 456 : null,
    exitCode: status === 'exited' ? 0 : null,
    exitSignal: null,
  };
}

describe('type command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionDir.mockImplementation(
      (_home: string, sessionId: string) =>
        `/tmp/agent-terminal/sessions/${sessionId}`,
    );
    mocks.manifestPath.mockImplementation(
      (sessionDirectory: string) => `${sessionDirectory}/session.json`,
    );
    mocks.socketPath.mockImplementation(
      (sessionDirectory: string) => `${sessionDirectory}/rpc.sock`,
    );
    mocks.readManifestIfExists.mockResolvedValue(
      createSessionRecord('running'),
    );
    mocks.resolveCommandInputText.mockResolvedValue('hello');
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
    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-terminal/sessions/session-01/rpc.sock',
      'type',
      { text: 'hello\n' },
    );
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
      '/tmp/agent-terminal/sessions/session-01/rpc.sock',
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
      '/tmp/agent-terminal/sessions/session-01/rpc.sock',
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
      '/tmp/agent-terminal/sessions/session-01/rpc.sock',
      'type',
      { text: 'hello' },
    );
  });

  it('allows empty resolved text when appendNewline is enabled', async () => {
    mocks.resolveCommandInputText.mockResolvedValueOnce('');

    await runTypeCommand({
      context: TEST_CONTEXT,
      json: false,
      sessionId: 'session-01',
      text: '',
      appendNewline: true,
    });

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-terminal/sessions/session-01/rpc.sock',
      'type',
      { text: '\n' },
    );
  });
});
