import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { setImmediate as setImmediatePromise } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostRendererManager } from '../../../src/host/renderer.js';
import type { RendererBackend } from '../../../src/renderer/backend.js';
import type {
  RenderProfileConfig,
  ReplayInput,
} from '../../../src/renderer/types.js';

import {
  createFakeBackend,
  type FakeRendererBackend,
} from '../../helpers/fakeBackend.js';

function createProfile(name = 'default'): RenderProfileConfig {
  return {
    name,
    theme: 'dark',
    fontFamily: 'Fira Code',
    fontSize: 14,
    cursorStyle: 'block',
    backgroundColor: '#000000',
    foregroundColor: '#ffffff',
  };
}

function createReplayInput(overrides: Partial<ReplayInput> = {}): ReplayInput {
  return {
    sessionId: 'session-01',
    initialCols: 80,
    initialRows: 24,
    events: [
      {
        seq: 0,
        ts: '2026-03-20T12:00:00.000Z',
        type: 'output',
        payload: { data: 'hello world' },
      },
    ],
    targetSeq: 0,
    ...overrides,
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushAsyncQueue(): Promise<void> {
  await setImmediatePromise();
}

function getCreatedBackend(
  backends: FakeRendererBackend[],
  index: number,
): FakeRendererBackend {
  const backend = backends[index];
  expect(backend).toBeDefined();

  if (backend === undefined) {
    throw new Error(`expected backend ${String(index)} to exist`);
  }

  return backend;
}

type BackendFactory = (
  rendererName: 'ghostty-web' | 'libghostty-vt',
  sessionId: string,
  profile: RenderProfileConfig,
) => RendererBackend;

describe('HostRendererManager', () => {
  let sessionDir: string;
  let backends: FakeRendererBackend[];
  let backendFactory: ReturnType<typeof vi.fn<BackendFactory>>;

  beforeEach(async () => {
    // oxfmt-ignore
    sessionDir = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-renderer-')));
    backends = [];
    backendFactory = vi.fn(() => {
      const backend = createFakeBackend();
      backends.push(backend);
      return backend;
    });
  });

  afterEach(async () => {
    await rm(sessionDir, { recursive: true, force: true });
  });

  it('lazily boots exactly once across concurrent getBackend calls', async () => {
    const manager = new HostRendererManager({
      sessionId: 'session-01',
      sessionDir,
      backendFactory,
    });
    const bootDeferred = createDeferred<undefined>();

    backendFactory.mockImplementationOnce(() => {
      const backend = createFakeBackend({
        bootImplementation: () =>
          bootDeferred.promise.then(() => {
            backend.setBooted(true);
          }),
      });
      backends.push(backend);
      return backend;
    });

    const first = manager.getBackend('ghostty-web', createProfile(), null);
    const second = manager.getBackend('ghostty-web', createProfile(), null);

    await flushAsyncQueue();

    expect(backendFactory).toHaveBeenCalledTimes(1);
    expect(getCreatedBackend(backends, 0).bootMock).toHaveBeenCalledTimes(1);

    bootDeferred.resolve(undefined);

    const [firstBackend, secondBackend] = await Promise.all([first, second]);

    expect(firstBackend).toBe(secondBackend);
    expect(getCreatedBackend(backends, 0).bootMock).toHaveBeenCalledTimes(1);
  });

  it('reuses the backend for repeated requests with the same profile name', async () => {
    const manager = new HostRendererManager({
      sessionId: 'session-01',
      sessionDir,
      backendFactory,
    });

    const firstBackend = await manager.getBackend(
      'ghostty-web',
      createProfile(),
      null,
    );
    const secondBackend = await manager.getBackend(
      'ghostty-web',
      createProfile(),
      null,
    );

    expect(firstBackend).toBe(secondBackend);
    expect(backendFactory).toHaveBeenCalledTimes(1);
  });

  it('disposes and recreates the backend when the profile name changes', async () => {
    const manager = new HostRendererManager({
      sessionId: 'session-01',
      sessionDir,
      backendFactory,
    });

    const firstBackend = await manager.getBackend(
      'ghostty-web',
      createProfile('dark'),
      null,
    );
    const secondBackend = await manager.getBackend(
      'ghostty-web',
      createProfile('light'),
      null,
    );

    expect(secondBackend).not.toBe(firstBackend);
    expect(backendFactory).toHaveBeenCalledTimes(2);
    expect(getCreatedBackend(backends, 0).disposeMock).toHaveBeenCalledTimes(1);
    expect(getCreatedBackend(backends, 1)).toBe(secondBackend);
  });

  it('recreates the backend when the renderer name changes', async () => {
    const manager = new HostRendererManager({
      sessionId: 'session-01',
      sessionDir,
      backendFactory,
    });

    const firstBackend = await manager.getBackend(
      'ghostty-web',
      createProfile('dark'),
      null,
    );
    const secondBackend = await manager.getBackend(
      'libghostty-vt',
      createProfile('dark'),
      null,
    );

    expect(secondBackend).not.toBe(firstBackend);
    expect(backendFactory).toHaveBeenCalledTimes(2);
    expect(getCreatedBackend(backends, 0).disposeMock).toHaveBeenCalledTimes(1);
    expect(getCreatedBackend(backends, 1)).toBe(secondBackend);
  });

  it('keeps a backend leased until the operation completes', async () => {
    const manager = new HostRendererManager({
      sessionId: 'session-01',
      sessionDir,
      backendFactory,
    });
    const operationStarted = createDeferred<undefined>();
    const releaseOperation = createDeferred<undefined>();

    const firstOperation = manager.withBackend(
      'libghostty-vt',
      createProfile('dark'),
      null,
      async () => {
        operationStarted.resolve(undefined);
        await releaseOperation.promise;
        return 'leased';
      },
    );
    await operationStarted.promise;

    const replacementOperation = manager.withBackend(
      'ghostty-web',
      createProfile('dark'),
      null,
      (backend) => backend.rendererBackend,
    );
    await flushAsyncQueue();

    expect(backendFactory).toHaveBeenCalledTimes(1);
    expect(getCreatedBackend(backends, 0).disposeMock).not.toHaveBeenCalled();

    releaseOperation.resolve(undefined);

    await expect(firstOperation).resolves.toBe('leased');
    await expect(replacementOperation).resolves.toBe('fake-renderer');
    expect(backendFactory).toHaveBeenCalledTimes(2);
    expect(getCreatedBackend(backends, 0).disposeMock).toHaveBeenCalledTimes(1);
  });

  it('skips replay when the replay target sequence is -1', async () => {
    const manager = new HostRendererManager({
      sessionId: 'session-01',
      sessionDir,
      backendFactory,
    });

    await manager.getBackend(
      'ghostty-web',
      createProfile(),
      createReplayInput({ events: [], targetSeq: -1 }),
    );

    expect(getCreatedBackend(backends, 0).replayToMock).not.toHaveBeenCalled();
  });

  it('replays to the requested target sequence when replay input is provided', async () => {
    const manager = new HostRendererManager({
      sessionId: 'session-01',
      sessionDir,
      backendFactory,
    });
    const replayInput = createReplayInput();

    await manager.getBackend('ghostty-web', createProfile(), replayInput);

    expect(getCreatedBackend(backends, 0).replayToMock).toHaveBeenCalledTimes(
      1,
    );
    expect(getCreatedBackend(backends, 0).replayToMock).toHaveBeenCalledWith(
      replayInput,
    );
  });

  it('rebuilds the backend after a crash leaves it unbooted', async () => {
    const manager = new HostRendererManager({
      sessionId: 'session-01',
      sessionDir,
      backendFactory,
    });

    const firstBackend = await manager.getBackend(
      'ghostty-web',
      createProfile(),
      null,
    );
    const crashedBackend = getCreatedBackend(backends, 0);
    expect(crashedBackend).toBe(firstBackend);
    crashedBackend.setBooted(false);

    const secondBackend = await manager.getBackend(
      'ghostty-web',
      createProfile(),
      null,
    );

    expect(secondBackend).not.toBe(firstBackend);
    expect(backendFactory).toHaveBeenCalledTimes(2);
    expect(crashedBackend.disposeMock).toHaveBeenCalledTimes(1);
  });

  it('disposes the current backend when boot fails so the next attempt can recover', async () => {
    const manager = new HostRendererManager({
      sessionId: 'session-01',
      sessionDir,
      backendFactory,
    });
    const bootError = new Error('boot failed');

    backendFactory.mockImplementationOnce(() => {
      const backend = createFakeBackend({
        bootImplementation: () => Promise.reject(bootError),
      });
      backends.push(backend);
      return backend;
    });

    await expect(
      manager.getBackend('ghostty-web', createProfile(), null),
    ).rejects.toThrow('boot failed');
    expect(getCreatedBackend(backends, 0).disposeMock).toHaveBeenCalledTimes(1);

    const recoveredBackend = await manager.getBackend(
      'ghostty-web',
      createProfile(),
      null,
    );

    expect(recoveredBackend).toBe(getCreatedBackend(backends, 1));
    expect(backendFactory).toHaveBeenCalledTimes(2);
  });

  it('makes dispose idempotent after a backend has been created', async () => {
    const manager = new HostRendererManager({
      sessionId: 'session-01',
      sessionDir,
      backendFactory,
    });

    await manager.getBackend('ghostty-web', createProfile(), null);

    await expect(manager.dispose()).resolves.toBeUndefined();
    await expect(manager.dispose()).resolves.toBeUndefined();

    expect(getCreatedBackend(backends, 0).disposeMock).toHaveBeenCalledTimes(1);
  });

  it('allows dispose before any backend is created', async () => {
    const manager = new HostRendererManager({
      sessionId: 'session-01',
      sessionDir,
      backendFactory,
    });

    await expect(manager.dispose()).resolves.toBeUndefined();
    expect(backendFactory).not.toHaveBeenCalled();
  });

  it('exposes booted, bootInFlight, and current profile name getters', async () => {
    const manager = new HostRendererManager({
      sessionId: 'session-01',
      sessionDir,
      backendFactory,
    });

    expect(manager.isBooted()).toBe(false);
    expect(manager.isBootInFlight()).toBe(false);
    expect(manager.getCurrentProfileName()).toBeNull();

    await manager.getBackend(
      'ghostty-web',
      createProfile('reference-dark'),
      null,
    );

    expect(manager.isBooted()).toBe(true);
    expect(manager.isBootInFlight()).toBe(false);
    expect(manager.getCurrentProfileName()).toBe('reference-dark');

    await manager.dispose();

    expect(manager.isBooted()).toBe(false);
    expect(manager.getCurrentProfileName()).toBeNull();
  });

  it('reports isBootInFlight as true while a boot is awaiting', async () => {
    const manager = new HostRendererManager({
      sessionId: 'session-01',
      sessionDir,
      backendFactory,
    });
    const bootDeferred = createDeferred<undefined>();

    backendFactory.mockImplementationOnce(() => {
      const backend = createFakeBackend({
        bootImplementation: () =>
          bootDeferred.promise.then(() => {
            backend.setBooted(true);
          }),
      });
      backends.push(backend);
      return backend;
    });

    const inflight = manager.getBackend('ghostty-web', createProfile(), null);
    await flushAsyncQueue();

    expect(manager.isBootInFlight()).toBe(true);
    expect(manager.isBooted()).toBe(false);

    bootDeferred.resolve(undefined);
    await inflight;

    expect(manager.isBootInFlight()).toBe(false);
    expect(manager.isBooted()).toBe(true);
  });

  it('allocates screenshot paths inside the session screenshots directory', async () => {
    const manager = new HostRendererManager({
      sessionId: 'session-01',
      sessionDir,
      backendFactory,
    });
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(123456789);

    try {
      const outputPath = manager.screenshotPath('default');

      expect(isAbsolute(outputPath)).toBe(true);
      expect(relative(sessionDir, outputPath)).toBe(
        join('screenshots', 'default-123456789.png'),
      );
      await expect(
        access(join(sessionDir, 'screenshots')),
      ).resolves.toBeUndefined();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('validates constructor arguments', () => {
    expect(
      () =>
        new HostRendererManager({
          sessionId: '',
          sessionDir,
          backendFactory,
        }),
    ).toThrow('sessionId must be a non-empty string');
    expect(
      () =>
        new HostRendererManager({
          sessionId: 'session-01',
          sessionDir: 'relative/path',
          backendFactory,
        }),
    ).toThrow('sessionDir must be an absolute path');
    expect(
      () =>
        new HostRendererManager({
          sessionId: 'session-01',
          sessionDir,
          backendFactory: null as unknown as BackendFactory,
        }),
    ).toThrow('backendFactory must be a function');
  });
});
