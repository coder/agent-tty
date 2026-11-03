import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { ERROR_CODES, makeCliError } from '../../../src/protocol/errors.js';
import type { SessionRecord } from '../../../src/protocol/schemas.js';

const mocks = vi.hoisted(() => ({
  emitSuccess: vi.fn(),
  allocateSession: vi.fn(),
  launchHost: vi.fn(),
  stopHost: vi.fn(),
  sendRpc: vi.fn(),
  readManifestIfExists: vi.fn(),
  sessionDir: vi.fn(),
  manifestPath: vi.fn(),
  socketPath: vi.fn(),
  upsertHome: vi.fn(),
}));

vi.mock('../../../src/cli/output.js', () => ({
  emitSuccess: mocks.emitSuccess,
}));

vi.mock('../../../src/host/lifecycle.js', () => ({
  allocateSession: mocks.allocateSession,
  launchHost: mocks.launchHost,
}));

// The readiness loop waits 100 ms between its 50 attempts.
vi.mock('node:timers/promises', () => ({
  setTimeout: () => Promise.resolve(),
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

vi.mock('../../../src/storage/homeRegistry.js', () => ({
  upsertHome: mocks.upsertHome,
}));

import { runCreateCommand } from '../../../src/cli/commands/create.js';
import { createLogger } from '../../../src/util/logger.js';

describe('create command', () => {
  const context = {
    home: '/tmp/agent-tty-home',
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
  const baseOptions = {
    json: true,
    command: ['/bin/sh', '-c', 'echo ready'],
    shellPath: '/bin/bash',
    cwd: '/tmp/workspace',
    cols: 120,
    rows: 40,
    envEntries: [] as string[],
    term: 'vt100',
  };

  function makeManifest(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
      version: 1,
      sessionId: 'session-01',
      createdAt: '2026-03-23T12:00:00.000Z',
      updatedAt: '2026-03-23T12:00:00.000Z',
      status: 'running',
      command: ['/bin/sh', '-c', 'echo ready'],
      cwd: '/tmp/workspace',
      cols: 120,
      rows: 40,
      creationCols: 120,
      creationRows: 40,
      hostPid: null,
      childPid: null,
      exitCode: null,
      exitSignal: null,
      term: 'vt100',
      shell: '/bin/bash',
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.allocateSession.mockImplementation(
      (_config: unknown, launch: (sessionId: string) => number) => {
        launch('session-01');
        return Promise.resolve({
          sessionId: 'session-01',
          sessionDirectory: '/tmp/agent-tty-home/sessions/session-01',
        });
      },
    );
    mocks.launchHost.mockReturnValue({ pid: 12345, stop: mocks.stopHost });
    mocks.sendRpc.mockResolvedValue({ session: { sessionId: 'session-01' } });
    mocks.readManifestIfExists.mockResolvedValue(makeManifest());
    mocks.sessionDir.mockImplementation(
      (_home: string, sessionId: string) =>
        `/tmp/agent-tty-home/sessions/${sessionId}`,
    );
    mocks.manifestPath.mockImplementation(
      (sessionDirectory: string) => `${sessionDirectory}/session.json`,
    );
    mocks.socketPath.mockImplementation(
      (sessionDirectory: string) => `${sessionDirectory}/rpc.sock`,
    );
    mocks.upsertHome.mockResolvedValue(undefined);
  });

  it('registers the resolved Home in the Home Registry on create', async () => {
    await runCreateCommand({ ...baseOptions, context });

    expect(mocks.upsertHome).toHaveBeenCalledWith(context.home);
  });

  it('still succeeds when registering the Home fails (advisory, never blocks create)', async () => {
    mocks.upsertHome.mockRejectedValue(new Error('registry write failed'));

    await expect(
      runCreateCommand({ ...baseOptions, context }),
    ).resolves.toBeUndefined();

    // The Session result is still emitted despite the registry hiccup.
    expect(mocks.emitSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'create' }),
    );
  });

  it('passes home, env, term, name, and shell through session creation', async () => {
    mocks.readManifestIfExists.mockResolvedValue(
      makeManifest({
        env: { FOO: 'bar', BAZ: 'qux' },
        idleTimeoutMs: 5000,
      }),
    );

    await runCreateCommand({
      ...baseOptions,
      context,
      envEntries: ['FOO=bar', 'BAZ=qux'],
      idleTimeoutMs: 5000,
      name: 'demo-session',
    });

    expect(mocks.allocateSession).toHaveBeenCalledWith(
      {
        home: context.home,
        command: ['/bin/sh', '-c', 'echo ready'],
        shellPath: '/bin/bash',
        cwd: '/tmp/workspace',
        cols: 120,
        rows: 40,
        env: { FOO: 'bar', BAZ: 'qux' },
        term: 'vt100',
        idleTimeoutMs: 5000,
        name: 'demo-session',
      },
      expect.any(Function),
    );
    expect(mocks.launchHost).toHaveBeenCalledWith({
      sessionId: 'session-01',
      home: context.home,
      env: { FOO: 'bar', BAZ: 'qux' },
      term: 'vt100',
    });
    expect(mocks.emitSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'create',
        json: true,
        result: {
          sessionId: 'session-01',
          createdAt: '2026-03-23T12:00:00.000Z',
          cols: 120,
          rows: 40,
          shell: '/bin/bash',
          env: { FOO: 'bar', BAZ: 'qux' },
          idleTimeoutMs: 5000,
        },
      }),
    );
  });

  it('falls back to command[0] when the manifest shell is missing', async () => {
    mocks.readManifestIfExists.mockResolvedValue(
      makeManifest({
        shell: undefined,
      }),
    );

    await runCreateCommand({
      ...baseOptions,
      context,
    });

    expect(mocks.emitSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        result: {
          sessionId: 'session-01',
          createdAt: '2026-03-23T12:00:00.000Z',
          cols: 120,
          rows: 40,
          shell: '/bin/sh',
        },
      }),
    );
  });

  it('removes the session folder when the host fails to launch', async () => {
    const sessionDirectory = await mkdtemp(join(tmpdir(), 'agent-tty-create-'));
    onTestFinished(() =>
      rm(sessionDirectory, { recursive: true, force: true }),
    );
    mocks.sessionDir.mockReturnValue(sessionDirectory);
    mocks.launchHost.mockImplementation(() => {
      throw new Error('spawn failed');
    });

    await expect(
      runCreateCommand({ ...baseOptions, context }),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'spawn failed',
    });
    expect(existsSync(sessionDirectory)).toBe(false);
  });

  it('emits the enriched result when the session exits before inspect becomes ready', async () => {
    mocks.sendRpc.mockRejectedValue(
      makeCliError(ERROR_CODES.HOST_UNREACHABLE, {
        message: 'host unreachable',
      }),
    );
    mocks.readManifestIfExists.mockResolvedValue(
      makeManifest({
        status: 'exited',
        env: { FOO: 'bar' },
        idleTimeoutMs: 2500,
      }),
    );

    await runCreateCommand({
      ...baseOptions,
      context,
    });

    expect(mocks.emitSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        result: {
          sessionId: 'session-01',
          createdAt: '2026-03-23T12:00:00.000Z',
          cols: 120,
          rows: 40,
          shell: '/bin/bash',
          env: { FOO: 'bar' },
          idleTimeoutMs: 2500,
        },
      }),
    );
  });

  it('when the host never answers, tells the host to stop and reports the last error', async () => {
    const unreachable = makeCliError(ERROR_CODES.HOST_UNREACHABLE, {
      message: 'host unreachable',
    });
    mocks.sendRpc.mockRejectedValue(unreachable);
    mocks.readManifestIfExists.mockResolvedValue(makeManifest());

    await expect(
      runCreateCommand({ ...baseOptions, context }),
    ).rejects.toMatchObject({
      code: 'HOST_UNREACHABLE',
      message: 'host unreachable',
      retryable: true,
      details: { sessionId: 'session-01' },
      cause: unreachable,
    });
    expect(mocks.sendRpc).toHaveBeenCalledTimes(50);
    expect(mocks.stopHost).toHaveBeenCalledOnce();
    expect(mocks.emitSuccess).not.toHaveBeenCalled();
  });

  it('keeps the details of the last error and adds the session id', async () => {
    mocks.sendRpc.mockRejectedValue(
      makeCliError(ERROR_CODES.HOST_TIMEOUT, {
        message: 'RPC request timed out after 1000ms.',
        details: { method: 'inspect', timeoutMs: 1000 },
      }),
    );

    await expect(
      runCreateCommand({ ...baseOptions, context }),
    ).rejects.toMatchObject({
      code: 'HOST_TIMEOUT',
      details: { method: 'inspect', timeoutMs: 1000, sessionId: 'session-01' },
    });
    expect(mocks.stopHost).toHaveBeenCalledOnce();
  });

  it('stops the host when the manifest is gone after the host answered', async () => {
    mocks.readManifestIfExists.mockResolvedValue(null);

    await expect(
      runCreateCommand({ ...baseOptions, context }),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      details: { sessionId: 'session-01' },
    });
    expect(mocks.stopHost).toHaveBeenCalledOnce();
    expect(mocks.emitSuccess).not.toHaveBeenCalled();
  });

  it('stops the host when the manifest read fails while the host does not answer', async () => {
    mocks.sendRpc.mockRejectedValue(
      makeCliError(ERROR_CODES.HOST_UNREACHABLE, {
        message: 'host unreachable',
      }),
    );
    mocks.readManifestIfExists.mockRejectedValue(
      makeCliError(ERROR_CODES.STORAGE_READ_ERROR, {
        message: 'manifest unreadable',
      }),
    );

    await expect(
      runCreateCommand({ ...baseOptions, context }),
    ).rejects.toMatchObject({
      code: 'STORAGE_READ_ERROR',
      message: 'manifest unreadable',
      details: { sessionId: 'session-01' },
    });
    expect(mocks.sendRpc).toHaveBeenCalledOnce();
    expect(mocks.stopHost).toHaveBeenCalledOnce();
  });

  it('stops the host on an error that is not a CliError and reports it as INTERNAL_ERROR', async () => {
    const failure = new TypeError('socket path broke');
    mocks.sendRpc.mockRejectedValue(failure);

    await expect(
      runCreateCommand({ ...baseOptions, context }),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'socket path broke',
      details: { sessionId: 'session-01' },
      cause: failure,
    });
    expect(mocks.sendRpc).toHaveBeenCalledOnce();
    expect(mocks.stopHost).toHaveBeenCalledOnce();
  });

  it('on Windows, stops a host that never answers only once the manifest names its program', async () => {
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    onTestFinished(() => {
      Object.defineProperty(process, 'platform', { value: platform });
    });
    const unreachable = makeCliError(ERROR_CODES.HOST_UNREACHABLE, {
      message: 'host unreachable',
    });
    const failure = { code: 'HOST_UNREACHABLE', cause: unreachable };
    mocks.sendRpc.mockRejectedValue(unreachable);

    mocks.readManifestIfExists.mockResolvedValue(makeManifest());
    await expect(
      runCreateCommand({ ...baseOptions, context }),
    ).rejects.toMatchObject(failure);
    expect(mocks.stopHost).not.toHaveBeenCalled();

    mocks.readManifestIfExists.mockResolvedValue(null);
    await expect(
      runCreateCommand({ ...baseOptions, context }),
    ).rejects.toMatchObject(failure);
    expect(mocks.stopHost).not.toHaveBeenCalled();

    mocks.readManifestIfExists.mockResolvedValue(
      makeManifest({ childPid: 4321 }),
    );
    await expect(
      runCreateCommand({ ...baseOptions, context }),
    ).rejects.toMatchObject(failure);
    expect(mocks.stopHost).toHaveBeenCalledOnce();
  });

  it('on Windows, applies the same rule to an error that is not a readiness error', async () => {
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    onTestFinished(() => {
      Object.defineProperty(process, 'platform', { value: platform });
    });
    const failure = new TypeError('socket path broke');
    mocks.sendRpc.mockRejectedValue(failure);

    mocks.readManifestIfExists.mockResolvedValue(makeManifest());
    await expect(
      runCreateCommand({ ...baseOptions, context }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR', cause: failure });
    expect(mocks.stopHost).not.toHaveBeenCalled();

    mocks.readManifestIfExists.mockResolvedValue(
      makeManifest({ childPid: 4321 }),
    );
    await expect(
      runCreateCommand({ ...baseOptions, context }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR', cause: failure });
    expect(mocks.stopHost).toHaveBeenCalledOnce();
  });

  it('leaves a host that answers alone', async () => {
    await runCreateCommand({ ...baseOptions, context });

    expect(mocks.emitSuccess).toHaveBeenCalledOnce();
    expect(mocks.stopHost).not.toHaveBeenCalled();
  });

  it('passes idle timeout through allocation when provided explicitly', async () => {
    await runCreateCommand({
      ...baseOptions,
      context,
      idleTimeoutMs: 5000,
    });

    expect(mocks.allocateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        idleTimeoutMs: 5000,
      }),
      expect.any(Function),
    );
  });

  it('falls back to the configured idle timeout when no flag is provided', async () => {
    await runCreateCommand({
      ...baseOptions,
      context: {
        ...context,
        configFile: {
          idleTimeoutMs: 1234,
        },
      },
    });

    expect(mocks.allocateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        idleTimeoutMs: 1234,
      }),
      expect.any(Function),
    );
  });

  it('accepts an idle timeout of 0 without persisting it to allocation metadata', async () => {
    await runCreateCommand({
      ...baseOptions,
      context,
      idleTimeoutMs: 0,
    });

    expect(mocks.allocateSession).toHaveBeenCalledTimes(1);
    expect(mocks.allocateSession.mock.calls[0]?.[0]).not.toHaveProperty(
      'idleTimeoutMs',
    );
  });

  it('rejects negative idle timeout values before allocating a session', async () => {
    await expect(
      runCreateCommand({
        ...baseOptions,
        context,
        idleTimeoutMs: -1,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: '--idle-timeout-ms must be a non-negative integer.',
    });

    expect(mocks.allocateSession).not.toHaveBeenCalled();
    expect(mocks.launchHost).not.toHaveBeenCalled();
  });

  it('rejects malformed env entries before allocating a session', async () => {
    await expect(
      runCreateCommand({
        ...baseOptions,
        context,
        envEntries: ['MALFORMED'],
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: '--env must use KEY=VALUE format, got: MALFORMED',
    });

    expect(mocks.allocateSession).not.toHaveBeenCalled();
    expect(mocks.launchHost).not.toHaveBeenCalled();
  });
});
