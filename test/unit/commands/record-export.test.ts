import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type * as FsPromises from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  generateWebmExport: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
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

vi.mock('../../../src/export/webm.js', () => ({
  generateWebmExport: mocks.generateWebmExport,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    stat: mocks.stat,
    readFile: mocks.readFile,
  };
});

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

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
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
    expect(mocks.stat).not.toHaveBeenCalled();
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.generateWebmExport).not.toHaveBeenCalled();
  });

  it('exports webm artifacts via generateWebmExport', async () => {
    mocks.recordingFilename.mockReturnValue('recording-1-webm.webm');

    const webmBytes = 12_345;
    const webmContent = Buffer.alloc(webmBytes, 0x42);
    const webmSha256 = createHash('sha256').update(webmContent).digest('hex');

    mocks.generateWebmExport.mockResolvedValue({
      capturedAtSeq: 1,
      durationMs: 1_500,
      outputEventCount: 1,
      resizeEventCount: 1,
      cols: 80,
      rows: 24,
      profileName: 'reference-dark',
      timingMode: 'accelerated',
    });
    mocks.stat.mockResolvedValue({ size: webmBytes });
    mocks.readFile.mockResolvedValue(webmContent);

    await runRecordExportCommand({
      json: true,
      sessionId: 'session-01',
      format: 'webm',
    });

    expect(mocks.generateWebmExport).toHaveBeenCalledTimes(1);
    const generateWebmExportCall = mocks.generateWebmExport.mock.calls[0] as [
      {
        sessionId: string;
        sessionDir: string;
        manifest: ReturnType<typeof createSessionRecord>;
        events: unknown[];
        outputPath: string;
      },
    ];
    const [generateWebmExportArgs] = generateWebmExportCall;

    expect(generateWebmExportArgs.sessionId).toBe('session-01');
    expect(generateWebmExportArgs.sessionDir).toBe(
      '/tmp/agent-terminal/sessions/session-01',
    );
    expect(generateWebmExportArgs.manifest).toEqual(createSessionRecord());
    expect(generateWebmExportArgs.events).toEqual([
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
    expect(generateWebmExportArgs.outputPath).toBe(
      '/tmp/agent-terminal/sessions/session-01/artifacts/recording-1-webm.webm',
    );
    expect(mocks.writeTextFileAtomic).not.toHaveBeenCalled();
    expect(mocks.stat).toHaveBeenCalledWith(
      '/tmp/agent-terminal/sessions/session-01/artifacts/recording-1-webm.webm',
    );
    expect(mocks.readFile).toHaveBeenCalledWith(
      '/tmp/agent-terminal/sessions/session-01/artifacts/recording-1-webm.webm',
    );

    expect(mocks.createArtifactEntry).toHaveBeenCalledTimes(1);
    const createArtifactEntryCall = mocks.createArtifactEntry.mock.calls[0] as [
      {
        kind: string;
        filename: string;
        bytes: number;
        sha256: string;
        metadata: Record<string, unknown>;
      },
    ];
    const [artifactEntry] = createArtifactEntryCall;

    expect(artifactEntry.kind).toBe('video');
    expect(artifactEntry.filename).toBe('recording-1-webm.webm');
    expect(artifactEntry.bytes).toBe(webmBytes);
    expect(artifactEntry.sha256).toBe(webmSha256);
    expect(artifactEntry.metadata.format).toBe('webm');
    expect(artifactEntry.metadata.profileName).toBe('reference-dark');
    expect(artifactEntry.metadata.timingMode).toBe('accelerated');

    expect(mocks.emitSuccess).toHaveBeenCalledTimes(1);
    const emitSuccessCall = mocks.emitSuccess.mock.calls[0] as [
      {
        command: string;
        json: boolean;
        result: {
          sessionId: string;
          format: string;
          bytes: number;
          sha256: string;
          capturedAtSeq: number;
          durationMs?: number;
        };
      },
    ];
    const [emitSuccessArgs] = emitSuccessCall;

    expect(emitSuccessArgs.command).toBe('record export');
    expect(emitSuccessArgs.json).toBe(true);
    expect(emitSuccessArgs.result.sessionId).toBe('session-01');
    expect(emitSuccessArgs.result.format).toBe('webm');
    expect(emitSuccessArgs.result.bytes).toBe(webmBytes);
    expect(emitSuccessArgs.result.sha256).toBe(webmSha256);
    expect(emitSuccessArgs.result.capturedAtSeq).toBe(1);
    expect(emitSuccessArgs.result.durationMs).toBe(1_500);
  });

  it('throws SESSION_NOT_FOUND when manifest does not exist', async () => {
    mocks.readManifestIfExists.mockResolvedValue(null);

    await expect(
      runRecordExportCommand({
        json: false,
        sessionId: 'session-01',
        format: 'asciicast',
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.SESSION_NOT_FOUND,
      details: {
        sessionId: 'session-01',
        manifestPath: '/tmp/agent-terminal/sessions/session-01/session.json',
      },
    });
    expect(mocks.readEventLogRecords).not.toHaveBeenCalled();
    expect(mocks.emitSuccess).not.toHaveBeenCalled();
  });

  it('writes explicit relative output paths within the current working directory', async () => {
    const workspaceDirectory = await createTemporaryDirectory(
      'agent-terminal-record-export-workspace-',
    );
    const exportsDirectory = join(workspaceDirectory, 'exports');
    await mkdir(exportsDirectory, { recursive: true });
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(workspaceDirectory);

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
        path: join(exportsDirectory, 'custom.cast'),
      }),
    );
    const createArtifactEntryCall = mocks.createArtifactEntry.mock.calls.at(-1);

    expect(createArtifactEntryCall).toBeDefined();
    expect(createArtifactEntryCall?.[0]).toMatchObject({
      filename: 'custom.cast',
      metadata: {
        outputPath: join(exportsDirectory, 'custom.cast'),
      },
    });
  });

  it('resolves symlinked output directories to their real paths', async () => {
    const workspaceDirectory = await createTemporaryDirectory(
      'agent-terminal-record-export-realpath-',
    );
    const realExportsDirectory = join(workspaceDirectory, 'real-exports');
    const symlinkExportsDirectory = join(workspaceDirectory, 'linked-exports');
    await mkdir(realExportsDirectory, { recursive: true });
    await symlink(realExportsDirectory, symlinkExportsDirectory);

    await runRecordExportCommand({
      json: false,
      sessionId: 'session-01',
      format: 'asciicast',
      out: join(symlinkExportsDirectory, 'custom.cast'),
    });

    expect(mocks.ensureArtifactsDir).not.toHaveBeenCalled();
    expect(mocks.writeTextFileAtomic).toHaveBeenCalledWith(
      expect.objectContaining({
        path: join(realExportsDirectory, 'custom.cast'),
      }),
    );
    const createArtifactEntryCall = mocks.createArtifactEntry.mock.calls.at(-1);

    expect(createArtifactEntryCall).toBeDefined();
    expect(createArtifactEntryCall?.[0]).toMatchObject({
      filename: 'custom.cast',
      metadata: {
        outputPath: join(realExportsDirectory, 'custom.cast'),
      },
    });
  });

  it('rejects output paths whose parent directory does not exist', async () => {
    const workspaceDirectory = await createTemporaryDirectory(
      'agent-terminal-record-export-missing-parent-',
    );

    await expect(
      runRecordExportCommand({
        json: false,
        sessionId: 'session-01',
        format: 'asciicast',
        out: join(workspaceDirectory, 'missing', 'custom.cast'),
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.EXPORT_ERROR,
    });
  });

  it('rejects invalid formats', async () => {
    await expect(
      runRecordExportCommand({
        json: false,
        sessionId: 'session-01',
        format: 'bogus',
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT,
    });
  });
});
