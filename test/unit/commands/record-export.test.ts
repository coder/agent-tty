import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';

import type * as FsPromises from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ERROR_CODES, makeCliError } from '../../../src/protocol/errors.js';

const mocks = vi.hoisted(() => ({
  emitSuccess: vi.fn(),
  readEventLogRecords: vi.fn(),
  readManifestIfExists: vi.fn(),
  resolveHome: vi.fn(),
  sessionDir: vi.fn(),
  manifestPath: vi.fn(),
  eventLogPath: vi.fn(),
  writeTextFileAtomic: vi.fn(),
  appendArtifactWithRollback: vi.fn(),
  // Test-internal delegate used by the appendArtifactWithRollback mock.
  appendArtifact: vi.fn(),
  createArtifactEntry: vi.fn(),
  ensureArtifactsDir: vi.fn(),
  artifactPath: vi.fn(),
  recordingFilename: vi.fn(),
  generateWebmExport: vi.fn(),
  loadPackageMetadata: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('../../../src/cli/output.js', () => ({
  emitSuccess: mocks.emitSuccess,
}));

vi.mock('../../../src/storage/eventLogCodec.js', () => ({
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
  appendArtifactWithRollback: mocks.appendArtifactWithRollback,
  createArtifactEntry: mocks.createArtifactEntry,
}));

vi.mock('../../../src/storage/artifactPaths.js', () => ({
  artifactPath: mocks.artifactPath,
  ensureArtifactsDir: mocks.ensureArtifactsDir,
  recordingFilename: mocks.recordingFilename,
}));

vi.mock('../../../src/util/packageMetadata.js', () => ({
  loadPackageMetadata: mocks.loadPackageMetadata,
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
import { hashProfile, resolveProfile } from '../../../src/renderer/profiles.js';
import { createLogger } from '../../../src/util/logger.js';

const TEST_CONTEXT = {
  home: '/tmp/agent-tty',
  timeoutMs: undefined,
  colorEnabled: true,
  logLevel: 'info',
  logger: createLogger('info', () => undefined),
  profileDefault: undefined,
  rendererDefault: 'ghostty-web',
  explicitHome: false,
  configFile: null,
} as const;

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
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

describe('record export command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveHome.mockReturnValue('/tmp/agent-tty');
    mocks.sessionDir.mockImplementation(
      (_home: string, sessionId: string) =>
        `/tmp/agent-tty/sessions/${sessionId}`,
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
      '/tmp/agent-tty/sessions/session-01/artifacts',
    );
    mocks.loadPackageMetadata.mockResolvedValue({
      name: 'agent-tty',
      version: '0.1.0-test',
    });
    mocks.recordingFilename.mockReturnValue('recording-1-asciicast.cast');
    mocks.artifactPath.mockImplementation(
      (sessionDirectory: string, filename: string) =>
        `${sessionDirectory}/artifacts/${filename}`,
    );
    mocks.writeTextFileAtomic.mockResolvedValue(undefined);
    mocks.appendArtifactWithRollback.mockImplementation(
      async (options: {
        sessionDir: string;
        entry: unknown;
        rollbackArtifactPath?: string;
      }) => {
        try {
          await mocks.appendArtifact(options.sessionDir, options.entry);
        } catch (error) {
          if (options.rollbackArtifactPath !== undefined) {
            await rm(options.rollbackArtifactPath, { force: true }).catch(
              () => undefined,
            );
          }
          throw error;
        }
      },
    );
    mocks.appendArtifact.mockResolvedValue(undefined);
    mocks.createArtifactEntry.mockImplementation((entry: unknown) => ({
      id: 'artifact-01',
      createdAt: '2026-03-19T12:00:04.000Z',
      ...(entry as Record<string, unknown>),
    }));
  });

  it('exports asciicast artifacts and computes bytes and sha256', async () => {
    mocks.recordingFilename.mockReturnValue('recording-2-asciicast.cast');
    mocks.readEventLogRecords.mockResolvedValue([
      {
        seq: 0,
        ts: '2026-03-19T12:00:02.000Z',
        type: 'output',
        payload: { data: 'hello\n' },
      },
      {
        seq: 1,
        ts: '2026-03-19T12:00:02.750Z',
        type: 'marker',
        payload: { label: 'checkpoint' },
      },
      {
        seq: 2,
        ts: '2026-03-19T12:00:03.500Z',
        type: 'resize',
        payload: { cols: 100, rows: 30 },
      },
    ]);

    await runRecordExportCommand({
      context: TEST_CONTEXT,
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
        sessionId: 'session-01',
        env: {
          TERM: 'xterm-256color',
        },
        toolVersion: '0.1.0-test',
      }),
      JSON.stringify([0, 'o', 'hello\n']),
      JSON.stringify([0.75, 'm', 'checkpoint']),
      JSON.stringify([1.5, 'r', '100x30']),
      '',
    ].join('\n');
    const expectedSha256 = createHash('sha256')
      .update(Buffer.from(expectedContents, 'utf8'))
      .digest('hex');

    expect(mocks.loadPackageMetadata).toHaveBeenCalledTimes(1);

    expect(mocks.ensureArtifactsDir).toHaveBeenCalledWith(
      '/tmp/agent-tty/sessions/session-01',
    );
    expect(mocks.writeTextFileAtomic).toHaveBeenCalledWith({
      path: '/tmp/agent-tty/sessions/session-01/artifacts/recording-2-asciicast.cast',
      pathLabel: 'record export path',
      contents: expectedContents,
      writeErrorMessage:
        'Failed to write record export artifact at /tmp/agent-tty/sessions/session-01/artifacts/recording-2-asciicast.cast.',
    });
    expect(mocks.createArtifactEntry).toHaveBeenCalledWith({
      kind: 'recording',
      filename: 'recording-2-asciicast.cast',
      sessionId: 'session-01',
      capturedAtSeq: 2,
      sha256: expectedSha256,
      bytes: Buffer.byteLength(expectedContents, 'utf8'),
      metadata: {
        format: 'asciicast',
        outputPath:
          '/tmp/agent-tty/sessions/session-01/artifacts/recording-2-asciicast.cast',
        width: 80,
        height: 24,
        title: 'session-01',
        timestamp: Date.parse('2026-03-19T12:00:02.000Z') / 1000,
        outputEventCount: 1,
        resizeEventCount: 1,
        markerCount: 1,
      },
    });
    const appendCall = mocks.appendArtifactWithRollback.mock.calls.at(-1) as [
      {
        sessionDir: string;
        entry: Record<string, unknown>;
        rollbackArtifactPath?: string;
      },
    ];
    expect(appendCall[0]).toMatchObject({
      sessionDir: '/tmp/agent-tty/sessions/session-01',
      rollbackArtifactPath:
        '/tmp/agent-tty/sessions/session-01/artifacts/recording-2-asciicast.cast',
    });
    expect(appendCall[0].entry).toMatchObject({
      kind: 'recording',
      filename: 'recording-2-asciicast.cast',
      sha256: expectedSha256,
      bytes: Buffer.byteLength(expectedContents, 'utf8'),
    });
    expect(mocks.emitSuccess).toHaveBeenCalledWith({
      command: 'record export',
      json: true,
      result: {
        sessionId: 'session-01',
        format: 'asciicast',
        artifactPath:
          '/tmp/agent-tty/sessions/session-01/artifacts/recording-2-asciicast.cast',
        bytes: Buffer.byteLength(expectedContents, 'utf8'),
        sha256: expectedSha256,
        capturedAtSeq: 2,
        durationMs: 1500,
        metadata: {
          width: 80,
          height: 24,
          title: 'session-01',
          timestamp: Date.parse('2026-03-19T12:00:02.000Z') / 1000,
          outputEventCount: 1,
          resizeEventCount: 1,
          markerCount: 1,
        },
      },
      lines: [
        'Session ID: session-01',
        'Format: asciicast',
        'Captured At Seq: 2',
        'Artifact Path: /tmp/agent-tty/sessions/session-01/artifacts/recording-2-asciicast.cast',
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

    const expectedRenderProfileHash = hashProfile(
      resolveProfile('reference-dark'),
    );

    mocks.generateWebmExport.mockResolvedValue({
      capturedAtSeq: 1,
      durationMs: 1_500,
      outputEventCount: 1,
      resizeEventCount: 1,
      cols: 80,
      rows: 24,
      profileName: 'reference-dark',
      timingMode: 'recorded',
      rendererBackend: 'ghostty-web',
    });
    mocks.stat.mockResolvedValue({ size: webmBytes });
    mocks.readFile.mockResolvedValue(webmContent);

    await runRecordExportCommand({
      context: TEST_CONTEXT,
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
        rendererName?: string;
      },
    ];
    const [generateWebmExportArgs] = generateWebmExportCall;

    expect(generateWebmExportArgs.sessionId).toBe('session-01');
    expect(generateWebmExportArgs.sessionDir).toBe(
      '/tmp/agent-tty/sessions/session-01',
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
      '/tmp/agent-tty/sessions/session-01/artifacts/recording-1-webm.webm',
    );
    expect(generateWebmExportArgs.rendererName).toBe('ghostty-web');
    expect(mocks.writeTextFileAtomic).not.toHaveBeenCalled();
    expect(mocks.stat).toHaveBeenCalledWith(
      '/tmp/agent-tty/sessions/session-01/artifacts/recording-1-webm.webm',
    );
    expect(mocks.readFile).toHaveBeenCalledWith(
      '/tmp/agent-tty/sessions/session-01/artifacts/recording-1-webm.webm',
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
    expect(artifactEntry.metadata.renderProfileHash).toBe(
      expectedRenderProfileHash,
    );
    expect(artifactEntry.metadata.profileName).toBe('reference-dark');
    expect(artifactEntry.metadata.timingMode).toBe('recorded');
    expect(artifactEntry.metadata.rendererBackend).toBe('ghostty-web');

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
          metadata: Record<string, unknown>;
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
    expect(emitSuccessArgs.result.metadata.renderProfileHash).toBe(
      expectedRenderProfileHash,
    );
    expect(emitSuccessArgs.result.metadata.rendererBackend).toBe('ghostty-web');
    expect(emitSuccessArgs.result.durationMs).toBe(1_500);
  });

  it('requests rollback for default asciicast artifacts when manifest append fails', async () => {
    const sessionDirectory = await createTemporaryDirectory(
      'agent-tty-record-export-append-asciicast-',
    );
    const artifactFile = join(
      sessionDirectory,
      'artifacts',
      'recording-2-asciicast.cast',
    );
    const manifestError = makeCliError(ERROR_CODES.MANIFEST_VALIDATION_ERROR, {
      message: 'artifact manifest append failed',
    });

    mocks.sessionDir.mockReturnValue(sessionDirectory);
    mocks.manifestPath.mockReturnValue(join(sessionDirectory, 'session.json'));
    mocks.eventLogPath.mockReturnValue(join(sessionDirectory, 'events.jsonl'));
    mocks.ensureArtifactsDir.mockResolvedValue(
      join(sessionDirectory, 'artifacts'),
    );
    mocks.recordingFilename.mockReturnValue('recording-2-asciicast.cast');
    mocks.writeTextFileAtomic.mockImplementation(
      async (options: { path: string; contents: string }) => {
        await mkdir(dirname(options.path), { recursive: true });
        await writeFile(options.path, options.contents, 'utf8');
      },
    );
    mocks.appendArtifact.mockRejectedValue(manifestError);

    await expect(
      runRecordExportCommand({
        context: TEST_CONTEXT,
        json: true,
        sessionId: 'session-01',
        format: 'asciicast',
      }),
    ).rejects.toBe(manifestError);

    expect(mocks.appendArtifactWithRollback).toHaveBeenCalledWith(
      expect.objectContaining({ rollbackArtifactPath: artifactFile }),
    );
    expect(mocks.emitSuccess).not.toHaveBeenCalled();
  });

  it('requests rollback for default webm artifacts when manifest append fails', async () => {
    const sessionDirectory = await createTemporaryDirectory(
      'agent-tty-record-export-append-webm-',
    );
    const artifactFile = join(
      sessionDirectory,
      'artifacts',
      'recording-1-webm.webm',
    );
    const webmBytes = 12_345;
    const webmContent = Buffer.alloc(webmBytes, 0x42);
    const manifestError = makeCliError(ERROR_CODES.MANIFEST_VALIDATION_ERROR, {
      message: 'artifact manifest append failed',
    });

    mocks.sessionDir.mockReturnValue(sessionDirectory);
    mocks.manifestPath.mockReturnValue(join(sessionDirectory, 'session.json'));
    mocks.eventLogPath.mockReturnValue(join(sessionDirectory, 'events.jsonl'));
    mocks.ensureArtifactsDir.mockResolvedValue(
      join(sessionDirectory, 'artifacts'),
    );
    mocks.recordingFilename.mockReturnValue('recording-1-webm.webm');
    mocks.generateWebmExport.mockImplementation(
      async (options: { outputPath: string }) => {
        await mkdir(dirname(options.outputPath), { recursive: true });
        await writeFile(options.outputPath, webmContent);
        return {
          capturedAtSeq: 1,
          durationMs: 1_500,
          outputEventCount: 1,
          resizeEventCount: 1,
          cols: 80,
          rows: 24,
          profileName: 'reference-dark',
          timingMode: 'recorded',
          rendererBackend: 'ghostty-web',
        };
      },
    );
    mocks.stat.mockResolvedValue({ size: webmBytes });
    mocks.readFile.mockResolvedValue(webmContent);
    mocks.appendArtifact.mockRejectedValue(manifestError);

    await expect(
      runRecordExportCommand({
        context: TEST_CONTEXT,
        json: true,
        sessionId: 'session-01',
        format: 'webm',
      }),
    ).rejects.toBe(manifestError);

    expect(mocks.appendArtifactWithRollback).toHaveBeenCalledWith(
      expect.objectContaining({ rollbackArtifactPath: artifactFile }),
    );
    expect(mocks.emitSuccess).not.toHaveBeenCalled();
  });

  it('preserves explicit output artifacts when manifest append fails', async () => {
    const workspaceDirectory = await createTemporaryDirectory(
      'agent-tty-record-export-explicit-out-',
    );
    const artifactFile = join(workspaceDirectory, 'custom.cast');
    const manifestError = makeCliError(ERROR_CODES.MANIFEST_VALIDATION_ERROR, {
      message: 'artifact manifest append failed',
    });

    mocks.writeTextFileAtomic.mockImplementation(
      async (options: { path: string; contents: string }) => {
        await mkdir(dirname(options.path), { recursive: true });
        await writeFile(options.path, options.contents, 'utf8');
      },
    );
    mocks.appendArtifact.mockRejectedValue(manifestError);

    await expect(
      runRecordExportCommand({
        context: TEST_CONTEXT,
        json: true,
        sessionId: 'session-01',
        format: 'asciicast',
        out: artifactFile,
      }),
    ).rejects.toBe(manifestError);

    const appendCall = mocks.appendArtifactWithRollback.mock.calls.at(-1) as [
      { rollbackArtifactPath?: string },
    ];
    expect(appendCall[0]).not.toHaveProperty('rollbackArtifactPath');
    await expect(access(artifactFile)).resolves.toBeUndefined();
    expect(mocks.emitSuccess).not.toHaveBeenCalled();
  });

  it('resolves WebM profile from command option, context default, and builtin fallback', async () => {
    mocks.recordingFilename.mockReturnValue('recording-1-webm.webm');
    mocks.generateWebmExport.mockResolvedValue({
      capturedAtSeq: 1,
      durationMs: 1_500,
      outputEventCount: 1,
      resizeEventCount: 1,
      cols: 80,
      rows: 24,
      profileName: 'reference-light',
      timingMode: 'recorded',
      rendererBackend: 'ghostty-web',
    });
    const webmBytes = 12_345;
    const webmContent = Buffer.alloc(webmBytes, 0x42);
    mocks.stat.mockResolvedValue({ size: webmBytes });
    mocks.readFile.mockResolvedValue(webmContent);

    await runRecordExportCommand({
      context: { ...TEST_CONTEXT, profileDefault: 'reference-light' },
      json: true,
      sessionId: 'session-01',
      format: 'webm',
    });

    const contextDefaultCall = mocks.generateWebmExport.mock.calls.at(-1) as [
      { profileName?: string },
    ];
    expect(contextDefaultCall[0].profileName).toBe('reference-light');

    mocks.generateWebmExport.mockClear();

    await runRecordExportCommand({
      context: { ...TEST_CONTEXT, profileDefault: 'reference-light' },
      json: true,
      sessionId: 'session-01',
      format: 'webm',
      profile: 'reference-dark',
    });

    const commandProfileCall = mocks.generateWebmExport.mock.calls.at(-1) as [
      { profileName?: string },
    ];
    expect(commandProfileCall[0].profileName).toBe('reference-dark');

    mocks.generateWebmExport.mockClear();

    await runRecordExportCommand({
      context: TEST_CONTEXT,
      json: true,
      sessionId: 'session-01',
      format: 'webm',
    });

    const builtinFallbackCall = mocks.generateWebmExport.mock.calls.at(-1) as [
      { profileName?: string },
    ];
    expect(builtinFallbackCall[0]).not.toHaveProperty('profileName');
  });

  it('passes timing mode to generateWebmExport for webm export', async () => {
    mocks.recordingFilename.mockReturnValue('recording-1-webm.webm');
    mocks.generateWebmExport.mockResolvedValue({
      capturedAtSeq: 1,
      durationMs: 1_500,
      outputEventCount: 1,
      resizeEventCount: 1,
      cols: 80,
      rows: 24,
      profileName: 'reference-dark',
      timingMode: 'recorded',
      rendererBackend: 'ghostty-web',
    });
    const webmBytes = 12_345;
    const webmContent = Buffer.alloc(webmBytes, 0x42);
    mocks.stat.mockResolvedValue({ size: webmBytes });
    mocks.readFile.mockResolvedValue(webmContent);

    await runRecordExportCommand({
      context: TEST_CONTEXT,
      json: true,
      sessionId: 'session-01',
      format: 'webm',
      timing: 'recorded',
    });

    expect(mocks.generateWebmExport).toHaveBeenCalledTimes(1);
    const callArgs = mocks.generateWebmExport.mock.calls[0] as [
      { timingMode?: string },
    ];
    expect(callArgs[0].timingMode).toBe('recorded');
  });

  it('passes max-speed timing mode through to generateWebmExport', async () => {
    mocks.recordingFilename.mockReturnValue('recording-1-webm.webm');
    mocks.generateWebmExport.mockResolvedValue({
      capturedAtSeq: 1,
      durationMs: 1_500,
      outputEventCount: 1,
      resizeEventCount: 1,
      cols: 80,
      rows: 24,
      profileName: 'reference-dark',
      timingMode: 'max-speed',
      rendererBackend: 'ghostty-web',
    });
    const webmBytes = 12_345;
    const webmContent = Buffer.alloc(webmBytes, 0x42);
    mocks.stat.mockResolvedValue({ size: webmBytes });
    mocks.readFile.mockResolvedValue(webmContent);

    await runRecordExportCommand({
      context: TEST_CONTEXT,
      json: true,
      sessionId: 'session-01',
      format: 'webm',
      timing: 'max-speed',
    });

    expect(mocks.generateWebmExport).toHaveBeenCalledTimes(1);
    const callArgs = mocks.generateWebmExport.mock.calls[0] as [
      { timingMode?: string },
    ];
    expect(callArgs[0].timingMode).toBe('max-speed');
  });

  it('omits timingMode from generateWebmExport when timing is not specified', async () => {
    mocks.recordingFilename.mockReturnValue('recording-1-webm.webm');
    mocks.generateWebmExport.mockResolvedValue({
      capturedAtSeq: 1,
      durationMs: 1_500,
      outputEventCount: 1,
      resizeEventCount: 1,
      cols: 80,
      rows: 24,
      profileName: 'reference-dark',
      timingMode: 'recorded',
      rendererBackend: 'ghostty-web',
    });
    const webmBytes = 12_345;
    const webmContent = Buffer.alloc(webmBytes, 0x42);
    mocks.stat.mockResolvedValue({ size: webmBytes });
    mocks.readFile.mockResolvedValue(webmContent);

    await runRecordExportCommand({
      context: TEST_CONTEXT,
      json: true,
      sessionId: 'session-01',
      format: 'webm',
    });

    const callArgs = mocks.generateWebmExport.mock.calls[0] as [
      { timingMode?: string },
    ];
    expect(callArgs[0]).not.toHaveProperty('timingMode');
  });

  it('rejects invalid timing mode', async () => {
    await expect(
      runRecordExportCommand({
        context: TEST_CONTEXT,
        json: false,
        sessionId: 'session-01',
        format: 'webm',
        timing: 'turbo',
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT,
    });
    expect(mocks.generateWebmExport).not.toHaveBeenCalled();
  });

  it('reports timing mode in artifact and result metadata for webm export', async () => {
    mocks.recordingFilename.mockReturnValue('recording-1-webm.webm');
    mocks.generateWebmExport.mockResolvedValue({
      capturedAtSeq: 1,
      durationMs: 1_500,
      outputEventCount: 1,
      resizeEventCount: 1,
      cols: 80,
      rows: 24,
      profileName: 'reference-dark',
      timingMode: 'max-speed',
      rendererBackend: 'ghostty-web',
    });
    const webmBytes = 12_345;
    const webmContent = Buffer.alloc(webmBytes, 0x42);
    mocks.stat.mockResolvedValue({ size: webmBytes });
    mocks.readFile.mockResolvedValue(webmContent);

    await runRecordExportCommand({
      context: TEST_CONTEXT,
      json: true,
      sessionId: 'session-01',
      format: 'webm',
      timing: 'max-speed',
    });

    const artifactCall = mocks.createArtifactEntry.mock.calls[0] as [
      { metadata: Record<string, unknown> },
    ];
    expect(artifactCall[0].metadata.timingMode).toBe('max-speed');

    const emitCall = mocks.emitSuccess.mock.calls[0] as [
      { result: { metadata: Record<string, unknown> } },
    ];
    expect(emitCall[0].result.metadata.timingMode).toBe('max-speed');
  });

  it('throws SESSION_NOT_FOUND when manifest does not exist', async () => {
    mocks.readManifestIfExists.mockResolvedValue(null);

    await expect(
      runRecordExportCommand({
        context: TEST_CONTEXT,
        json: false,
        sessionId: 'session-01',
        format: 'asciicast',
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.SESSION_NOT_FOUND,
      details: {
        sessionId: 'session-01',
        manifestPath: '/tmp/agent-tty/sessions/session-01/session.json',
      },
    });
    expect(mocks.readEventLogRecords).not.toHaveBeenCalled();
    expect(mocks.emitSuccess).not.toHaveBeenCalled();
  });

  it('writes explicit relative output paths within the current working directory', async () => {
    const workspaceDirectory = await createTemporaryDirectory(
      'agent-tty-record-export-workspace-',
    );
    const exportsDirectory = join(workspaceDirectory, 'exports');
    await mkdir(exportsDirectory, { recursive: true });
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(workspaceDirectory);

    try {
      await runRecordExportCommand({
        context: TEST_CONTEXT,
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
      'agent-tty-record-export-realpath-',
    );
    const realExportsDirectory = join(workspaceDirectory, 'real-exports');
    const symlinkExportsDirectory = join(workspaceDirectory, 'linked-exports');
    await mkdir(realExportsDirectory, { recursive: true });
    await symlink(realExportsDirectory, symlinkExportsDirectory);

    await runRecordExportCommand({
      context: TEST_CONTEXT,
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
      'agent-tty-record-export-missing-parent-',
    );

    await expect(
      runRecordExportCommand({
        context: TEST_CONTEXT,
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
        context: TEST_CONTEXT,
        json: false,
        sessionId: 'session-01',
        format: 'bogus',
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT,
    });
  });
});
