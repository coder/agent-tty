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

import { runRunCommand } from '../../../src/cli/commands/run.js';
import { ERROR_CODES } from '../../../src/protocol/errors.js';
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

type RunCommandOptions = Parameters<typeof runRunCommand>[0];

function createOptions(
  overrides: Partial<RunCommandOptions> = {},
): RunCommandOptions {
  return {
    context: TEST_CONTEXT,
    json: false,
    sessionId: 'session-01',
    text: 'echo hello',
    timeout: 30_000,
    wait: true,
    ...overrides,
  };
}

describe('run command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveCommandTarget.mockResolvedValue(COMMAND_TARGET);
    mocks.resolveCommandInputText.mockResolvedValue('echo hello');
    mocks.sendRpc.mockResolvedValue({
      accepted: true,
      completed: true,
      timedOut: false,
      seq: 42,
      durationMs: 500,
      marker: 'test-marker',
    });
  });

  it('waits for completion by default', async () => {
    await runRunCommand(createOptions());

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-tty/sockets/session-01.sock',
      'run',
      {
        command: 'echo hello',
        noWait: false,
        timeoutMs: 30_000,
      },
      40_000,
    );
    expect(mocks.emitSuccess).toHaveBeenCalledWith({
      command: 'run',
      json: false,
      result: {
        accepted: true,
        completed: true,
        timedOut: false,
        seq: 42,
        durationMs: 500,
        marker: 'test-marker',
      },
      lines: ['Command completed (seq=42, 500ms).'],
    });
  });

  it('supports no-wait execution', async () => {
    mocks.sendRpc.mockResolvedValueOnce({
      accepted: true,
      seq: 10,
    });

    await runRunCommand(createOptions({ wait: false }));

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-tty/sockets/session-01.sock',
      'run',
      {
        command: 'echo hello',
        noWait: true,
      },
      10_000,
    );
    expect(mocks.emitSuccess).toHaveBeenCalledWith({
      command: 'run',
      json: false,
      result: {
        accepted: true,
        seq: 10,
      },
      lines: ['Command injected into session (seq=10).'],
    });
  });

  it('reports the timed-out branch when the host signals a timeout', async () => {
    mocks.sendRpc.mockResolvedValueOnce({
      accepted: true,
      completed: false,
      timedOut: true,
      seq: 17,
      durationMs: 30_000,
      marker: 'test-marker',
    });

    await runRunCommand(createOptions());

    expect(mocks.emitSuccess).toHaveBeenCalledWith({
      command: 'run',
      json: false,
      result: {
        accepted: true,
        completed: false,
        timedOut: true,
        seq: 17,
        durationMs: 30_000,
        marker: 'test-marker',
      },
      lines: ['Command timed out after 30000ms (seq=17).'],
    });
  });

  it('uses the provided timeout for wait mode', async () => {
    await runRunCommand(createOptions({ timeout: 5_000 }));

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-tty/sockets/session-01.sock',
      'run',
      {
        command: 'echo hello',
        noWait: false,
        timeoutMs: 5_000,
      },
      15_000,
    );
  });

  it.each([0, -5])('rejects invalid timeout values (%s)', async (timeout) => {
    await expect(
      runRunCommand(createOptions({ timeout })),
    ).rejects.toMatchObject({
      name: 'CliError',
      code: ERROR_CODES.INVALID_INPUT,
      message: 'Timeout must be a positive integer in milliseconds',
    });
    expect(mocks.resolveCommandTarget).not.toHaveBeenCalled();
    expect(mocks.sendRpc).not.toHaveBeenCalled();
  });

  it('throws PROTOCOL_ERROR for invalid host responses', async () => {
    mocks.sendRpc.mockResolvedValueOnce({ invalid: 'data' });

    await expect(runRunCommand(createOptions())).rejects.toMatchObject({
      name: 'CliError',
      code: ERROR_CODES.PROTOCOL_ERROR,
      message: 'Unexpected response shape from the session host.',
    });
  });

  it('resolves positional text input for run', async () => {
    await runRunCommand(createOptions({ text: 'echo hello' }));

    expect(mocks.resolveCommandInputText).toHaveBeenCalledWith({
      commandName: 'run',
      text: 'echo hello',
      file: undefined,
    });
  });

  it('resolves file-backed input for run', async () => {
    await runRunCommand(
      createOptions({
        text: undefined,
        file: '/tmp/script.sh',
      }),
    );

    expect(mocks.resolveCommandInputText).toHaveBeenCalledWith({
      commandName: 'run',
      text: undefined,
      file: '/tmp/script.sh',
    });
  });
});
