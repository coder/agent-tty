import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CliError } from '../../../src/cli/errors.js';
import { ERROR_CODES } from '../../../src/protocol/errors.js';
import type {
  EventRecord,
  SessionRecord,
} from '../../../src/protocol/schemas.js';
import { withOfflineReplayRenderer } from '../../../src/replay/offlineReplay.js';
import type { RendererBackend } from '../../../src/renderer/backend.js';
import type { ReplayInput, ReplayState } from '../../../src/renderer/types.js';
import { writeManifest } from '../../../src/storage/manifests.js';
import {
  eventLogPath,
  manifestPath,
} from '../../../src/storage/sessionPaths.js';

interface OfflineReplayRunContext {
  manifest: SessionRecord;
  replayInput: ReplayInput;
  backend: RendererBackend;
}

interface MockBackendState {
  disposed: boolean;
  booted: boolean;
  isBooted: boolean;
  replayCallCount: number;
  replayedInput: ReplayInput | null;
  replayedState: ReplayState | null;
}

interface MockBackendOptions {
  bootError?: Error;
  replayError?: Error;
}

type MockBackend = RendererBackend & MockBackendState;

function createMockBackend(options: MockBackendOptions = {}): MockBackend {
  return {
    rendererBackend: 'mock-backend',
    isBooted: false,
    booted: false,
    disposed: false,
    replayCallCount: 0,
    replayedInput: null,
    replayedState: null,
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
      this.replayCallCount += 1;
      if (options.replayError !== undefined) {
        return Promise.reject(options.replayError);
      }
      const replayState: ReplayState = {
        lastSeq: input.targetSeq,
        cols: input.initialCols,
        rows: input.initialRows,
        cursorRow: 0,
        cursorCol: 0,
      };
      this.replayedState = replayState;
      return Promise.resolve(replayState);
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

function createManifest(
  sessionId: string,
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
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
    ...overrides,
  };
}

function createDefaultEvents(): EventRecord[] {
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
  ];
}

function createEventsJsonl(
  events: readonly EventRecord[] = createDefaultEvents(),
): string {
  return events.map((event) => JSON.stringify(event)).join('\n');
}

const tempDirs: string[] = [];

async function createSessionFixture(options?: {
  events?: EventRecord[];
  eventsContents?: string;
  includeEventLog?: boolean;
  manifestOverrides?: Partial<SessionRecord>;
}): Promise<{ sessionDir: string; sessionId: string }> {
  // prettier-ignore
  const sessionDir = await realpath(await mkdtemp(join(tmpdir(), 'agent-terminal-offline-replay-')));
  tempDirs.push(sessionDir);

  const sessionId = basename(sessionDir);

  await writeManifest(
    manifestPath(sessionDir),
    createManifest(sessionId, options?.manifestOverrides),
  );

  if (options?.includeEventLog ?? true) {
    await writeFile(
      eventLogPath(sessionDir),
      options?.eventsContents ?? createEventsJsonl(options?.events),
      'utf8',
    );
  }

  return { sessionDir, sessionId };
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((tempDir) => rm(tempDir, { recursive: true, force: true })),
  );
});

describe('withOfflineReplayRenderer', () => {
  it('boots, replays to the last durable seq, invokes the callback, and disposes', async () => {
    const { sessionDir, sessionId } = await createSessionFixture();
    const backend = createMockBackend();
    let runCallCount = 0;

    const result = await withOfflineReplayRenderer(
      { sessionDir },
      ({
        manifest,
        replayInput,
        backend: providedBackend,
      }: OfflineReplayRunContext) => {
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

  it('rebuilds replay input that matches the expected event sequence from the event log', async () => {
    const expectedEvents: EventRecord[] = [
      {
        seq: 0,
        ts: '2026-03-20T12:00:00.000Z',
        type: 'output',
        payload: { data: 'booting' },
      },
      {
        seq: 1,
        ts: '2026-03-20T12:00:00.250Z',
        type: 'resize',
        payload: { cols: 120, rows: 40 },
      },
      {
        seq: 2,
        ts: '2026-03-20T12:00:00.500Z',
        type: 'output',
        payload: { data: '\nready' },
      },
      {
        seq: 3,
        ts: '2026-03-20T12:00:00.750Z',
        type: 'output',
        payload: { data: '\n$ ' },
      },
    ];
    const { sessionDir, sessionId } = await createSessionFixture({
      events: expectedEvents,
      manifestOverrides: {
        cols: 120,
        rows: 40,
        creationCols: 90,
        creationRows: 30,
      },
    });
    const backend = createMockBackend();

    await withOfflineReplayRenderer(
      { sessionDir },
      ({
        manifest,
        replayInput,
        backend: providedBackend,
      }: OfflineReplayRunContext) => {
        expect(
          manifest.sessionId,
          'offline replay should read the manifest for the same session directory',
        ).toBe(sessionId);
        expect(
          replayInput.sessionId,
          'reconstructed replay input should preserve the manifest session id',
        ).toBe(sessionId);
        expect(
          replayInput.initialCols,
          'reconstructed replay input should start from the manifest creation cols',
        ).toBe(90);
        expect(
          replayInput.initialRows,
          'reconstructed replay input should start from the manifest creation rows',
        ).toBe(30);
        expect(
          replayInput.targetSeq,
          'reconstructed replay input should target the last durable seq from the log',
        ).toBe(3);
        expect(
          replayInput.events,
          'reconstructed replay input should include every event from the log in order',
        ).toHaveLength(expectedEvents.length);
        expect(providedBackend).toBe(backend);

        expectedEvents.forEach((expectedEvent, index) => {
          const actualEvent = replayInput.events[index];
          expect(
            actualEvent?.seq,
            `event ${String(index)} should preserve the original seq from the event log`,
          ).toBe(expectedEvent.seq);
          expect(
            actualEvent?.ts,
            `event ${String(index)} should preserve the original timestamp from the event log`,
          ).toBe(expectedEvent.ts);
          expect(
            actualEvent?.type,
            `event ${String(index)} should preserve the original type from the event log`,
          ).toBe(expectedEvent.type);
          expect(
            actualEvent?.payload,
            `event ${String(index)} should preserve the original payload from the event log`,
          ).toStrictEqual(expectedEvent.payload);
        });

        return Promise.resolve(undefined);
      },
      { backendFactory: () => backend },
    );

    expect(
      backend.replayedInput?.events,
      'the renderer backend should receive the same reconstructed replay event sequence',
    ).toStrictEqual(expectedEvents);
    expect(
      backend.replayedInput?.targetSeq,
      'the renderer backend should receive the final seq as the replay target',
    ).toBe(3);
    expect(
      backend.replayedState?.lastSeq,
      'the mock replay state should report the same seq that replay targeted',
    ).toBe(3);
    expect(backend.disposed).toBe(true);
  });

  it('preserves fidelity for multiple event types and keeps them in log order', async () => {
    const expectedEvents: EventRecord[] = [
      {
        seq: 0,
        ts: '2026-03-20T12:00:00.000Z',
        type: 'output',
        payload: { data: 'prompt> ' },
      },
      {
        seq: 1,
        ts: '2026-03-20T12:00:00.100Z',
        type: 'input_text',
        payload: { data: 'ls' },
      },
      {
        seq: 2,
        ts: '2026-03-20T12:00:00.200Z',
        type: 'input_paste',
        payload: { data: 'echo pasted' },
      },
      {
        seq: 3,
        ts: '2026-03-20T12:00:00.300Z',
        type: 'input_keys',
        payload: { keys: ['ENTER'] },
      },
      {
        seq: 4,
        ts: '2026-03-20T12:00:00.400Z',
        type: 'resize',
        payload: { cols: 100, rows: 30 },
      },
      {
        seq: 5,
        ts: '2026-03-20T12:00:00.500Z',
        type: 'signal',
        payload: { signal: 'SIGINT' },
      },
      {
        seq: 6,
        ts: '2026-03-20T12:00:00.600Z',
        type: 'marker',
        payload: { label: 'after-sigint' },
      },
      {
        seq: 7,
        ts: '2026-03-20T12:00:00.700Z',
        type: 'exit',
        payload: { exitCode: 0, exitSignal: null },
      },
    ];
    const { sessionDir } = await createSessionFixture({
      events: expectedEvents,
    });
    const backend = createMockBackend();

    await withOfflineReplayRenderer(
      { sessionDir },
      ({ replayInput }: OfflineReplayRunContext) => {
        expect(
          replayInput.events.map((event) => event.type),
          'offline replay should preserve every event type in the same order as the log',
        ).toStrictEqual(expectedEvents.map((event) => event.type));
        expect(
          replayInput.events,
          'offline replay should preserve every event payload across all supported replay event types',
        ).toStrictEqual(expectedEvents);
        expect(replayInput.targetSeq).toBe(7);
        return Promise.resolve(undefined);
      },
      { backendFactory: () => backend },
    );

    expect(backend.replayedInput?.events).toStrictEqual(expectedEvents);
    expect(backend.disposed).toBe(true);
  });

  it('handles a single-event log by replaying exactly one event to seq 0', async () => {
    const expectedEvents: EventRecord[] = [
      {
        seq: 0,
        ts: '2026-03-20T12:00:00.000Z',
        type: 'output',
        payload: { data: 'only event' },
      },
    ];
    const { sessionDir, sessionId } = await createSessionFixture({
      events: expectedEvents,
    });
    const backend = createMockBackend();

    await withOfflineReplayRenderer(
      { sessionDir },
      ({ replayInput }: OfflineReplayRunContext) => {
        expect(
          replayInput.sessionId,
          'single-event replay should still preserve the session id',
        ).toBe(sessionId);
        expect(
          replayInput.events,
          'single-event replay should reconstruct the lone event without modification',
        ).toStrictEqual(expectedEvents);
        expect(
          replayInput.targetSeq,
          'single-event replay should target seq 0 because that is the only durable event',
        ).toBe(0);
        return Promise.resolve(undefined);
      },
      { backendFactory: () => backend },
    );

    expect(backend.replayCallCount).toBe(1);
    expect(backend.replayedInput?.events).toStrictEqual(expectedEvents);
    expect(backend.replayedState?.lastSeq).toBe(0);
    expect(backend.disposed).toBe(true);
  });

  it('produces an empty replay state without calling replayTo when the event log is empty', async () => {
    const { sessionDir, sessionId } = await createSessionFixture({
      eventsContents: '',
    });
    const backend = createMockBackend();

    await withOfflineReplayRenderer(
      { sessionDir },
      ({ replayInput, backend: providedBackend }: OfflineReplayRunContext) => {
        expect(
          replayInput.sessionId,
          'empty-log replay should still preserve the session id from the manifest',
        ).toBe(sessionId);
        expect(
          replayInput.initialCols,
          'empty-log replay should still preserve the initial columns from the manifest',
        ).toBe(80);
        expect(
          replayInput.initialRows,
          'empty-log replay should still preserve the initial rows from the manifest',
        ).toBe(24);
        expect(
          replayInput.events,
          'empty-log replay should reconstruct an empty event list',
        ).toStrictEqual([]);
        expect(
          replayInput.targetSeq,
          'empty-log replay should expose -1 to prove that there is no durable seq to replay to',
        ).toBe(-1);
        expect(providedBackend).toBe(backend);
        expect(backend.replayedInput).toBeNull();
        expect(backend.replayedState).toBeNull();
        return Promise.resolve(undefined);
      },
      { backendFactory: () => backend },
    );

    expect(backend.booted).toBe(true);
    expect(backend.replayCallCount).toBe(0);
    expect(backend.replayedInput).toBeNull();
    expect(backend.disposed).toBe(true);
  });

  it('treats a missing event log file as an empty replay', async () => {
    const { sessionDir } = await createSessionFixture({
      includeEventLog: false,
    });
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
    const { sessionDir } = await createSessionFixture({
      eventsContents: '{"seq":0',
    });
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

  it('wraps non-contiguous event log sequences as REPLAY_ERROR and still disposes the backend', async () => {
    const { sessionDir } = await createSessionFixture({
      events: [
        {
          seq: 0,
          ts: '2026-03-20T12:00:00.000Z',
          type: 'output',
          payload: { data: 'first' },
        },
        {
          seq: 2,
          ts: '2026-03-20T12:00:01.000Z',
          type: 'output',
          payload: { data: 'gap' },
        },
      ],
    });
    const backend = createMockBackend();

    const replayPromise = withOfflineReplayRenderer(
      { sessionDir },
      () => Promise.resolve('unreachable'),
      { backendFactory: () => backend },
    );

    await expect(replayPromise).rejects.toBeInstanceOf(CliError);
    await expect(replayPromise).rejects.toMatchObject({
      code: ERROR_CODES.REPLAY_ERROR,
    });
    expect(backend.booted).toBe(false);
    expect(backend.replayedInput).toBeNull();
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
    const backend = createMockBackend({
      replayError: new Error('replay failed'),
    });

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

  it('defaults replay state to the last event seq when no custom target is provided', async () => {
    const expectedEvents: EventRecord[] = Array.from(
      { length: 6 },
      (_, seq) => ({
        seq,
        ts: `2026-03-20T12:00:0${String(seq)}.000Z`,
        type: 'output',
        payload: { data: `chunk-${String(seq)}` },
      }),
    );
    const { sessionDir } = await createSessionFixture({
      events: expectedEvents,
    });
    const backend = createMockBackend();

    await withOfflineReplayRenderer(
      { sessionDir },
      ({ replayInput }: OfflineReplayRunContext) => {
        expect(
          replayInput.targetSeq,
          'default replay target should equal the last seq in the event log',
        ).toBe(5);
        return Promise.resolve(undefined);
      },
      { backendFactory: () => backend },
    );

    expect(backend.replayCallCount).toBe(1);
    expect(backend.replayedInput?.targetSeq).toBe(5);
    expect(backend.replayedState?.lastSeq).toBe(5);
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
