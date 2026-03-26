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

import { runRunCommand } from '../../../src/cli/commands/run.js';
import { ERROR_CODES } from '../../../src/protocol/errors.js';
import { createLogger } from '../../../src/util/logger.js';

const TEST_CONTEXT = {
  home: '/tmp/agent-terminal',
  timeoutMs: undefined,
  colorEnabled: true,
  logLevel: 'info',
  logger: createLogger('info', () => undefined),
  profileDefault: undefined,
  configFile: null,
} as const;

function createSessionRecord(
  status: 'running' | 'exited' | 'destroyed' = 'running',
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
      '/tmp/agent-terminal/sessions/session-01/rpc.sock',
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
      '/tmp/agent-terminal/sessions/session-01/rpc.sock',
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

  it('uses the provided timeout for wait mode', async () => {
    await runRunCommand(createOptions({ timeout: 5_000 }));

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-terminal/sessions/session-01/rpc.sock',
      'run',
      {
        command: 'echo hello',
        noWait: false,
        timeoutMs: 5_000,
      },
      15_000,
    );
  });

  it('throws SESSION_NOT_FOUND when the session does not exist', async () => {
    mocks.readManifestIfExists.mockResolvedValueOnce(null);

    await expect(runRunCommand(createOptions())).rejects.toMatchObject({
      name: 'CliError',
      code: ERROR_CODES.SESSION_NOT_FOUND,
      message: 'Session "session-01" was not found.',
    });
    expect(mocks.sendRpc).not.toHaveBeenCalled();
  });

  it('throws SESSION_NOT_RUNNING when the session is not running', async () => {
    mocks.readManifestIfExists.mockResolvedValueOnce(
      createSessionRecord('exited'),
    );

    await expect(runRunCommand(createOptions())).rejects.toMatchObject({
      name: 'CliError',
      code: ERROR_CODES.SESSION_NOT_RUNNING,
      message: 'Session "session-01" is not running.',
    });
    expect(mocks.sendRpc).not.toHaveBeenCalled();
  });

  it('throws SESSION_ALREADY_DESTROYED when the session is destroyed', async () => {
    mocks.readManifestIfExists.mockResolvedValueOnce(
      createSessionRecord('destroyed'),
    );

    await expect(runRunCommand(createOptions())).rejects.toMatchObject({
      name: 'CliError',
      code: ERROR_CODES.SESSION_ALREADY_DESTROYED,
      message: 'Session "session-01" is already destroyed.',
    });
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
