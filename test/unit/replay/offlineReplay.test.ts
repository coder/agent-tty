import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CliError } from '../../../src/cli/errors.js';
import { ERROR_CODES } from '../../../src/protocol/errors.js';
import type { SessionRecord } from '../../../src/protocol/schemas.js';
import { withOfflineReplayRenderer } from '../../../src/replay/offlineReplay.js';
import type { RendererBackend } from '../../../src/renderer/backend.js';
import type { ReplayInput } from '../../../src/renderer/types.js';
import { writeManifest } from '../../../src/storage/manifests.js';
import { eventLogPath, manifestPath } from '../../../src/storage/sessionPaths.js';

interface OfflineReplayRunContext {
  manifest: SessionRecord;
  replayInput: ReplayInput;
  backend: RendererBackend;
}

interface MockBackendState {
  disposed: boolean;
  booted: boolean;
  isBooted: boolean;
  replayedInput: ReplayInput | null;
}

interface MockBackendOptions {
  bootError?: Error;
  replayError?: Error;
}

type MockBackend = RendererBackend & MockBackendState;

function createMockBackend(options: MockBackendOptions = {}): MockBackend {
  return {
    isBooted: false,
    booted: false,
    disposed: false,
    replayedInput: null,
    boot(this: MockBackend) {
      this.booted = true;
      if (options.bootError !== undefined) {
        return Promise.reject(options.bootError);
      }
      this.isBooted = true;
      return Promise.resolve();
    },
    replayTo(this: MockBackend, input: ReplayInput) {
      this.replayedInput = input;
      if (options.replayError !== undefined) {
        return Promise.reject(options.replayError);
      }
      return Promise.resolve({
        lastSeq: input.targetSeq,
        cols: 80,
        rows: 24,
        cursorRow: 0,
        cursorCol: 0,
      });
    },
    snapshot() {
      return Promise.resolve({
        sessionId: 'test',
        capturedAtSeq: 0,
        cols: 80,
        rows: 24,
        cursorRow: 0,
        cursorCol: 0,
        isAltScreen: false,
        visibleLines: [],
      });
    },
    screenshot(outputPath: string) {
      return Promise.resolve({
        sessionId: 'test',
        capturedAtSeq: 0,
        profileName: 'test',
        cols: 80,
        rows: 24,
        artifactPath: outputPath,
        pngSizeBytes: 100,
      });
    },
    getVisibleText() {
      return Promise.resolve('');
    },
    dispose(this: MockBackend) {
      this.disposed = true;
      this.isBooted = false;
      return Promise.resolve();
    },
  };
}

function createManifest(sessionId: string): SessionRecord {
  return {
    version: 1,
    sessionId,
    createdAt: '2026-03-20T12:00:00.000Z',
    updatedAt: '2026-03-20T12:00:01.000Z',
    status: 'exited',
    command: ['/bin/sh'],
    cwd: '/tmp',
    cols: 80,
    rows: 24,
    hostPid: null,
    childPid: null,
    exitCode: 0,
    exitSignal: null,
  };
}

function createEventsJsonl(): string {
  return [
    {
      seq: 0,
      ts: '2026-03-20T12:00:00.000Z',
      type: 'output',
      payload: { data: 'hello' },
    },
    {
      seq: 1,
      ts: '2026-03-20T12:00:01.000Z',
      type: 'output',
      payload: { data: ' world' },
    },
    {
      seq: 2,
      ts: '2026-03-20T12:00:02.000Z',
      type: 'output',
      payload: { data: '!' },
    },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n');
}

const tempDirs: string[] = [];

async function createSessionFixture(options?: {
  eventsContents?: string;
  includeEventLog?: boolean;
}): Promise<{ sessionDir: string; sessionId: string }> {
  const sessionDir = await mkdtemp(join(tmpdir(), 'agent-terminal-offline-replay-'));
  tempDirs.push(sessionDir);

  const sessionId = basename(sessionDir);

  await writeManifest(manifestPath(sessionDir), createManifest(sessionId));

  if (options?.includeEventLog ?? true) {
    await writeFile(
      eventLogPath(sessionDir),
      options?.eventsContents ?? createEventsJsonl(),
      'utf8',
    );
  }

  return { sessionDir, sessionId };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((tempDir) =>
      rm(tempDir, { recursive: true, force: true }),
    ),
  );
});

describe('withOfflineReplayRenderer', () => {
  it('boots, replays to the last durable seq, invokes the callback, and disposes', async () => {
    const { sessionDir, sessionId } = await createSessionFixture();
    const backend = createMockBackend();
    let runCallCount = 0;

    const result = await withOfflineReplayRenderer(
      { sessionDir },
      ({ manifest, replayInput, backend: providedBackend }: OfflineReplayRunContext) => {
        runCallCount += 1;
        expect(manifest.sessionId).toBe(sessionId);
        expect(replayInput.targetSeq).toBe(2);
        expect(providedBackend).toBe(backend);
        return Promise.resolve('captured');
      },
      {
        backendFactory(factorySessionId, profile) {
          expect(factorySessionId).toBe(sessionId);
          expect(profile.name).toBe('reference-dark');
          return backend;
        },
      },
    );

    expect(result).toBe('captured');
    expect(runCallCount).toBe(1);
    expect(backend.booted).toBe(true);
    expect(backend.replayedInput?.targetSeq).toBe(2);
    expect(backend.disposed).toBe(true);
  });

  it('invokes the callback without replaying when the event log is empty', async () => {
    const { sessionDir } = await createSessionFixture({ eventsContents: '' });
    const backend = createMockBackend();

    await withOfflineReplayRenderer(
      { sessionDir },
      ({ replayInput, backend: providedBackend }: OfflineReplayRunContext) => {
        expect(replayInput.targetSeq).toBe(-1);
        expect(providedBackend).toBe(backend);
        expect(backend.replayedInput).toBeNull();
        return Promise.resolve(undefined);
      },
      { backendFactory: () => backend },
    );

    expect(backend.booted).toBe(true);
    expect(backend.replayedInput).toBeNull();
    expect(backend.disposed).toBe(true);
  });

  it('treats a missing event log file as an empty replay', async () => {
    const { sessionDir } = await createSessionFixture({ includeEventLog: false });
    const backend = createMockBackend();

    await withOfflineReplayRenderer(
      { sessionDir },
      ({ replayInput }: OfflineReplayRunContext) => {
        expect(replayInput.targetSeq).toBe(-1);
        return Promise.resolve(undefined);
      },
      { backendFactory: () => backend },
    );

    expect(backend.replayedInput).toBeNull();
    expect(backend.disposed).toBe(true);
  });

  it('wraps corrupted event logs as REPLAY_ERROR and still disposes the backend', async () => {
    const { sessionDir } = await createSessionFixture({ eventsContents: '{"seq":0' });
    const backend = createMockBackend();

    const replayPromise = withOfflineReplayRenderer(
      { sessionDir },
      () => Promise.resolve('unreachable'),
      { backendFactory: () => backend },
    );

    await expect(replayPromise).rejects.toMatchObject({
      name: 'CliError',
      code: ERROR_CODES.REPLAY_ERROR,
    });
    expect(backend.booted).toBe(false);
    expect(backend.disposed).toBe(true);
  });

  it('propagates callback failures without wrapping and still disposes the backend', async () => {
    const { sessionDir } = await createSessionFixture();
    const backend = createMockBackend();
    const callbackError = new Error('callback failed');

    const replayPromise = withOfflineReplayRenderer(
      { sessionDir },
      () => Promise.reject(callbackError),
      { backendFactory: () => backend },
    );

    await expect(replayPromise).rejects.toBe(callbackError);
    expect(backend.disposed).toBe(true);
  });

  it('wraps replayTo errors as REPLAY_ERROR and disposes the backend', async () => {
    const { sessionDir } = await createSessionFixture();
    const backend = createMockBackend({ replayError: new Error('replay failed') });

    const replayPromise = withOfflineReplayRenderer(
      { sessionDir },
      () => Promise.resolve('unreachable'),
      { backendFactory: () => backend },
    );

    await expect(replayPromise).rejects.toBeInstanceOf(CliError);
    await expect(replayPromise).rejects.toMatchObject({
      code: ERROR_CODES.REPLAY_ERROR,
    });
    expect(backend.booted).toBe(true);
    expect(backend.replayedInput?.targetSeq).toBe(2);
    expect(backend.disposed).toBe(true);
  });

  it('respects a custom target sequence', async () => {
    const { sessionDir } = await createSessionFixture();
    const backend = createMockBackend();

    await withOfflineReplayRenderer(
      { sessionDir, targetSeq: 0 },
      ({ replayInput }: OfflineReplayRunContext) => {
        expect(replayInput.targetSeq).toBe(0);
        return Promise.resolve(undefined);
      },
      { backendFactory: () => backend },
    );

    expect(backend.replayedInput?.targetSeq).toBe(0);
    expect(backend.disposed).toBe(true);
  });

  it('wraps backend boot failures as REPLAY_ERROR and disposes the backend', async () => {
    const { sessionDir } = await createSessionFixture();
    const backend = createMockBackend({ bootError: new Error('boot failed') });

    const replayPromise = withOfflineReplayRenderer(
      { sessionDir },
      () => Promise.resolve('unreachable'),
      { backendFactory: () => backend },
    );

    await expect(replayPromise).rejects.toBeInstanceOf(CliError);
    await expect(replayPromise).rejects.toMatchObject({
      code: ERROR_CODES.REPLAY_ERROR,
    });
    expect(backend.booted).toBe(true);
    expect(backend.disposed).toBe(true);
  });
});
