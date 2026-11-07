import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { setImmediate as setImmediatePromise } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostRendererManager } from '../../../src/host/renderer.js';
import { CliError } from '../../../src/cli/errors.js';
import { GhosttyWebCrashedError } from '../../../src/renderer/ghosttyWeb/index.js';
import type { RendererBackend } from '../../../src/renderer/backend.js';
import { iterateInRangeReplayEvents } from '../../../src/renderer/replayEvents.js';
import type {
  RenderProfileConfig,
  ReplayInput,
  ReplayState,
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
      () => null,
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
      () => null,
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

  it('replays an empty event log so the backend starts at the session size', async () => {
    const manager = new HostRendererManager({
      sessionId: 'session-01',
      sessionDir,
      backendFactory,
    });
    const replayInput = createReplayInput({ events: [], targetSeq: -1 });

    await manager.getBackend('ghostty-web', createProfile(), replayInput);

    expect(getCreatedBackend(backends, 0).replayToMock).toHaveBeenCalledWith(
      replayInput,
    );
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

  // KNOWN-BUG TEST for a ghostty-web 0.4.0 fault: remove it with
  // GhosttyWebCrashedError when ghostty-web has a fix.
  it('reports a crashed ghostty-web page as a REPLAY_ERROR that is not retryable', async () => {
    const manager = new HostRendererManager({
      sessionId: 'session-01',
      sessionDir,
      backendFactory,
    });
    const crash = new GhosttyWebCrashedError(
      new Error('page.evaluate: Target crashed '),
    );
    backendFactory.mockImplementationOnce(() => {
      const backend = createFakeBackend();
      backend.replayTo = vi.fn(
        (): Promise<ReplayState> => Promise.reject(crash),
      );
      backends.push(backend);
      return backend;
    });

    const failure: unknown = await manager
      .getBackend('ghostty-web', createProfile(), createReplayInput())
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CliError);
    expect(failure).toMatchObject({
      code: 'REPLAY_ERROR',
      message: crash.message,
      retryable: false,
      cause: crash,
    });
  });

  it('passes every other renderer failure through unchanged', async () => {
    const manager = new HostRendererManager({
      sessionId: 'session-01',
      sessionDir,
      backendFactory,
    });
    const failure = new Error('replay failed');
    backendFactory.mockImplementationOnce(() => {
      const backend = createFakeBackend();
      backend.replayTo = vi.fn(
        (): Promise<ReplayState> => Promise.reject(failure),
      );
      backends.push(backend);
      return backend;
    });

    await expect(
      manager.getBackend('ghostty-web', createProfile(), createReplayInput()),
    ).rejects.toBe(failure);
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

describe('HostRendererManager replay progress', () => {
  let sessionDir: string;
  let backends: FakeRendererBackend[];
  let appliedByBackend: number[][];
  // One entry for each `replayTo` call that waits for the test to let it go.
  let pendingReplays: ReturnType<typeof createDeferred<undefined>>[];
  let holdReplays: boolean;
  let backendFactory: ReturnType<typeof vi.fn<BackendFactory>>;

  function createLongInput(eventCount: number): ReplayInput {
    return createReplayInput({
      events: Array.from({ length: eventCount }, (_, seq) => ({
        seq,
        ts: '2026-03-20T12:00:00.000Z',
        type: 'output' as const,
        payload: { data: 'x' },
      })),
      targetSeq: eventCount - 1,
    });
  }

  // A backend that replays as the real ones do: it holds a position, skips the
  // events that it holds and ends at the last event that it replays.
  function createReplayingBackend(): FakeRendererBackend {
    const backend = createFakeBackend();
    const applied: number[] = [];
    appliedByBackend.push(applied);
    let lastAppliedSeq = -1;
    const replay = (input: ReplayInput): ReplayState => {
      for (const event of iterateInRangeReplayEvents(input, lastAppliedSeq)) {
        applied.push(event.seq);
        lastAppliedSeq = event.seq;
      }
      return {
        lastSeq: lastAppliedSeq,
        cols: input.initialCols,
        rows: input.initialRows,
        cursorRow: 0,
        cursorCol: 0,
      };
    };
    const replayToMock = vi.fn((input: ReplayInput): Promise<ReplayState> => {
      if (!holdReplays) {
        return Promise.resolve(replay(input));
      }
      const hold = createDeferred<undefined>();
      pendingReplays.push(hold);
      return hold.promise.then(() => replay(input));
    });
    backend.replayTo = replayToMock;
    backend.replayToMock = replayToMock;
    return backend;
  }

  // Let the replays go that wait now, one by one, until `done` reads true.
  async function releaseReplaysUntil(done: () => boolean): Promise<void> {
    for (let round = 0; round < 1_000 && !done(); round += 1) {
      await flushAsyncQueue();
      pendingReplays.shift()?.resolve(undefined);
    }
    expect(done()).toBe(true);
  }

  function createManager(): HostRendererManager {
    return new HostRendererManager({
      sessionId: 'session-01',
      sessionDir,
      backendFactory,
    });
  }

  beforeEach(async () => {
    // oxfmt-ignore
    sessionDir = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-renderer-')));
    backends = [];
    appliedByBackend = [];
    pendingReplays = [];
    holdReplays = false;
    backendFactory = vi.fn(() => {
      const backend = createReplayingBackend();
      backends.push(backend);
      return backend;
    });
  });

  afterEach(async () => {
    await rm(sessionDir, { recursive: true, force: true });
  });

  it('reports progress each time a replay of a long log moves forward', async () => {
    const manager = createManager();
    const onProgress = vi.fn();

    await manager.withBackend(
      'ghostty-web',
      createProfile(),
      () => createLongInput(300),
      () => undefined,
      onProgress,
    );

    const replayCalls = getCreatedBackend(backends, 0).replayToMock.mock.calls;
    expect(replayCalls.length).toBeGreaterThan(1);
    // The boot, and each call of `replayTo`.
    expect(onProgress).toHaveBeenCalledTimes(1 + replayCalls.length);
    expect(appliedByBackend[0]).toEqual(
      Array.from({ length: 300 }, (_, seq) => seq),
    );
  });

  it('reports progress when the backend has booted, before its first slice is done', async () => {
    const manager = createManager();
    holdReplays = true;
    const onProgress = vi.fn();

    const call = manager.withBackend(
      'ghostty-web',
      createProfile(),
      () => createLongInput(300),
      () => undefined,
      onProgress,
    );
    await flushAsyncQueue();
    await flushAsyncQueue();

    // The first slice waits, and the boot is the only progress so far.
    expect(pendingReplays).toHaveLength(1);
    expect(onProgress).toHaveBeenCalledTimes(1);

    let finished = false;
    void call.then(() => {
      finished = true;
    });
    await releaseReplaysUntil(() => finished);
  });

  it('reports the progress of the replay ahead to a call that waits for it', async () => {
    const manager = createManager();
    holdReplays = true;
    const aheadProgress = vi.fn();
    const waitingProgress = vi.fn();
    const waitingOperation = vi.fn();

    const ahead = manager.withBackend(
      'ghostty-web',
      createProfile(),
      () => createLongInput(300),
      () => undefined,
      aheadProgress,
    );
    const waiting = manager.withBackend(
      'ghostty-web',
      createProfile(),
      () => createLongInput(300),
      waitingOperation,
      waitingProgress,
    );
    await flushAsyncQueue();
    await flushAsyncQueue();
    expect(pendingReplays).toHaveLength(1);

    pendingReplays.shift()?.resolve(undefined);
    await flushAsyncQueue();
    await flushAsyncQueue();

    // The call ahead has booted the backend and replayed its first slice. The
    // other call has not begun, and it hears of both.
    expect(aheadProgress).toHaveBeenCalledTimes(2);
    expect(waitingProgress).toHaveBeenCalledTimes(2);
    expect(waitingOperation).not.toHaveBeenCalled();

    let finished = false;
    void Promise.all([ahead, waiting]).then(() => {
      finished = true;
    });
    await releaseReplaysUntil(() => finished);
  });

  it('reports the progress that an operation reports to every call that waits, its own too', async () => {
    const manager = createManager();
    const gate = createDeferred<undefined>();
    const aheadProgress = vi.fn();
    const waitingProgress = vi.fn();
    const waitingOperation = vi.fn();
    const heard = { ahead: 0, waiting: 0 };

    // No input: nothing replays, so the only progress is the boot and what
    // the operation reports (a libghostty-vt screenshot reports each slice of
    // the replay in its second renderer).
    const ahead = manager.withBackend(
      'libghostty-vt',
      createProfile(),
      () => null,
      async (_backend, _replayInput, reportProgress) => {
        const before = {
          ahead: aheadProgress.mock.calls.length,
          waiting: waitingProgress.mock.calls.length,
        };
        reportProgress();
        reportProgress();
        heard.ahead = aheadProgress.mock.calls.length - before.ahead;
        heard.waiting = waitingProgress.mock.calls.length - before.waiting;
        await gate.promise;
      },
      aheadProgress,
    );
    const waiting = manager.withBackend(
      'libghostty-vt',
      createProfile(),
      () => null,
      waitingOperation,
      waitingProgress,
    );
    await flushAsyncQueue();
    await flushAsyncQueue();

    expect(heard).toEqual({ ahead: 2, waiting: 2 });
    expect(waitingOperation).not.toHaveBeenCalled();

    gate.resolve(undefined);
    await Promise.all([ahead, waiting]);
    expect(waitingOperation).toHaveBeenCalledTimes(1);
  });

  it('reports nothing once a replay stops, and a call that finished hears nothing more', async () => {
    const manager = createManager();
    holdReplays = true;
    const onProgress = vi.fn();

    const stuck = manager.withBackend(
      'ghostty-web',
      createProfile(),
      () => createLongInput(300),
      () => undefined,
      onProgress,
    );
    for (let slice = 0; slice < 2; slice += 1) {
      await flushAsyncQueue();
      pendingReplays.shift()?.resolve(undefined);
    }
    await flushAsyncQueue();
    await flushAsyncQueue();
    // The boot and two slices.
    expect(onProgress).toHaveBeenCalledTimes(3);

    // The third slice never ends.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(pendingReplays).toHaveLength(1);

    let finished = false;
    void stuck.then(() => {
      finished = true;
    });
    await releaseReplaysUntil(() => finished);
    const finalCount = onProgress.mock.calls.length;

    // Another call replays more events. The finished call is not told.
    holdReplays = false;
    await manager.withBackend(
      'ghostty-web',
      createProfile(),
      () => createLongInput(600),
      () => undefined,
    );
    expect(onProgress).toHaveBeenCalledTimes(finalCount);
  });

  it('replays only the new events when the backend already holds the earlier ones', async () => {
    const manager = createManager();

    await manager.withBackend(
      'ghostty-web',
      createProfile(),
      () => createLongInput(300),
      () => undefined,
    );
    const replayCalls = getCreatedBackend(backends, 0).replayToMock.mock.calls;
    const callsBefore = replayCalls.length;
    await manager.withBackend(
      'ghostty-web',
      createProfile(),
      () => createLongInput(400),
      () => undefined,
    );

    const secondFirstSlice = replayCalls[callsBefore]?.[0] as ReplayInput;
    expect(secondFirstSlice.events[0]?.seq).toBe(300);
    expect(appliedByBackend[0]).toEqual(
      Array.from({ length: 400 }, (_, seq) => seq),
    );
  });

  it('goes on in slices from the last slice that finished, when a slice failed', async () => {
    // The third call of `replayTo` fails once, as when the page crashes.
    backendFactory = vi.fn(() => {
      const backend = createReplayingBackend();
      const replay = backend.replayTo.bind(backend);
      let calls = 0;
      const replayToMock = vi.fn((input: ReplayInput): Promise<ReplayState> => {
        calls += 1;
        return calls === 3
          ? Promise.reject(new Error('page crashed'))
          : replay(input);
      });
      backend.replayTo = replayToMock;
      backend.replayToMock = replayToMock;
      backends.push(backend);
      return backend;
    });
    const manager = createManager();
    const profile = createProfile();

    await expect(
      manager.withBackend(
        'ghostty-web',
        profile,
        () => createLongInput(300),
        () => undefined,
      ),
    ).rejects.toThrow('page crashed');
    const replayCalls = getCreatedBackend(backends, 0).replayToMock.mock.calls;
    expect(replayCalls).toHaveLength(3);
    const replayedBeforeRetry = appliedByBackend[0]?.length ?? 0;
    expect(replayedBeforeRetry).toBeGreaterThan(0);
    expect(replayedBeforeRetry).toBeLessThan(300);

    await manager.withBackend(
      'ghostty-web',
      profile,
      () => createLongInput(300),
      () => undefined,
    );

    // The retry does not start over, and it is not one call that replays all
    // the events that are left: it has slices, and the last has the input.
    const retryInputs = replayCalls
      .slice(3)
      .map(([input]) => input as ReplayInput);
    expect(retryInputs.length).toBeGreaterThan(1);
    expect(retryInputs[0]?.events[0]?.seq).toBe(replayedBeforeRetry);
    expect(retryInputs[0]?.events.length).toBeLessThan(
      300 - replayedBeforeRetry,
    );
    expect(retryInputs.at(-1)?.events).toHaveLength(300);
    expect(appliedByBackend[0]).toEqual(
      Array.from({ length: 300 }, (_, seq) => seq),
    );
  });

  it('replays a new backend from the first event', async () => {
    const manager = createManager();

    await manager.withBackend(
      'ghostty-web',
      createProfile('first'),
      () => createLongInput(300),
      () => undefined,
    );
    // A change of profile replaces the backend, which holds nothing yet.
    await manager.withBackend(
      'ghostty-web',
      createProfile('second'),
      () => createLongInput(400),
      () => undefined,
    );

    expect(backends).toHaveLength(2);
    expect(appliedByBackend[1]).toEqual(
      Array.from({ length: 400 }, (_, seq) => seq),
    );
  });
});
