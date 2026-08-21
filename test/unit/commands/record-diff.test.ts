import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ERROR_CODES } from '../../../src/protocol/errors.js';

const mocks = vi.hoisted(() => ({
  emitSuccess: vi.fn(),
  readManifestIfExists: vi.fn(),
  sessionDir: vi.fn(),
  manifestPath: vi.fn(),
  withOfflineReplayRenderer: vi.fn(),
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

function mockReplaySnapshots(fixtures: SnapshotFixture[]): void {
  let call = 0;
  mocks.withOfflineReplayRenderer.mockImplementation(
    async (
      _options: unknown,
      run: (context: {
        backend: { snapshot: () => Promise<unknown> };
      }) => Promise<unknown>,
    ) => {
      const fixture = fixtures[call];
      call += 1;
      if (fixture === undefined) {
        throw new Error('unexpected extra replay call');
      }
      return await run({
        backend: {
          snapshot: () => Promise.resolve(createTestSemanticSnapshot(fixture)),
        },
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
            rows: 24,
            screenHash: expectedHash,
          },
          b: {
            sessionId: 'session-b',
            capturedAtSeq: 9,
            cols: 80,
            rows: 24,
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
