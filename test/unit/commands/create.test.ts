import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { CREATE_FAILED_WATCH_MAX_MS } from '../../../src/config/defaults.js';
import { ERROR_CODES, makeCliError } from '../../../src/protocol/errors.js';
import type { SessionRecord } from '../../../src/protocol/schemas.js';

// The readiness wait ends at a deadline on the monotonic clock. The mocked
// delay moves a fake clock by the time it stands for, so a host that never
// answers reaches that deadline at once.
const clock = vi.hoisted(() => ({ nowMs: 0, delays: 0 }));

const mocks = vi.hoisted(() => ({
  emitSuccess: vi.fn(),
  writeHumanErrorLines: vi.fn(),
  allocateSession: vi.fn(),
  ensureSocketRoot: vi.fn(),
  launchHost: vi.fn(),
  isProcessAlive: vi.fn(),
  stopHost: vi.fn(),
  sendRpc: vi.fn(),
  readManifestIfExists: vi.fn(),
  writeCreateFailedMarker: vi.fn(),
  sessionDir: vi.fn(),
  createFailedMarkerPath: vi.fn(),
  manifestPath: vi.fn(),
  socketPath: vi.fn(),
  upsertHome: vi.fn(),
}));

vi.mock('../../../src/cli/output.js', () => ({
  emitSuccess: mocks.emitSuccess,
  writeHumanErrorLines: mocks.writeHumanErrorLines,
}));

vi.mock('../../../src/host/lifecycle.js', () => ({
  allocateSession: mocks.allocateSession,
  isProcessAlive: mocks.isProcessAlive,
  launchHost: mocks.launchHost,
}));

vi.mock('../../../src/host/socketRoot.js', () => ({
  ensureSocketRoot: mocks.ensureSocketRoot,
}));

vi.mock('node:timers/promises', () => ({
  setTimeout: (ms: number) => {
    clock.nowMs += ms;
    clock.delays += 1;
    // A wait that passes its deadline by this much has no deadline, and a
    // loop of resolved promises would starve the test timeout.
    return clock.delays > 1_000
      ? Promise.reject(new Error('a wait went on past its deadline'))
      : Promise.resolve();
  },
}));

vi.mock('../../../src/host/rpcClient.js', () => ({
  sendRpc: mocks.sendRpc,
}));

vi.mock('../../../src/storage/manifests.js', () => ({
  readManifestIfExists: mocks.readManifestIfExists,
  writeCreateFailedMarker: mocks.writeCreateFailedMarker,
}));

vi.mock('../../../src/storage/sessionPaths.js', () => ({
  createFailedMarkerPath: mocks.createFailedMarkerPath,
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
    clock.nowMs = 0;
    clock.delays = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock.nowMs);
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
    mocks.isProcessAlive.mockReturnValue(true);
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
    mocks.createFailedMarkerPath.mockImplementation(
      (sessionDirectory: string) => `${sessionDirectory}/create-failed`,
    );
    mocks.writeCreateFailedMarker.mockResolvedValue(undefined);
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

  it('when a running host never answers, gives up at the deadline, tells the host to stop and reports the last error', async () => {
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
    expect(clock.nowMs).toBe(30_000);
    expect(mocks.stopHost).toHaveBeenCalledOnce();
    expect(mocks.emitSuccess).not.toHaveBeenCalled();
  });

  it('waits for a host that starts later than 10 s', async () => {
    // 150 polls of 100 ms are 15 s, three times the 50 attempts that gave up
    // on a slow host before.
    mocks.sendRpc.mockImplementation(() =>
      mocks.sendRpc.mock.calls.length <= 150
        ? Promise.reject(
            makeCliError(ERROR_CODES.HOST_UNREACHABLE, {
              message: 'host unreachable',
            }),
          )
        : Promise.resolve({ session: { sessionId: 'session-01' } }),
    );

    await runCreateCommand({ ...baseOptions, context });

    expect(mocks.sendRpc).toHaveBeenCalledTimes(151);
    expect(clock.nowMs).toBe(15_000);
    expect(mocks.emitSuccess).toHaveBeenCalledOnce();
    expect(mocks.writeCreateFailedMarker).not.toHaveBeenCalled();
    expect(mocks.stopHost).not.toHaveBeenCalled();
  });

  it('gives up at once when the host has exited, with the same error', async () => {
    const unreachable = makeCliError(ERROR_CODES.HOST_UNREACHABLE, {
      message: 'host unreachable',
    });
    mocks.sendRpc.mockRejectedValue(unreachable);
    mocks.isProcessAlive.mockReturnValueOnce(true).mockReturnValue(false);

    await expect(
      runCreateCommand({ ...baseOptions, context }),
    ).rejects.toMatchObject({
      code: 'HOST_UNREACHABLE',
      message: 'host unreachable',
      details: { sessionId: 'session-01' },
      cause: unreachable,
    });

    expect(mocks.isProcessAlive).toHaveBeenCalledWith(12345);
    expect(mocks.sendRpc).toHaveBeenCalledTimes(2);
    expect(clock.nowMs).toBe(100);
    expect(mocks.stopHost).toHaveBeenCalledOnce();
  });

  it('gives up at once on a host that exited after a timed-out attempt', async () => {
    mocks.sendRpc.mockRejectedValue(
      makeCliError(ERROR_CODES.HOST_TIMEOUT, {
        message: 'RPC request timed out after 100ms.',
      }),
    );
    mocks.isProcessAlive.mockReturnValue(false);

    await expect(
      runCreateCommand({ ...baseOptions, context }),
    ).rejects.toMatchObject({ code: 'HOST_TIMEOUT' });

    expect(mocks.sendRpc).toHaveBeenCalledOnce();
    expect(clock.nowMs).toBe(0);
  });

  it('reads the manifest after the host check, so a host that exited after it recorded the exit gives a result', async () => {
    mocks.sendRpc.mockRejectedValue(
      makeCliError(ERROR_CODES.HOST_UNREACHABLE, {
        message: 'host unreachable',
      }),
    );
    // The program exits and the host exits. Every write of the host came
    // before its exit, so a manifest read after the host check sees `exited`.
    mocks.isProcessAlive.mockReturnValue(false);
    mocks.readManifestIfExists.mockImplementation(() =>
      Promise.resolve(
        makeManifest({
          status: mocks.isProcessAlive.mock.results.some(
            (result) => result.value === false,
          )
            ? 'exited'
            : 'running',
        }),
      ),
    );

    await runCreateCommand({ ...baseOptions, context });

    expect(mocks.emitSuccess).toHaveBeenCalledOnce();
    expect(mocks.stopHost).not.toHaveBeenCalled();
  });

  describe('when the probe gets EPIPE from a host that closed its server', () => {
    // As sendRpc reports it: RPC_ERROR (retryable), with the socket error as
    // the cause. Only ECONNREFUSED, ENOENT and ECONNRESET become
    // HOST_UNREACHABLE.
    function makeEpipeError() {
      return makeCliError(ERROR_CODES.RPC_ERROR, {
        message: 'write EPIPE',
        details: {
          method: 'inspect',
          socketPath: '/tmp/agent-tty-home/sessions/session-01/rpc.sock',
          timeoutMs: 100,
        },
        cause: Object.assign(new Error('write EPIPE'), {
          code: 'EPIPE',
          syscall: 'write',
        }),
      });
    }

    it('returns the result of a session whose program has exited', async () => {
      mocks.sendRpc.mockRejectedValue(makeEpipeError());
      mocks.isProcessAlive.mockReturnValue(false);
      mocks.readManifestIfExists.mockResolvedValue(
        makeManifest({ status: 'exited' }),
      );

      await runCreateCommand({ ...baseOptions, context });

      expect(mocks.sendRpc).toHaveBeenCalledOnce();
      expect(mocks.emitSuccess).toHaveBeenCalledOnce();
      expect(mocks.writeCreateFailedMarker).not.toHaveBeenCalled();
      expect(mocks.stopHost).not.toHaveBeenCalled();
    });

    it('asks again while the host runs, as for an unreachable host', async () => {
      // The host has closed its server, but its manifest write of the exit
      // has not landed yet. The next poll finds the socket gone.
      mocks.sendRpc.mockImplementation(() =>
        Promise.reject(
          mocks.sendRpc.mock.calls.length === 1
            ? makeEpipeError()
            : makeCliError(ERROR_CODES.HOST_UNREACHABLE, {
                message: 'host unreachable',
              }),
        ),
      );
      // The read after the first probe finds the session running, the read
      // after the second finds it exited.
      mocks.readManifestIfExists.mockImplementation(() =>
        Promise.resolve(
          makeManifest(
            mocks.sendRpc.mock.calls.length >= 2 ? { status: 'exited' } : {},
          ),
        ),
      );

      await runCreateCommand({ ...baseOptions, context });

      expect(mocks.sendRpc).toHaveBeenCalledTimes(2);
      expect(mocks.emitSuccess).toHaveBeenCalledOnce();
      expect(mocks.stopHost).not.toHaveBeenCalled();
    });

    it('fails with the same error when the host has exited and the session has not', async () => {
      const epipe = makeEpipeError();
      mocks.sendRpc.mockRejectedValue(epipe);
      mocks.isProcessAlive.mockReturnValue(false);

      await expect(
        runCreateCommand({ ...baseOptions, context }),
      ).rejects.toMatchObject({
        code: 'RPC_ERROR',
        message: 'write EPIPE',
        retryable: true,
        details: { method: 'inspect', timeoutMs: 100, sessionId: 'session-01' },
        cause: epipe,
      });
      expect(mocks.sendRpc).toHaveBeenCalledOnce();
      expect(mocks.stopHost).toHaveBeenCalledOnce();
    });

    it('gives up at the deadline when the host runs and keeps closing connections', async () => {
      mocks.sendRpc.mockRejectedValue(makeEpipeError());

      await expect(
        runCreateCommand({ ...baseOptions, context }),
      ).rejects.toMatchObject({ code: 'RPC_ERROR', message: 'write EPIPE' });
      expect(clock.nowMs).toBe(30_000);
      expect(mocks.stopHost).toHaveBeenCalledOnce();
    });

    it('fails at once on an RPC_ERROR that is not a closed connection', async () => {
      mocks.sendRpc.mockRejectedValue(
        makeCliError(ERROR_CODES.RPC_ERROR, {
          message: 'RPC response failed schema validation.',
          cause: new Error('invalid response'),
        }),
      );
      mocks.readManifestIfExists.mockResolvedValue(
        makeManifest({ status: 'exited' }),
      );

      await expect(
        runCreateCommand({ ...baseOptions, context }),
      ).rejects.toMatchObject({
        code: 'RPC_ERROR',
        message: 'RPC response failed schema validation.',
      });
      expect(mocks.sendRpc).toHaveBeenCalledOnce();
      expect(clock.nowMs).toBe(0);
    });
  });

  it('writes the create-failed marker before it reads the manifest for the stop', async () => {
    mocks.sendRpc.mockRejectedValue(
      makeCliError(ERROR_CODES.HOST_UNREACHABLE, {
        message: 'host unreachable',
      }),
    );

    await expect(
      runCreateCommand({ ...baseOptions, context }),
    ).rejects.toMatchObject({ code: 'HOST_UNREACHABLE' });

    expect(mocks.writeCreateFailedMarker).toHaveBeenCalledOnce();
    expect(mocks.writeCreateFailedMarker).toHaveBeenCalledWith(
      '/tmp/agent-tty-home/sessions/session-01/create-failed',
      'session-01',
    );
    const markerOrder =
      mocks.writeCreateFailedMarker.mock.invocationCallOrder[0] ?? 0;
    const lastRead = Math.max(
      ...mocks.readManifestIfExists.mock.invocationCallOrder,
    );
    expect(markerOrder).toBeGreaterThan(0);
    expect(markerOrder).toBeLessThan(lastRead);
    expect(mocks.stopHost).toHaveBeenCalledOnce();
  });

  it('keeps the error and still stops the host when the marker write fails', async () => {
    mocks.sendRpc.mockRejectedValue(
      makeCliError(ERROR_CODES.HOST_UNREACHABLE, {
        message: 'host unreachable',
      }),
    );
    mocks.writeCreateFailedMarker.mockRejectedValue(
      makeCliError(ERROR_CODES.STORAGE_WRITE_ERROR, { message: 'disk full' }),
    );

    await expect(
      runCreateCommand({ ...baseOptions, context }),
    ).rejects.toMatchObject({
      code: 'HOST_UNREACHABLE',
      details: { sessionId: 'session-01' },
    });
    expect(mocks.stopHost).toHaveBeenCalledOnce();
  });

  it('leaves no create-failed marker for a create that succeeds', async () => {
    await runCreateCommand({ ...baseOptions, context });

    expect(mocks.writeCreateFailedMarker).not.toHaveBeenCalled();
  });

  it('names the session in text mode when the host never answers', async () => {
    mocks.sendRpc.mockRejectedValue(
      makeCliError(ERROR_CODES.HOST_UNREACHABLE, {
        message: 'host unreachable',
      }),
    );

    await expect(
      runCreateCommand({ ...baseOptions, json: false, context }),
    ).rejects.toMatchObject({ code: 'HOST_UNREACHABLE' });
    expect(mocks.writeHumanErrorLines).toHaveBeenCalledWith([
      'Session session-01 failed to start.',
    ]);
  });

  it('leaves the session line out of JSON mode, where details.sessionId names it', async () => {
    mocks.sendRpc.mockRejectedValue(
      makeCliError(ERROR_CODES.HOST_UNREACHABLE, {
        message: 'host unreachable',
      }),
    );

    await expect(
      runCreateCommand({ ...baseOptions, context }),
    ).rejects.toMatchObject({ details: { sessionId: 'session-01' } });
    expect(mocks.writeHumanErrorLines).not.toHaveBeenCalled();
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

  describe('on Windows, when the marker write fails while the manifest names no program', () => {
    const diskError = makeCliError(ERROR_CODES.STORAGE_WRITE_ERROR, {
      message: 'i/o error',
    });

    beforeEach(() => {
      const platform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      onTestFinished(() => {
        Object.defineProperty(process, 'platform', { value: platform });
      });
      mocks.sendRpc.mockRejectedValue(
        makeCliError(ERROR_CODES.HOST_UNREACHABLE, {
          message: 'host unreachable',
        }),
      );
    });

    it('retries the marker write, and reads the manifest after each write', async () => {
      mocks.writeCreateFailedMarker
        .mockRejectedValueOnce(diskError)
        .mockResolvedValue(undefined);

      await expect(
        runCreateCommand({ ...baseOptions, context }),
      ).rejects.toMatchObject({
        code: 'HOST_UNREACHABLE',
        details: { sessionId: 'session-01' },
      });

      expect(mocks.writeCreateFailedMarker).toHaveBeenCalledTimes(2);
      const lastWrite = Math.max(
        ...mocks.writeCreateFailedMarker.mock.invocationCallOrder,
      );
      const lastRead = Math.max(
        ...mocks.readManifestIfExists.mock.invocationCallOrder,
      );
      expect(lastWrite).toBeLessThan(lastRead);
      expect(mocks.stopHost).not.toHaveBeenCalled();
    });

    it('stops the host once the manifest names the program', async () => {
      mocks.writeCreateFailedMarker.mockRejectedValue(diskError);
      // The read after the third write finds the program.
      mocks.readManifestIfExists.mockImplementation(() =>
        Promise.resolve(
          mocks.writeCreateFailedMarker.mock.calls.length >= 3
            ? makeManifest({ childPid: 4321 })
            : makeManifest(),
        ),
      );

      await expect(
        runCreateCommand({ ...baseOptions, context }),
      ).rejects.toMatchObject({ code: 'HOST_UNREACHABLE' });

      expect(mocks.writeCreateFailedMarker).toHaveBeenCalledTimes(3);
      expect(mocks.stopHost).toHaveBeenCalledOnce();
    });

    it('ends before the host stops watching for its create-failed marker', async () => {
      // The longest create: the readiness wait runs to its deadline, then
      // every marker write fails and is retried while the host runs.
      mocks.writeCreateFailedMarker.mockRejectedValue(diskError);

      await expect(
        runCreateCommand({ ...baseOptions, context }),
      ).rejects.toMatchObject({ code: 'HOST_UNREACHABLE' });

      expect(mocks.writeCreateFailedMarker).toHaveBeenCalledTimes(51);
      expect(clock.nowMs).toBeLessThan(CREATE_FAILED_WATCH_MAX_MS);
    });

    it('gives up after 50 more writes', async () => {
      mocks.writeCreateFailedMarker.mockRejectedValue(diskError);

      await expect(
        runCreateCommand({ ...baseOptions, context }),
      ).rejects.toMatchObject({ code: 'HOST_UNREACHABLE' });

      expect(mocks.writeCreateFailedMarker).toHaveBeenCalledTimes(51);
      expect(mocks.stopHost).not.toHaveBeenCalled();
    });

    it('counts a host probe that throws as an exited host and keeps the error', async () => {
      mocks.writeCreateFailedMarker.mockRejectedValue(diskError);
      // A process of another user that took the host's pid answers EPERM.
      mocks.isProcessAlive.mockImplementation(() => {
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      });

      await expect(
        runCreateCommand({ ...baseOptions, context }),
      ).rejects.toMatchObject({
        code: 'HOST_UNREACHABLE',
        details: { sessionId: 'session-01' },
      });

      expect(mocks.writeCreateFailedMarker).toHaveBeenCalledOnce();
      expect(mocks.stopHost).not.toHaveBeenCalled();
    });

    it('stops retrying once the host has exited', async () => {
      mocks.writeCreateFailedMarker.mockRejectedValue(diskError);
      // The host runs through the readiness wait and exits after the second
      // marker write.
      mocks.isProcessAlive.mockImplementation(
        () => mocks.writeCreateFailedMarker.mock.calls.length < 2,
      );

      await expect(
        runCreateCommand({ ...baseOptions, context }),
      ).rejects.toMatchObject({ code: 'HOST_UNREACHABLE' });

      expect(mocks.isProcessAlive).toHaveBeenCalledWith(12345);
      expect(mocks.writeCreateFailedMarker).toHaveBeenCalledTimes(2);
      expect(mocks.stopHost).not.toHaveBeenCalled();
    });
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

  it('refuses an unsafe socket root before it allocates a session', async () => {
    const unsafe = makeCliError(ERROR_CODES.STORAGE_WRITE_ERROR, {
      message: 'unsafe socket root',
    });
    mocks.ensureSocketRoot.mockRejectedValueOnce(unsafe);

    await expect(runCreateCommand({ ...baseOptions, context })).rejects.toBe(
      unsafe,
    );
    expect(mocks.allocateSession).not.toHaveBeenCalled();
    expect(mocks.launchHost).not.toHaveBeenCalled();
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
