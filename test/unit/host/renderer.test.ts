import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { setImmediate as setImmediatePromise } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostRendererManager } from '../../../src/host/renderer.js';
import type { RendererBackend } from '../../../src/renderer/backend.js';
import type {
  RenderProfileConfig,
  ReplayInput,
  ReplayState,
  ScreenshotResult,
  SemanticSnapshot,
} from '../../../src/renderer/types.js';

type MockFn = ReturnType<typeof vi.fn>;

type FakeRendererBackend = RendererBackend & {
  bootMock: MockFn;
  replayToMock: MockFn;
  snapshotMock: MockFn;
  screenshotMock: MockFn;
  getVisibleTextMock: MockFn;
  disposeMock: MockFn;
  setBooted: (value: boolean) => void;
};

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

function createFakeBackend(
  options: {
    bootImplementation?: () => Promise<void>;
  } = {},
): FakeRendererBackend {
  let booted = false;
  const bootMock = vi.fn((): Promise<void> => {
    if (options.bootImplementation !== undefined) {
      return options.bootImplementation();
    }

    booted = true;
    return Promise.resolve();
  });
  const replayToMock = vi.fn(
    (input: ReplayInput): Promise<ReplayState> =>
      Promise.resolve({
        lastSeq: input.targetSeq,
        cols: input.initialCols,
        rows: input.initialRows,
        cursorRow: 0,
        cursorCol: 0,
      }),
  );
  const snapshotMock = vi.fn(
    (): Promise<SemanticSnapshot> =>
      Promise.resolve({
        sessionId: 'session-01',
        capturedAtSeq: 0,
        cols: 80,
        rows: 24,
        cursorRow: 0,
        cursorCol: 0,
        isAltScreen: false,
        visibleLines: [],
      }),
  );
  const screenshotMock = vi.fn(
    (outputPath: string): Promise<ScreenshotResult> =>
      Promise.resolve({
        sessionId: 'session-01',
        capturedAtSeq: 0,
        profileName: 'default',
        cols: 80,
        rows: 24,
        pngPath: outputPath,
        pngSizeBytes: 1,
      }),
  );
  const getVisibleTextMock = vi.fn((): Promise<string> => Promise.resolve(''));
  const disposeMock = vi.fn((): Promise<void> => {
    booted = false;
    return Promise.resolve();
  });

  return {
    boot: bootMock,
    bootMock,
    replayTo: replayToMock,
    replayToMock,
    snapshot: snapshotMock,
    snapshotMock,
    screenshot: screenshotMock,
    screenshotMock,
    getVisibleText: getVisibleTextMock,
    getVisibleTextMock,
    dispose: disposeMock,
    disposeMock,
    get isBooted() {
      return booted;
    },
    setBooted(value: boolean) {
      booted = value;
    },
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
  sessionId: string,
  profile: RenderProfileConfig,
) => RendererBackend;

describe('HostRendererManager', () => {
  let sessionDir: string;
  let backends: FakeRendererBackend[];
  let backendFactory: ReturnType<typeof vi.fn<BackendFactory>>;

  beforeEach(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), 'agent-terminal-renderer-'));
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

    const first = manager.getBackend(createProfile(), null);
    const second = manager.getBackend(createProfile(), null);

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

    const firstBackend = await manager.getBackend(createProfile(), null);
    const secondBackend = await manager.getBackend(createProfile(), null);

    expect(firstBackend).toBe(secondBackend);
    expect(backendFactory).toHaveBeenCalledTimes(1);
  });

  it('disposes and recreates the backend when the profile name changes', async () => {
    const manager = new HostRendererManager({
      sessionId: 'session-01',
      sessionDir,
      backendFactory,
    });

    const firstBackend = await manager.getBackend(createProfile('dark'), null);
    const secondBackend = await manager.getBackend(
      createProfile('light'),
      null,
    );

    expect(secondBackend).not.toBe(firstBackend);
    expect(backendFactory).toHaveBeenCalledTimes(2);
    expect(getCreatedBackend(backends, 0).disposeMock).toHaveBeenCalledTimes(1);
    expect(getCreatedBackend(backends, 1)).toBe(secondBackend);
  });

  it('skips replay when the replay target sequence is -1', async () => {
    const manager = new HostRendererManager({
      sessionId: 'session-01',
      sessionDir,
      backendFactory,
    });

    await manager.getBackend(
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

    await manager.getBackend(createProfile(), replayInput);

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

    const firstBackend = await manager.getBackend(createProfile(), null);
    const crashedBackend = getCreatedBackend(backends, 0);
    expect(crashedBackend).toBe(firstBackend);
    crashedBackend.setBooted(false);

    const secondBackend = await manager.getBackend(createProfile(), null);

    expect(secondBackend).not.toBe(firstBackend);
    expect(backendFactory).toHaveBeenCalledTimes(2);
    expect(crashedBackend.disposeMock).toHaveBeenCalledTimes(1);
  });

  it('makes dispose idempotent after a backend has been created', async () => {
    const manager = new HostRendererManager({
      sessionId: 'session-01',
      sessionDir,
      backendFactory,
    });

    await manager.getBackend(createProfile(), null);

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
          backendFactory: null as unknown as (
            sessionId: string,
            profile: RenderProfileConfig,
          ) => RendererBackend,
        }),
    ).toThrow('backendFactory must be a function');
  });
});
