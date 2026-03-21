import { createHash } from 'node:crypto';
import process from 'node:process';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ERROR_CODES } from '../../../src/protocol/errors.js';

const mocks = vi.hoisted(() => ({
  emitSuccess: vi.fn(),
  readEventLogRecords: vi.fn(),
  readManifestIfExists: vi.fn(),
  resolveHome: vi.fn(),
  sessionDir: vi.fn(),
  manifestPath: vi.fn(),
  eventLogPath: vi.fn(),
  writeTextFileAtomic: vi.fn(),
  appendArtifact: vi.fn(),
  createArtifactEntry: vi.fn(),
  ensureArtifactsDir: vi.fn(),
  artifactPath: vi.fn(),
  recordingFilename: vi.fn(),
}));

vi.mock('../../../src/cli/output.js', () => ({
  emitSuccess: mocks.emitSuccess,
}));

vi.mock('../../../src/host/replay.js', () => ({
  readEventLogRecords: mocks.readEventLogRecords,
}));

vi.mock('../../../src/storage/manifests.js', () => ({
  readManifestIfExists: mocks.readManifestIfExists,
  writeTextFileAtomic: mocks.writeTextFileAtomic,
}));

vi.mock('../../../src/storage/home.js', () => ({
  resolveHome: mocks.resolveHome,
}));

vi.mock('../../../src/storage/sessionPaths.js', () => ({
  sessionDir: mocks.sessionDir,
  manifestPath: mocks.manifestPath,
  eventLogPath: mocks.eventLogPath,
}));

vi.mock('../../../src/storage/artifactManifest.js', () => ({
  appendArtifact: mocks.appendArtifact,
  createArtifactEntry: mocks.createArtifactEntry,
}));

vi.mock('../../../src/storage/artifactPaths.js', () => ({
  artifactPath: mocks.artifactPath,
  ensureArtifactsDir: mocks.ensureArtifactsDir,
  recordingFilename: mocks.recordingFilename,
}));

import { runRecordExportCommand } from '../../../src/cli/commands/record-export.js';

function createSessionRecord() {
  return {
    version: 1,
    sessionId: 'session-01',
    createdAt: '2026-03-19T12:00:00.000Z',
    updatedAt: '2026-03-19T12:00:01.000Z',
    status: 'running' as const,
    command: ['/bin/sh'],
    cwd: '/tmp/workspace',
    cols: 80,
    rows: 24,
    hostPid: 123,
    childPid: 456,
    exitCode: null,
    exitSignal: null,
  };
}

describe('record export command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveHome.mockReturnValue('/tmp/agent-terminal');
    mocks.sessionDir.mockImplementation(
      (_home: string, sessionId: string) =>
        `/tmp/agent-terminal/sessions/${sessionId}`,
    );
    mocks.manifestPath.mockImplementation(
      (sessionDirectory: string) => `${sessionDirectory}/session.json`,
    );
    mocks.eventLogPath.mockImplementation(
      (sessionDirectory: string) => `${sessionDirectory}/events.jsonl`,
    );
    mocks.readManifestIfExists.mockResolvedValue(createSessionRecord());
    mocks.readEventLogRecords.mockResolvedValue([
      {
        seq: 0,
        ts: '2026-03-19T12:00:02.000Z',
        type: 'output',
        payload: { data: 'hello\n' },
      },
      {
        seq: 1,
        ts: '2026-03-19T12:00:03.500Z',
        type: 'resize',
        payload: { cols: 100, rows: 30 },
      },
    ]);
    mocks.ensureArtifactsDir.mockResolvedValue(
      '/tmp/agent-terminal/sessions/session-01/artifacts',
    );
    mocks.recordingFilename.mockReturnValue('recording-1-asciicast.cast');
    mocks.artifactPath.mockImplementation(
      (sessionDirectory: string, filename: string) =>
        `${sessionDirectory}/artifacts/${filename}`,
    );
    mocks.writeTextFileAtomic.mockResolvedValue(undefined);
    mocks.appendArtifact.mockResolvedValue(undefined);
    mocks.createArtifactEntry.mockImplementation((entry: unknown) => ({
      id: 'artifact-01',
      createdAt: '2026-03-19T12:00:04.000Z',
      ...(entry as Record<string, unknown>),
    }));
  });

  it('exports asciicast artifacts and computes bytes and sha256', async () => {
    await runRecordExportCommand({
      json: true,
      sessionId: 'session-01',
      format: 'asciicast',
    });

    const expectedContents = [
      JSON.stringify({
        version: 2,
        width: 80,
        height: 24,
        timestamp: Date.parse('2026-03-19T12:00:02.000Z') / 1000,
        title: 'session-01',
        env: {
          TERM: 'xterm-256color',
        },
      }),
      JSON.stringify([0, 'o', 'hello\n']),
      JSON.stringify([1.5, 'r', '100x30']),
      '',
    ].join('\n');
    const expectedSha256 = createHash('sha256')
      .update(Buffer.from(expectedContents, 'utf8'))
      .digest('hex');

    expect(mocks.ensureArtifactsDir).toHaveBeenCalledWith(
      '/tmp/agent-terminal/sessions/session-01',
    );
    expect(mocks.writeTextFileAtomic).toHaveBeenCalledWith({
      path: '/tmp/agent-terminal/sessions/session-01/artifacts/recording-1-asciicast.cast',
      pathLabel: 'record export path',
      contents: expectedContents,
      writeErrorMessage:
        'Failed to write record export artifact at /tmp/agent-terminal/sessions/session-01/artifacts/recording-1-asciicast.cast.',
    });
    expect(mocks.createArtifactEntry).toHaveBeenCalledWith({
      kind: 'recording',
      filename: 'recording-1-asciicast.cast',
      sessionId: 'session-01',
      capturedAtSeq: 1,
      sha256: expectedSha256,
      bytes: Buffer.byteLength(expectedContents, 'utf8'),
      metadata: {
        format: 'asciicast',
        outputPath:
          '/tmp/agent-terminal/sessions/session-01/artifacts/recording-1-asciicast.cast',
        width: 80,
        height: 24,
        title: 'session-01',
        timestamp: Date.parse('2026-03-19T12:00:02.000Z') / 1000,
        outputEventCount: 1,
        resizeEventCount: 1,
      },
    });
    expect(mocks.appendArtifact).toHaveBeenCalledWith(
      '/tmp/agent-terminal/sessions/session-01',
      expect.objectContaining({
        kind: 'recording',
        filename: 'recording-1-asciicast.cast',
        sha256: expectedSha256,
        bytes: Buffer.byteLength(expectedContents, 'utf8'),
      }),
    );
    expect(mocks.emitSuccess).toHaveBeenCalledWith({
      command: 'record export',
      json: true,
      result: {
        sessionId: 'session-01',
        format: 'asciicast',
        artifactPath:
          '/tmp/agent-terminal/sessions/session-01/artifacts/recording-1-asciicast.cast',
        bytes: Buffer.byteLength(expectedContents, 'utf8'),
        sha256: expectedSha256,
        capturedAtSeq: 1,
        durationMs: 1500,
        metadata: {
          width: 80,
          height: 24,
          title: 'session-01',
          timestamp: Date.parse('2026-03-19T12:00:02.000Z') / 1000,
          outputEventCount: 1,
          resizeEventCount: 1,
        },
      },
      lines: [
        'Session ID: session-01',
        'Format: asciicast',
        'Captured At Seq: 1',
        'Artifact Path: /tmp/agent-terminal/sessions/session-01/artifacts/recording-1-asciicast.cast',
        `Bytes: ${String(Buffer.byteLength(expectedContents, 'utf8'))}`,
        `SHA256: ${expectedSha256}`,
        'Duration: 1500 ms',
      ],
    });
  });

  it('writes explicit relative output paths within the current working directory', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/workspace');

    try {
      await runRecordExportCommand({
        json: false,
        sessionId: 'session-01',
        format: 'asciicast',
        out: 'exports/custom.cast',
      });
    } finally {
      cwdSpy.mockRestore();
    }

    expect(mocks.ensureArtifactsDir).not.toHaveBeenCalled();
    expect(mocks.writeTextFileAtomic).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/workspace/exports/custom.cast',
      }),
    );
    const createArtifactEntryCall = mocks.createArtifactEntry.mock.calls.at(-1);

    expect(createArtifactEntryCall).toBeDefined();
    expect(createArtifactEntryCall?.[0]).toMatchObject({
      filename: 'custom.cast',
      metadata: {
        outputPath: '/workspace/exports/custom.cast',
      },
    });
  });

  it('rejects invalid and unimplemented formats', async () => {
    await expect(
      runRecordExportCommand({
        json: false,
        sessionId: 'session-01',
        format: 'bogus',
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT,
    });

    await expect(
      runRecordExportCommand({
        json: false,
        sessionId: 'session-01',
        format: 'webm',
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.EXPORT_ERROR,
    });
  });
});
