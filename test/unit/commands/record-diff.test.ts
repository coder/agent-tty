import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ERROR_CODES } from '../../../src/protocol/errors.js';

const mocks = vi.hoisted(() => ({
  emitSuccess: vi.fn(),
  readManifestIfExists: vi.fn(),
  sessionDir: vi.fn(),
  manifestPath: vi.fn(),
  eventLogPath: vi.fn(),
  access: vi.fn(),
  withOfflineReplayRenderer: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  access: mocks.access,
}));

vi.mock('../../../src/cli/output.js', () => ({
  emitSuccess: mocks.emitSuccess,
}));

vi.mock('../../../src/replay/offlineReplay.js', () => ({
  withOfflineReplayRenderer: mocks.withOfflineReplayRenderer,
}));

vi.mock('../../../src/storage/manifests.js', () => ({
  readManifestIfExists: mocks.readManifestIfExists,
}));

vi.mock('../../../src/storage/sessionPaths.js', () => ({
  sessionDir: mocks.sessionDir,
  manifestPath: mocks.manifestPath,
  eventLogPath: mocks.eventLogPath,
}));

import { runRecordDiffCommand } from '../../../src/cli/commands/record-diff.js';
import { computeScreenHash } from '../../../src/renderer/canonicalScreen.js';
import { createLogger } from '../../../src/util/logger.js';
import {
  createTestSemanticSnapshot,
  createTestSessionRecord,
} from '../../helpers.js';

const TEST_CONTEXT = {
  home: '/tmp/agent-tty',
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

interface SnapshotFixture {
  sessionId: string;
  visibleLines: { row: number; text: string }[];
  capturedAtSeq: number;
}

interface MockReplayContext {
  backend: { snapshot: () => Promise<unknown> };
  replayInput: { targetSeq: number; initialCols: number; initialRows: number };
}

function mockReplaySnapshots(fixtures: SnapshotFixture[]): void {
  let call = 0;
  mocks.withOfflineReplayRenderer.mockImplementation(
    async (
      _options: unknown,
      run: (context: MockReplayContext) => Promise<unknown>,
    ) => {
      const fixture = fixtures[call];
      call += 1;
      if (fixture === undefined) {
        throw new Error('unexpected extra replay call');
      }
      // Production snapshots pad visibleLines to exactly `rows`; mirror that
      // so the emitted diff enumerates complete screens.
      return await run({
        backend: {
          snapshot: () =>
            Promise.resolve(
              createTestSemanticSnapshot({
                ...fixture,
                rows: fixture.visibleLines.length,
              }),
            ),
        },
        replayInput: {
          targetSeq: fixture.capturedAtSeq,
          initialCols: 80,
          initialRows: 24,
        },
      });
    },
  );
}

function mockEmptyLogReplay(rows: number, cols: number): void {
  mocks.withOfflineReplayRenderer.mockImplementation(
    async (
      _options: unknown,
      run: (context: MockReplayContext) => Promise<unknown>,
    ) => {
      return await run({
        backend: {
          snapshot: () =>
            Promise.reject(
              new Error('snapshot() must not be called for an empty log'),
            ),
        },
        replayInput: { targetSeq: -1, initialCols: cols, initialRows: rows },
      });
    },
  );
}

function createOptions(
  overrides: Partial<Parameters<typeof runRecordDiffCommand>[0]> = {},
) {
  return {
    context: TEST_CONTEXT,
    json: true,
    sessionIdA: 'session-a',
    sessionIdB: 'session-b',
    atSeqA: undefined,
    atSeqB: undefined,
    ...overrides,
  };
}

describe('runRecordDiffCommand', () => {
  beforeEach(() => {
    mocks.sessionDir.mockImplementation(
      (home: string, sessionId: string) => `${home}/sessions/${sessionId}`,
    );
    mocks.manifestPath.mockImplementation(
      (sessionDirectory: string) => `${sessionDirectory}/session.json`,
    );
    mocks.readManifestIfExists.mockResolvedValue(createTestSessionRecord());
    mocks.eventLogPath.mockImplementation(
      (sessionDirectory: string) => `${sessionDirectory}/events.jsonl`,
    );
    mocks.access.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reports identical screens with an empty diff', async () => {
    const lines = [
      { row: 0, text: 'hello' },
      { row: 1, text: '' },
    ];
    mockReplaySnapshots([
      { sessionId: 'session-a', visibleLines: lines, capturedAtSeq: 4 },
      { sessionId: 'session-b', visibleLines: lines, capturedAtSeq: 9 },
    ]);

    await runRecordDiffCommand(createOptions());

    const expectedHash = computeScreenHash({ visibleLines: lines });
    expect(mocks.emitSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'record diff',
        result: {
          identical: true,
          a: {
            sessionId: 'session-a',
            capturedAtSeq: 4,
            cols: 80,
            rows: 2,
            screenHash: expectedHash,
          },
          b: {
            sessionId: 'session-b',
            capturedAtSeq: 9,
            cols: 80,
            rows: 2,
            screenHash: expectedHash,
          },
          diff: [],
        },
      }),
    );
  });

  it('reports differing screens with an LCS line diff', async () => {
    mockReplaySnapshots([
      {
        sessionId: 'session-a',
        visibleLines: [
          { row: 0, text: 'shared' },
          { row: 1, text: 'old line' },
        ],
        capturedAtSeq: 4,
      },
      {
        sessionId: 'session-b',
        visibleLines: [
          { row: 0, text: 'shared' },
          { row: 1, text: 'new line' },
        ],
        capturedAtSeq: 4,
      },
    ]);

    await runRecordDiffCommand(createOptions());

    expect(mocks.emitSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          identical: false,
          diff: [
            { op: 'equal', text: 'shared', aRow: 0, bRow: 0 },
            { op: 'delete', text: 'old line', aRow: 1 },
            { op: 'add', text: 'new line', bRow: 1 },
          ],
        }) as Record<string, unknown>,
        lines: [
          expect.stringMatching(/^--- session-a @seq 4 \([0-9a-f]{12}\)$/),
          expect.stringMatching(/^\+\+\+ session-b @seq 4 \([0-9a-f]{12}\)$/),
          ' shared',
          '-old line',
          '+new line',
        ],
      }),
    );
  });

  it('synthesizes blank screens for sessions with empty event logs', async () => {
    // A running session that has not emitted its first event yet replays to
    // targetSeq -1; the command must report the valid initial blank screen
    // instead of calling snapshot() (which backends reject before replay).
    mockEmptyLogReplay(24, 80);

    await runRecordDiffCommand(createOptions());

    const blankHash = computeScreenHash({
      visibleLines: Array.from({ length: 24 }, () => ({ text: '' })),
    });
    expect(mocks.emitSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        result: {
          identical: true,
          a: {
            sessionId: 'session-a',
            capturedAtSeq: -1,
            cols: 80,
            rows: 24,
            screenHash: blankHash,
          },
          b: {
            sessionId: 'session-b',
            capturedAtSeq: -1,
            cols: 80,
            rows: 24,
            screenHash: blankHash,
          },
          diff: [],
        },
      }),
    );
  });

  it('fails with REPLAY_ERROR when the event log file is missing', async () => {
    // An empty replay is only authoritative when the zero-length log exists;
    // a deleted or never-written log must not synthesize a blank screen.
    mockEmptyLogReplay(24, 80);
    mocks.access.mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );

    await expect(runRecordDiffCommand(createOptions())).rejects.toMatchObject({
      code: ERROR_CODES.REPLAY_ERROR,
      message: expect.stringContaining('has no event log') as string,
    });
    expect(mocks.emitSuccess).not.toHaveBeenCalled();
  });

  it('rejects non-integer --at-seq values including NaN', async () => {
    await expect(
      runRecordDiffCommand(createOptions({ atSeqA: 1.5 })),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT,
    });
    await expect(
      runRecordDiffCommand(createOptions({ atSeqB: Number.NaN })),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT,
    });
    expect(mocks.withOfflineReplayRenderer).not.toHaveBeenCalled();
  });

  it('replays only once when both selectors are identical', async () => {
    // Diffing a running session against itself must not read the event log
    // twice: output appended between the reads would make the result
    // spuriously non-identical.
    const lines = [{ row: 0, text: 'busy output' }];
    mockReplaySnapshots([
      { sessionId: 'session-a', visibleLines: lines, capturedAtSeq: 3 },
    ]);

    await runRecordDiffCommand(
      createOptions({ sessionIdA: 'session-a', sessionIdB: 'session-a' }),
    );

    expect(mocks.withOfflineReplayRenderer).toHaveBeenCalledTimes(1);
    expect(mocks.emitSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          identical: true,
          diff: [],
        }) as Record<string, unknown>,
      }),
    );
  });

  it('passes --at-seq targets through to offline replay', async () => {
    const lines = [{ row: 0, text: 'x' }];
    mockReplaySnapshots([
      { sessionId: 'session-a', visibleLines: lines, capturedAtSeq: 2 },
      { sessionId: 'session-b', visibleLines: lines, capturedAtSeq: 7 },
    ]);

    await runRecordDiffCommand(createOptions({ atSeqA: 2, atSeqB: 7 }));

    expect(mocks.withOfflineReplayRenderer).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ targetSeq: 2 }),
      expect.any(Function),
    );
    expect(mocks.withOfflineReplayRenderer).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ targetSeq: 7 }),
      expect.any(Function),
    );
  });

  it('rejects negative --at-seq values', async () => {
    await expect(
      runRecordDiffCommand(createOptions({ atSeqA: -1 })),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT,
    });
    expect(mocks.withOfflineReplayRenderer).not.toHaveBeenCalled();
  });

  it('fails with SESSION_NOT_FOUND when a session manifest is missing', async () => {
    mocks.readManifestIfExists.mockResolvedValueOnce(null);

    await expect(runRecordDiffCommand(createOptions())).rejects.toMatchObject({
      code: ERROR_CODES.SESSION_NOT_FOUND,
      details: { sessionId: 'session-a' },
    });
    expect(mocks.withOfflineReplayRenderer).not.toHaveBeenCalled();
  });

  it('wraps replay failures in REPLAY_ERROR', async () => {
    mocks.withOfflineReplayRenderer.mockRejectedValue(
      new Error('backend boot failed'),
    );

    await expect(runRecordDiffCommand(createOptions())).rejects.toMatchObject({
      code: ERROR_CODES.REPLAY_ERROR,
      details: { sessionId: 'session-a' },
    });
  });
});
