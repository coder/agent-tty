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

import type * as EventLogCodecModule from '../../../src/storage/eventLogCodec.js';
import type * as HomeModule from '../../../src/storage/home.js';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ERROR_CODES, makeCliError } from '../../../src/protocol/errors.js';
import { EventLogTooLargeError } from '../../../src/storage/eventLogCodec.js';

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
  fileIdentity: vi.fn(),
  // Test-internal delegate used by the appendArtifactWithRollback mock.
  appendArtifact: vi.fn(),
  createArtifactEntry: vi.fn(),
  ensureArtifactsDir: vi.fn(),
  artifactPath: vi.fn(),
  recordingFilename: vi.fn(),
  generateWebmExport: vi.fn(),
  captureGridFrames: vi.fn(),
  renderGridFramesToSvg: vi.fn(),
  loadPackageMetadata: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
  rename: vi.fn(),
}));

vi.mock('../../../src/cli/output.js', () => ({
  emitSuccess: mocks.emitSuccess,
}));

vi.mock('../../../src/storage/eventLogCodec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof EventLogCodecModule>()),
  readEventLogRecords: mocks.readEventLogRecords,
}));

vi.mock('../../../src/storage/manifests.js', () => ({
  readManifestIfExists: mocks.readManifestIfExists,
  writeTextFileAtomic: mocks.writeTextFileAtomic,
}));

vi.mock('../../../src/storage/home.js', async (importOriginal) => ({
  ...(await importOriginal<typeof HomeModule>()),
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
  fileIdentity: mocks.fileIdentity,
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

vi.mock('../../../src/replay/gridFrames.js', () => ({
  captureGridFrames: mocks.captureGridFrames,
}));

vi.mock('../../../src/export/svg.js', () => ({
  renderGridFramesToSvg: mocks.renderGridFramesToSvg,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    stat: mocks.stat,
    readFile: mocks.readFile,
    rename: mocks.rename,
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
  rendererDefault: 'libghostty-vt',
  rendererVisualDefault: 'ghostty-web',
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
    mocks.rename.mockResolvedValue(undefined);
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
    // Runs the hook with a temp path, as the real write does before its
    // rename.
    mocks.writeTextFileAtomic.mockImplementation(
      async (options: {
        path: string;
        beforeRename?: (temporaryPath: string) => Promise<void>;
      }) => {
        await options.beforeRename?.(`${options.path}.tmp-test`);
      },
    );
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
    mocks.fileIdentity.mockImplementation((path: string) =>
      Promise.resolve(`identity of ${path}`),
    );
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
      createParentFolders: false,
      beforeRename: expect.any(Function) as unknown,
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
      // The temp file's identity, which the rename keeps.
      outputFileIdentity:
        'identity of /tmp/agent-tty/sessions/session-01/artifacts/recording-2-asciicast.cast.tmp-test',
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
    expect(generateWebmExportArgs.outputPath).toMatch(
      /^\/tmp\/agent-tty\/sessions\/session-01\/artifacts\/recording-1-webm\.webm\.tmp-[^/]+\.webm$/u,
    );
    expect(mocks.rename).toHaveBeenCalledWith(
      generateWebmExportArgs.outputPath,
      '/tmp/agent-tty/sessions/session-01/artifacts/recording-1-webm.webm',
    );
    // The temp file's identity, which the rename keeps.
    expect(mocks.appendArtifactWithRollback).toHaveBeenCalledWith(
      expect.objectContaining({
        outputFileIdentity: `identity of ${generateWebmExportArgs.outputPath}`,
      }),
    );
    expect(generateWebmExportArgs.rendererName).toBe('ghostty-web');
    expect(mocks.writeTextFileAtomic).not.toHaveBeenCalled();
    // The bytes and the hash come from the temp file, before the rename.
    expect(mocks.stat).toHaveBeenCalledWith(generateWebmExportArgs.outputPath);
    expect(mocks.readFile).toHaveBeenCalledWith(
      generateWebmExportArgs.outputPath,
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

  it('exports still svg artifacts via captureGridFrames', async () => {
    mocks.recordingFilename.mockReturnValue('recording-1-svg.svg');

    const svgContents = '<svg>still</svg>\n';
    const svgSha256 = createHash('sha256')
      .update(Buffer.from(svgContents, 'utf8'))
      .digest('hex');
    const expectedRenderProfileHash = hashProfile(
      resolveProfile('reference-dark'),
    );
    const gridFrame = {
      capturedAtSeq: 1,
      cols: 80,
      rows: 24,
      cursorRow: 0,
      cursorCol: 0,
      lines: [[{ char: 'h' }]],
      holdMs: 1_000,
    };

    mocks.captureGridFrames.mockResolvedValue({
      frames: [gridFrame],
      capturedAtSeq: 1,
      cols: 80,
      rows: 24,
      rendererBackend: 'libghostty-vt',
      outputEventCount: 1,
      resizeEventCount: 1,
      timelineDurationMs: 2_500,
    });
    mocks.renderGridFramesToSvg.mockReturnValue(svgContents);

    await runRecordExportCommand({
      context: TEST_CONTEXT,
      json: true,
      sessionId: 'session-01',
      format: 'svg',
    });

    expect(mocks.captureGridFrames).toHaveBeenCalledTimes(1);
    const captureCall = mocks.captureGridFrames.mock.calls[0] as [
      {
        sessionId: string;
        manifest: ReturnType<typeof createSessionRecord>;
        events: unknown[];
        profile: { name: string };
        mode: string;
      },
    ];
    const [captureArgs] = captureCall;

    expect(captureArgs.sessionId).toBe('session-01');
    expect(captureArgs.manifest).toEqual(createSessionRecord());
    expect(captureArgs.events).toHaveLength(2);
    expect(captureArgs.profile.name).toBe('reference-dark');
    expect(captureArgs.mode).toBe('final');
    // Still svg carries the resolved profile in its default filename.
    expect(mocks.recordingFilename).toHaveBeenCalledWith(
      1,
      'svg',
      'reference-dark',
    );

    expect(mocks.renderGridFramesToSvg).toHaveBeenCalledWith({
      profile: expect.objectContaining({ name: 'reference-dark' }) as unknown,
      frames: [gridFrame],
      animate: false,
    });
    expect(mocks.writeTextFileAtomic).toHaveBeenCalledWith({
      path: '/tmp/agent-tty/sessions/session-01/artifacts/recording-1-svg.svg',
      pathLabel: 'record export path',
      contents: svgContents,
      writeErrorMessage:
        'Failed to write record export artifact at /tmp/agent-tty/sessions/session-01/artifacts/recording-1-svg.svg.',
      createParentFolders: false,
      beforeRename: expect.any(Function) as unknown,
    });

    expect(mocks.createArtifactEntry).toHaveBeenCalledWith({
      kind: 'recording',
      filename: 'recording-1-svg.svg',
      sessionId: 'session-01',
      capturedAtSeq: 1,
      sha256: svgSha256,
      bytes: Buffer.byteLength(svgContents, 'utf8'),
      metadata: {
        format: 'svg',
        outputPath:
          '/tmp/agent-tty/sessions/session-01/artifacts/recording-1-svg.svg',
        width: 80,
        height: 24,
        profileName: 'reference-dark',
        renderProfileHash: expectedRenderProfileHash,
        rendererBackend: 'libghostty-vt',
        animated: false,
        frameCount: 1,
        outputEventCount: 1,
        resizeEventCount: 1,
      },
    });

    expect(mocks.emitSuccess).toHaveBeenCalledTimes(1);
    const emitSuccessCall = mocks.emitSuccess.mock.calls[0] as [
      {
        result: {
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

    expect(emitSuccessArgs.result.format).toBe('svg');
    expect(emitSuccessArgs.result.bytes).toBe(
      Buffer.byteLength(svgContents, 'utf8'),
    );
    expect(emitSuccessArgs.result.sha256).toBe(svgSha256);
    expect(emitSuccessArgs.result.capturedAtSeq).toBe(1);
    // Still exports represent an instant, not a playback timeline.
    expect(emitSuccessArgs.result.durationMs).toBe(0);
    expect(emitSuccessArgs.result.metadata.animated).toBe(false);
    expect(mocks.generateWebmExport).not.toHaveBeenCalled();
  });

  it('exports animated svg with the recorded timeline duration', async () => {
    mocks.recordingFilename.mockReturnValue('recording-1-svg.svg');
    mocks.captureGridFrames.mockResolvedValue({
      frames: [
        {
          capturedAtSeq: 0,
          cols: 80,
          rows: 24,
          cursorRow: 0,
          cursorCol: 0,
          lines: [],
          holdMs: 1_500,
        },
        {
          capturedAtSeq: 1,
          cols: 80,
          rows: 24,
          cursorRow: 0,
          cursorCol: 0,
          lines: [],
          holdMs: 1_000,
        },
      ],
      capturedAtSeq: 1,
      cols: 80,
      rows: 24,
      rendererBackend: 'libghostty-vt',
      outputEventCount: 1,
      resizeEventCount: 1,
      timelineDurationMs: 2_500,
    });
    mocks.renderGridFramesToSvg.mockReturnValue('<svg>animated</svg>\n');

    await runRecordExportCommand({
      context: TEST_CONTEXT,
      json: true,
      sessionId: 'session-01',
      format: 'svg',
      animate: true,
    });

    const captureCall = mocks.captureGridFrames.mock.calls[0] as [
      { mode: string },
    ];
    expect(captureCall[0].mode).toBe('timeline');
    expect(mocks.renderGridFramesToSvg).toHaveBeenCalledWith(
      expect.objectContaining({ animate: true }),
    );
    // Animated svg gets a distinct profile-bearing default filename so it
    // cannot overwrite the still export at the same seq.
    expect(mocks.recordingFilename).toHaveBeenCalledWith(
      1,
      'svg',
      'reference-dark-animated',
    );

    const emitSuccessCall = mocks.emitSuccess.mock.calls[0] as [
      {
        result: {
          durationMs?: number;
          metadata: Record<string, unknown>;
        };
      },
    ];
    const [emitSuccessArgs] = emitSuccessCall;
    expect(emitSuccessArgs.result.durationMs).toBe(2_500);
    expect(emitSuccessArgs.result.metadata.animated).toBe(true);
    expect(emitSuccessArgs.result.metadata.frameCount).toBe(2);
  });

  it('exports blank svg artifacts for silent sessions with empty event logs', async () => {
    mocks.recordingFilename.mockReturnValue('recording--1-svg.svg');
    mocks.readEventLogRecords.mockResolvedValue([]);

    const blankFrame = {
      capturedAtSeq: -1,
      cols: 80,
      rows: 24,
      cursorRow: 0,
      cursorCol: 0,
      lines: [],
      holdMs: 1_000,
    };
    mocks.captureGridFrames.mockResolvedValue({
      frames: [blankFrame],
      capturedAtSeq: -1,
      cols: 80,
      rows: 24,
      rendererBackend: 'none',
      outputEventCount: 0,
      resizeEventCount: 0,
      timelineDurationMs: 1_000,
    });
    mocks.renderGridFramesToSvg.mockReturnValue('<svg>blank</svg>\n');

    await runRecordExportCommand({
      context: TEST_CONTEXT,
      json: true,
      sessionId: 'session-01',
      format: 'svg',
    });

    const captureCall = mocks.captureGridFrames.mock.calls[0] as [
      { events: unknown[]; mode: string },
    ];
    expect(captureCall[0].events).toEqual([]);
    expect(captureCall[0].mode).toBe('final');
    expect(mocks.recordingFilename).toHaveBeenCalledWith(
      -1,
      'svg',
      'reference-dark',
    );

    const emitSuccessCall = mocks.emitSuccess.mock.calls[0] as [
      {
        result: {
          format: string;
          capturedAtSeq: number;
          metadata: Record<string, unknown>;
        };
      },
    ];
    const [emitSuccessArgs] = emitSuccessCall;
    expect(emitSuccessArgs.result.format).toBe('svg');
    expect(emitSuccessArgs.result.capturedAtSeq).toBe(-1);
    expect(emitSuccessArgs.result.metadata).toMatchObject({
      frameCount: 1,
      animated: false,
      outputEventCount: 0,
      resizeEventCount: 0,
    });
  });

  it('rejects --animate for non-svg formats', async () => {
    await expect(
      runRecordExportCommand({
        context: TEST_CONTEXT,
        json: true,
        sessionId: 'session-01',
        format: 'asciicast',
        animate: true,
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT,
      message: '--animate is only supported with --format svg.',
    });
    expect(mocks.captureGridFrames).not.toHaveBeenCalled();
    expect(mocks.emitSuccess).not.toHaveBeenCalled();
  });

  it('rejects --timing for svg exports', async () => {
    await expect(
      runRecordExportCommand({
        context: TEST_CONTEXT,
        json: true,
        sessionId: 'session-01',
        format: 'svg',
        timing: 'recorded',
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT,
      message:
        '--timing is not supported with --format svg; animated SVG always uses recorded timing.',
    });
    expect(mocks.captureGridFrames).not.toHaveBeenCalled();
    expect(mocks.emitSuccess).not.toHaveBeenCalled();
  });

  it.each(['svg', 'webm'])(
    'rejects an unknown render profile for %s before it renders',
    async (format) => {
      await expect(
        runRecordExportCommand({
          context: TEST_CONTEXT,
          json: true,
          sessionId: 'session-01',
          format,
          profile: 'bogus',
        }),
      ).rejects.toMatchObject({
        code: ERROR_CODES.INVALID_INPUT,
        message: 'unknown render profile: bogus',
      });
      expect(mocks.ensureArtifactsDir).not.toHaveBeenCalled();
      expect(mocks.captureGridFrames).not.toHaveBeenCalled();
      expect(mocks.generateWebmExport).not.toHaveBeenCalled();
      expect(mocks.emitSuccess).not.toHaveBeenCalled();
    },
  );

  it.each(['svg', 'webm'])(
    'creates no --out folder for an unknown render profile for %s',
    async (format) => {
      const workspaceDirectory = await createTemporaryDirectory(
        'agent-tty-record-export-bad-profile-',
      );
      const outFolder = join(workspaceDirectory, 'new');

      await expect(
        runRecordExportCommand({
          context: TEST_CONTEXT,
          json: true,
          sessionId: 'session-01',
          format,
          profile: 'bogus',
          out: join(outFolder, 'sub', `x.${format}`),
        }),
      ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_INPUT });
      await expect(access(outFolder)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it('reports the glyphs that the video drew as boxes, in the result and the human output', async () => {
    mocks.recordingFilename.mockReturnValue('recording-1-webm.webm');
    const webmContent = Buffer.alloc(64, 0x42);
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
      missingGlyphs: [{ codePoint: 'U+0378' }],
      missingGlyphsTruncated: true,
    });
    mocks.stat.mockResolvedValue({ size: webmContent.byteLength });
    mocks.readFile.mockResolvedValue(webmContent);

    await runRecordExportCommand({
      context: TEST_CONTEXT,
      json: false,
      sessionId: 'session-01',
      format: 'webm',
    });

    const [output] = mocks.emitSuccess.mock.calls[0] as [
      { result: Record<string, unknown>; lines: string[] },
    ];
    expect(output.result).toMatchObject({
      missingGlyphs: [{ codePoint: 'U+0378' }],
      missingGlyphsTruncated: true,
    });
    expect(output.lines.slice(-2)).toEqual([
      'Missing glyphs (drawn as boxes): U+0378',
      'Glyph check incomplete',
    ]);
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
      async (options: {
        path: string;
        contents: string;
        beforeRename?: (temporaryPath: string) => Promise<void>;
      }) => {
        await mkdir(dirname(options.path), { recursive: true });
        await options.beforeRename?.(`${options.path}.tmp-test`);
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

  it('describes the WebM it wrote even when another write replaces the file after the rename', async () => {
    mocks.recordingFilename.mockReturnValue('recording-1-webm.webm');
    const finalPath =
      '/tmp/agent-tty/sessions/session-01/artifacts/recording-1-webm.webm';
    const written = Buffer.alloc(100, 0x41);
    const replaced = Buffer.alloc(200, 0x42);
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
    // After the rename, the path holds another export's bytes.
    mocks.stat.mockImplementation((path: string) =>
      Promise.resolve({
        size: path === finalPath ? replaced.length : written.length,
      }),
    );
    mocks.readFile.mockImplementation((path: string) =>
      Promise.resolve(path === finalPath ? replaced : written),
    );

    await runRecordExportCommand({
      context: TEST_CONTEXT,
      json: true,
      sessionId: 'session-01',
      format: 'webm',
    });

    expect(mocks.emitSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          bytes: written.length,
          sha256: createHash('sha256').update(written).digest('hex'),
        }) as unknown,
      }),
    );
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

  it('replaces an --out symlink with the WebM instead of writing through it', async () => {
    const workspaceDirectory = await createTemporaryDirectory(
      'agent-tty-record-export-webm-link-',
    );
    const linkTarget = join(workspaceDirectory, 'session.json');
    const out = join(workspaceDirectory, 'proof.webm');
    await writeFile(linkTarget, 'session record');
    await symlink(linkTarget, out);
    const webmContent = Buffer.from('webm bytes');
    const fs = await vi.importActual<typeof FsPromises>('node:fs/promises');
    mocks.rename.mockImplementation(fs.rename);
    mocks.generateWebmExport.mockImplementation(
      async (options: { outputPath: string }) => {
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
    mocks.stat.mockResolvedValue({ size: webmContent.byteLength });
    mocks.readFile.mockResolvedValue(webmContent);

    await runRecordExportCommand({
      context: TEST_CONTEXT,
      json: true,
      sessionId: 'session-01',
      format: 'webm',
      out,
    });

    expect(await fs.readFile(linkTarget, 'utf8')).toBe('session record');
    expect((await fs.lstat(out)).isSymbolicLink()).toBe(false);
    expect((await fs.readFile(out)).equals(webmContent)).toBe(true);
    expect((await fs.readdir(workspaceDirectory)).sort()).toEqual([
      'proof.webm',
      'session.json',
    ]);
  });

  it('rejects a WebM --out path that does not end in .webm before rendering', async () => {
    const workspaceDirectory = await createTemporaryDirectory(
      'agent-tty-record-export-webm-suffix-',
    );

    await expect(
      runRecordExportCommand({
        context: TEST_CONTEXT,
        json: true,
        sessionId: 'session-01',
        format: 'webm',
        out: join(workspaceDirectory, 'proof.mp4'),
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.EXPORT_ERROR });
    expect(mocks.generateWebmExport).not.toHaveBeenCalled();
  });

  it.each(['render', 'rename'] as const)(
    'removes the WebM temp file when the %s step fails',
    async (failingStep) => {
      const workspaceDirectory = await createTemporaryDirectory(
        'agent-tty-record-export-webm-temp-',
      );
      const stepError = new Error(`${failingStep} failed`);
      mocks.generateWebmExport.mockImplementation(
        async (options: { outputPath: string }) => {
          await writeFile(options.outputPath, 'partial webm');
          if (failingStep === 'render') {
            throw stepError;
          }
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
      if (failingStep === 'rename') {
        mocks.rename.mockRejectedValue(stepError);
      }

      await expect(
        runRecordExportCommand({
          context: TEST_CONTEXT,
          json: true,
          sessionId: 'session-01',
          format: 'webm',
          out: join(workspaceDirectory, 'proof.webm'),
        }),
      ).rejects.toMatchObject({ code: ERROR_CODES.EXPORT_ERROR });
      expect(mocks.generateWebmExport).toHaveBeenCalledTimes(1);
      const fs = await vi.importActual<typeof FsPromises>('node:fs/promises');
      expect(await fs.readdir(workspaceDirectory)).toEqual([]);
    },
  );

  it('refuses the WebM when the --out folder is swapped for a link during the render', async () => {
    const workspaceDirectory = await createTemporaryDirectory(
      'agent-tty-record-export-webm-swap-',
    );
    const exportsDirectory = join(workspaceDirectory, 'exports');
    const elsewhereDirectory = join(workspaceDirectory, 'elsewhere');
    await mkdir(exportsDirectory);
    await mkdir(elsewhereDirectory);
    mocks.generateWebmExport.mockImplementation(
      async (options: { outputPath: string }) => {
        const fs = await vi.importActual<typeof FsPromises>('node:fs/promises');
        await fs.rename(exportsDirectory, join(workspaceDirectory, 'moved'));
        await symlink(elsewhereDirectory, exportsDirectory);
        await writeFile(options.outputPath, 'webm bytes');
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

    await expect(
      runRecordExportCommand({
        context: TEST_CONTEXT,
        json: true,
        sessionId: 'session-01',
        format: 'webm',
        out: join(exportsDirectory, 'proof.webm'),
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.EXPORT_ERROR,
      message: expect.stringContaining(
        'was replaced while the command ran',
      ) as unknown,
    });
    expect(mocks.rename).not.toHaveBeenCalled();
    const fs = await vi.importActual<typeof FsPromises>('node:fs/promises');
    expect(await fs.readdir(elsewhereDirectory)).toEqual([]);
    expect(mocks.appendArtifactWithRollback).not.toHaveBeenCalled();
  });

  // Hashing a large WebM takes time. The folder check runs after it, so a
  // swap during the hash cannot slip in before the rename.
  it('refuses the WebM when the --out folder is swapped for a link while it hashes the file', async () => {
    const workspaceDirectory = await createTemporaryDirectory(
      'agent-tty-record-export-webm-hash-swap-',
    );
    const exportsDirectory = join(workspaceDirectory, 'exports');
    const elsewhereDirectory = join(workspaceDirectory, 'elsewhere');
    await mkdir(exportsDirectory);
    await mkdir(elsewhereDirectory);
    const written = Buffer.from('webm bytes');
    mocks.generateWebmExport.mockImplementation(
      async (options: { outputPath: string }) => {
        await writeFile(options.outputPath, written);
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
    mocks.stat.mockResolvedValue({ size: written.length });
    mocks.readFile.mockImplementation(async () => {
      const fs = await vi.importActual<typeof FsPromises>('node:fs/promises');
      await fs.rename(exportsDirectory, join(workspaceDirectory, 'moved'));
      await symlink(elsewhereDirectory, exportsDirectory);
      return written;
    });

    await expect(
      runRecordExportCommand({
        context: TEST_CONTEXT,
        json: true,
        sessionId: 'session-01',
        format: 'webm',
        out: join(exportsDirectory, 'proof.webm'),
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.EXPORT_ERROR,
      message: expect.stringContaining(
        'was replaced while the command ran',
      ) as unknown,
    });
    expect(mocks.readFile).toHaveBeenCalledTimes(1);
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(mocks.appendArtifactWithRollback).not.toHaveBeenCalled();
  });

  it('refuses the asciicast when the --out folder is replaced before the rename', async () => {
    const workspaceDirectory = await createTemporaryDirectory(
      'agent-tty-record-export-cast-swap-',
    );
    const exportsDirectory = join(workspaceDirectory, 'exports');
    await mkdir(exportsDirectory);
    mocks.writeTextFileAtomic.mockImplementation(
      async (options: {
        path: string;
        beforeRename?: (temporaryPath: string) => Promise<void>;
      }) => {
        const fs = await vi.importActual<typeof FsPromises>('node:fs/promises');
        await fs.rename(exportsDirectory, join(workspaceDirectory, 'moved'));
        await mkdir(exportsDirectory);
        await options.beforeRename?.(`${options.path}.tmp-test`);
      },
    );

    await expect(
      runRecordExportCommand({
        context: TEST_CONTEXT,
        json: true,
        sessionId: 'session-01',
        format: 'asciicast',
        out: join(exportsDirectory, 'session.cast'),
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.EXPORT_ERROR,
      message: expect.stringContaining(
        'was replaced while the command ran',
      ) as unknown,
    });
    expect(mocks.appendArtifactWithRollback).not.toHaveBeenCalled();
  });

  it('refuses the svg when the --out folder is replaced before the rename', async () => {
    const workspaceDirectory = await createTemporaryDirectory(
      'agent-tty-record-export-svg-swap-',
    );
    const exportsDirectory = join(workspaceDirectory, 'exports');
    await mkdir(exportsDirectory);
    mocks.captureGridFrames.mockResolvedValue({
      frames: [
        {
          capturedAtSeq: 1,
          cols: 80,
          rows: 24,
          cursorRow: 0,
          cursorCol: 0,
          lines: [],
          holdMs: 1_000,
        },
      ],
      capturedAtSeq: 1,
      cols: 80,
      rows: 24,
      rendererBackend: 'libghostty-vt',
      outputEventCount: 1,
      resizeEventCount: 0,
      timelineDurationMs: 1_000,
    });
    mocks.renderGridFramesToSvg.mockReturnValue('<svg>swap</svg>\n');
    mocks.writeTextFileAtomic.mockImplementation(
      async (options: {
        path: string;
        beforeRename?: (temporaryPath: string) => Promise<void>;
      }) => {
        const fs = await vi.importActual<typeof FsPromises>('node:fs/promises');
        await fs.rename(exportsDirectory, join(workspaceDirectory, 'moved'));
        await mkdir(exportsDirectory);
        await options.beforeRename?.(`${options.path}.tmp-test`);
      },
    );

    await expect(
      runRecordExportCommand({
        context: TEST_CONTEXT,
        json: true,
        sessionId: 'session-01',
        format: 'svg',
        out: join(exportsDirectory, 'session.svg'),
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.EXPORT_ERROR,
      message: expect.stringContaining(
        'was replaced while the command ran',
      ) as unknown,
    });
    expect(mocks.appendArtifactWithRollback).not.toHaveBeenCalled();
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
      async (options: {
        path: string;
        contents: string;
        beforeRename?: (temporaryPath: string) => Promise<void>;
      }) => {
        await mkdir(dirname(options.path), { recursive: true });
        await options.beforeRename?.(`${options.path}.tmp-test`);
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

  it.each(['asciicast', 'webm', 'svg'] as const)(
    'names the size limit when the event log is too large to export as %s',
    async (format) => {
      mocks.readEventLogRecords.mockRejectedValue(
        new EventLogTooLargeError(78_623_361, 52_428_800),
      );

      await expect(
        runRecordExportCommand({
          context: TEST_CONTEXT,
          json: true,
          sessionId: 'session-01',
          format,
        }),
      ).rejects.toMatchObject({
        code: ERROR_CODES.EXPORT_ERROR,
        message: `Failed to export session "session-01" as ${format}: its event log is 78623361 bytes, over the 52428800-byte limit that commands can read.`,
        details: {
          sessionId: 'session-01',
          format,
          eventLogBytes: 78_623_361,
          maxEventLogBytes: 52_428_800,
        },
      });
      expect(mocks.emitSuccess).not.toHaveBeenCalled();
    },
  );

  it('keeps the generic message for other event log read failures', async () => {
    mocks.readEventLogRecords.mockRejectedValue(new Error('EIO'));

    await expect(
      runRecordExportCommand({
        context: TEST_CONTEXT,
        json: true,
        sessionId: 'session-01',
        format: 'asciicast',
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.EXPORT_ERROR,
      message: 'Failed to export session "session-01" as asciicast.',
    });
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

  it('rejects output paths inside session storage', async () => {
    const home = await createTemporaryDirectory(
      'agent-tty-record-export-home-',
    );
    const sessionDirectory = join(home, 'sessions', 'session-01');
    await mkdir(join(sessionDirectory, 'artifacts'), { recursive: true });
    mocks.sessionDir.mockReturnValue(sessionDirectory);

    await expect(
      runRecordExportCommand({
        context: TEST_CONTEXT,
        json: false,
        sessionId: 'session-01',
        format: 'asciicast',
        out: join(sessionDirectory, 'artifacts', 'manifest.json'),
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.EXPORT_ERROR,
    });
    expect(mocks.writeTextFileAtomic).not.toHaveBeenCalled();
  });

  it('creates missing parent folders of --out', async () => {
    const workspaceDirectory = await createTemporaryDirectory(
      'agent-tty-record-export-missing-parent-',
    );
    const out = join(workspaceDirectory, 'missing', 'custom.cast');

    await runRecordExportCommand({
      context: TEST_CONTEXT,
      json: false,
      sessionId: 'session-01',
      format: 'asciicast',
      out,
    });

    expect(mocks.writeTextFileAtomic).toHaveBeenCalledWith(
      expect.objectContaining({ path: out }),
    );
    await expect(access(join(workspaceDirectory, 'missing'))).resolves.toBe(
      undefined,
    );
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
