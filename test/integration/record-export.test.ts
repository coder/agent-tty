import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readArtifactManifest } from '../../src/storage/artifactManifest.js';
import { writeManifest } from '../../src/storage/manifests.js';
import {
  eventLogPath,
  manifestPath,
  sessionDir,
} from '../../src/storage/sessionPaths.js';
import {
  cleanupHome,
  createSession,
  createTestSessionRecord,
  destroySession,
  runCli,
  type SuccessEnvelope,
  type WaitResult,
} from '../helpers.js';

interface ErrorEnvelope {
  ok: false;
  command: string;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

interface RecordExportResult {
  sessionId: string;
  format: 'asciicast' | 'webm';
  artifactPath: string;
  bytes: number;
  sha256: string;
  capturedAtSeq: number;
  durationMs?: number;
  metadata: Record<string, unknown>;
  missingGlyphs?: { codePoint: string }[];
  missingGlyphsTruncated?: true;
}

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

function normalizeOutput(output: string): string {
  return output.replaceAll('\r\n', '\n');
}

function waitForIdle(testHome: string, sessionId: string): void {
  const result = runCli(
    ['wait', sessionId, '--idle-ms', '300', '--timeout', '10000', '--json'],
    { AGENT_TTY_HOME: testHome },
    15_000,
  );

  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  const envelope = JSON.parse(result.stdout) as SuccessEnvelope<WaitResult>;
  expect(envelope.ok).toBe(true);
  expect(envelope.result.timedOut).toBe(false);
}

function waitForExit(testHome: string, sessionId: string): void {
  const result = runCli(
    ['wait', sessionId, '--exit', '--timeout', '10000', '--json'],
    { AGENT_TTY_HOME: testHome },
    15_000,
  );

  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  const envelope = JSON.parse(result.stdout) as SuccessEnvelope<WaitResult>;
  expect(envelope.ok).toBe(true);
  expect(envelope.result.timedOut).toBe(false);
}

function parseAsciicast(contents: string): unknown[] {
  return contents
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);
}

// An exited session whose program printed nothing: its event log is empty.
// Both PIDs are null, so cleanup signals no process.
async function createEmptySession(testHome: string): Promise<string> {
  const sessionId = 'session-empty';
  const sessionDirectory = sessionDir(testHome, sessionId);
  await mkdir(sessionDirectory, { recursive: true });
  await writeManifest(
    manifestPath(sessionDirectory),
    createTestSessionRecord({
      sessionId,
      status: 'exited',
      hostPid: null,
      childPid: null,
      exitCode: 0,
    }),
  );
  await writeFile(eventLogPath(sessionDirectory), '', 'utf8');
  return sessionId;
}

describe('record export integration', { timeout: 120_000 }, () => {
  let testHome = '';

  beforeEach(async () => {
    // oxfmt-ignore
    testHome = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-record-export-')));
  });

  afterEach(async () => {
    await cleanupHome(testHome);
  });

  it('exports deterministic asciicast artifacts for running sessions', async () => {
    const sessionId = createSession(testHome, [
      '/bin/sh',
      '-c',
      "printf 'ready\\n'; exec cat",
    ]);

    waitForIdle(testHome, sessionId);

    const typeResult = runCli(['type', sessionId, 'hello export', '--json'], {
      AGENT_TTY_HOME: testHome,
    });
    expect(typeResult.status).toBe(0);
    expect(typeResult.stderr).toBe('');

    const enterResult = runCli(['send-keys', sessionId, 'Enter', '--json'], {
      AGENT_TTY_HOME: testHome,
    });
    expect(enterResult.status).toBe(0);
    expect(enterResult.stderr).toBe('');

    waitForIdle(testHome, sessionId);

    const exportResult = runCli(
      ['record', 'export', sessionId, '--format', 'asciicast', '--json'],
      { AGENT_TTY_HOME: testHome },
      15_000,
    );
    expect(exportResult.status).toBe(0);
    expect(exportResult.stderr).toBe('');

    const firstEnvelope = JSON.parse(
      exportResult.stdout,
    ) as SuccessEnvelope<RecordExportResult>;
    expect(firstEnvelope.ok).toBe(true);
    expect(firstEnvelope.command).toBe('record export');
    expect(firstEnvelope.result.sessionId).toBe(sessionId);
    expect(firstEnvelope.result.format).toBe('asciicast');
    expect(firstEnvelope.result.artifactPath.endsWith('.cast')).toBe(true);
    expect(firstEnvelope.result.capturedAtSeq).toBeGreaterThanOrEqual(0);

    const firstContents = await readFile(
      firstEnvelope.result.artifactPath,
      'utf8',
    );
    const firstSha256 = createHash('sha256')
      .update(Buffer.from(firstContents, 'utf8'))
      .digest('hex');
    const firstLines = parseAsciicast(firstContents);
    const outputText = normalizeOutput(
      firstLines
        .slice(1)
        .filter(
          (line): line is [number, string, string] =>
            Array.isArray(line) &&
            line.length === 3 &&
            line[1] === 'o' &&
            typeof line[2] === 'string',
        )
        .map((line) => line[2])
        .join(''),
    );

    expect(firstEnvelope.result.bytes).toBe(
      Buffer.byteLength(firstContents, 'utf8'),
    );
    expect(firstEnvelope.result.sha256).toBe(firstSha256);
    expect(firstLines[0]).toEqual(
      expect.objectContaining({
        version: 2,
        title: sessionId,
        width: 80,
        height: 24,
      }),
    );
    expect(outputText).toContain('ready\n');
    expect(outputText).toContain('hello export');

    const secondExportResult = runCli(
      ['record', 'export', sessionId, '--format', 'asciicast', '--json'],
      { AGENT_TTY_HOME: testHome },
      15_000,
    );
    expect(secondExportResult.status).toBe(0);
    const secondEnvelope = JSON.parse(
      secondExportResult.stdout,
    ) as SuccessEnvelope<RecordExportResult>;
    const secondContents = await readFile(
      secondEnvelope.result.artifactPath,
      'utf8',
    );

    expect(secondContents).toBe(firstContents);
    expect(secondEnvelope.result.sha256).toBe(firstEnvelope.result.sha256);
    expect(secondEnvelope.result.bytes).toBe(firstEnvelope.result.bytes);

    const artifactManifest = await readJsonFile<{
      artifacts: Array<{
        kind: string;
        filename: string;
        sha256?: string;
        bytes?: number;
        capturedAtSeq: number;
      }>;
    }>(join(testHome, 'sessions', sessionId, 'artifacts', 'manifest.json'));
    const recordingEntries = artifactManifest.artifacts.filter(
      (entry) => entry.kind === 'recording',
    );

    expect(recordingEntries.length).toBeGreaterThanOrEqual(1);
    expect(recordingEntries.at(-1)).toEqual(
      expect.objectContaining({
        kind: 'recording',
        filename: basename(firstEnvelope.result.artifactPath),
        sha256: firstEnvelope.result.sha256,
        bytes: firstEnvelope.result.bytes,
        capturedAtSeq: firstEnvelope.result.capturedAtSeq,
      }),
    );

    destroySession(testHome, sessionId);
  });

  it('exports asciicast artifacts for exited sessions', async () => {
    const sessionId = createSession(testHome, [
      '/bin/sh',
      '-c',
      "printf 'done\\n'; exit 0",
    ]);

    waitForExit(testHome, sessionId);

    const exportResult = runCli(
      ['record', 'export', sessionId, '--format', 'asciicast', '--json'],
      { AGENT_TTY_HOME: testHome },
      15_000,
    );
    expect(exportResult.status).toBe(0);
    expect(exportResult.stderr).toBe('');

    const envelope = JSON.parse(
      exportResult.stdout,
    ) as SuccessEnvelope<RecordExportResult>;
    const contents = await readFile(envelope.result.artifactPath, 'utf8');
    const lines = parseAsciicast(contents);

    expect(envelope.result.format).toBe('asciicast');
    expect(lines[0]).toEqual(
      expect.objectContaining({
        version: 2,
        title: sessionId,
      }),
    );
    expect(contents).toContain('done');
  });

  it('exports an empty event log as a header-only asciicast at seq -1', async () => {
    const sessionId = await createEmptySession(testHome);

    const exportResult = runCli(
      ['record', 'export', sessionId, '--format', 'asciicast', '--json'],
      { AGENT_TTY_HOME: testHome },
      15_000,
    );
    expect(exportResult.status).toBe(0);
    expect(exportResult.stderr).toBe('');

    const envelope = JSON.parse(
      exportResult.stdout,
    ) as SuccessEnvelope<RecordExportResult>;
    expect(envelope.ok).toBe(true);
    expect(envelope.result.capturedAtSeq).toBe(-1);
    expect(basename(envelope.result.artifactPath)).toBe(
      'recording--1-asciicast.cast',
    );
    const lines = parseAsciicast(
      await readFile(envelope.result.artifactPath, 'utf8'),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual(
      expect.objectContaining({ version: 2, width: 80, height: 24 }),
    );

    const artifactManifest = await readJsonFile<{
      artifacts: Array<{ filename: string; capturedAtSeq: number }>;
    }>(join(testHome, 'sessions', sessionId, 'artifacts', 'manifest.json'));
    expect(artifactManifest.artifacts.at(-1)).toEqual(
      expect.objectContaining({
        filename: 'recording--1-asciicast.cast',
        capturedAtSeq: -1,
      }),
    );
  });

  // Like snapshot and screenshot of a session that printed nothing (#235),
  // WebM export succeeds: a blank video of the session's size at seq -1.
  it('exports an empty event log as a blank webm video at seq -1', async () => {
    const sessionId = await createEmptySession(testHome);

    const exportResult = runCli(
      ['record', 'export', sessionId, '--format', 'webm', '--json'],
      { AGENT_TTY_HOME: testHome },
      120_000,
    );
    expect(exportResult.status).toBe(0);
    expect(exportResult.stderr).toBe('');

    const envelope = JSON.parse(
      exportResult.stdout,
    ) as SuccessEnvelope<RecordExportResult>;
    expect(envelope.ok).toBe(true);
    expect(envelope.result.format).toBe('webm');
    expect(envelope.result.capturedAtSeq).toBe(-1);
    expect(envelope.result.durationMs).toBe(0);
    expect(basename(envelope.result.artifactPath)).toBe(
      'recording--1-webm.webm',
    );
    expect(envelope.result.bytes).toBeGreaterThan(0);
    const contents = await readFile(envelope.result.artifactPath);
    expect(contents.byteLength).toBe(envelope.result.bytes);
    expect(createHash('sha256').update(contents).digest('hex')).toBe(
      envelope.result.sha256,
    );

    const artifactManifest = await readJsonFile<{
      artifacts: Array<{
        kind: string;
        filename: string;
        capturedAtSeq: number;
      }>;
    }>(join(testHome, 'sessions', sessionId, 'artifacts', 'manifest.json'));
    expect(artifactManifest.artifacts.at(-1)).toEqual(
      expect.objectContaining({
        kind: 'video',
        filename: 'recording--1-webm.webm',
        capturedAtSeq: -1,
      }),
    );
  });

  it('exports webm video for running sessions', async () => {
    const sessionId = createSession(testHome, [
      '/bin/sh',
      '-c',
      "printf 'ready webm\\n'; exec cat",
    ]);

    waitForIdle(testHome, sessionId);

    const exportResult = runCli(
      ['record', 'export', sessionId, '--format', 'webm', '--json'],
      { AGENT_TTY_HOME: testHome },
      120_000,
    );
    expect(exportResult.status).toBe(0);
    expect(exportResult.stderr).toBe('');

    const envelope = JSON.parse(
      exportResult.stdout,
    ) as SuccessEnvelope<RecordExportResult>;
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe('record export');
    expect(envelope.result.sessionId).toBe(sessionId);
    expect(envelope.result.format).toBe('webm');
    expect(envelope.result.artifactPath.endsWith('.webm')).toBe(true);
    expect(envelope.result.bytes).toBeGreaterThan(0);
    expect(envelope.result.capturedAtSeq).toBeGreaterThanOrEqual(0);
    expect(envelope.result.missingGlyphs).toEqual([]);

    const contents = await readFile(envelope.result.artifactPath);
    expect(contents.byteLength).toBe(envelope.result.bytes);
    const sha256 = createHash('sha256').update(contents).digest('hex');
    expect(envelope.result.sha256).toBe(sha256);

    const artifactManifest = await readJsonFile<{
      artifacts: Array<{
        kind: string;
        filename: string;
        sha256?: string;
        bytes?: number;
        capturedAtSeq: number;
      }>;
    }>(join(testHome, 'sessions', sessionId, 'artifacts', 'manifest.json'));
    const videoEntries = artifactManifest.artifacts.filter(
      (entry) => entry.kind === 'video',
    );
    expect(videoEntries.length).toBeGreaterThanOrEqual(1);
    expect(videoEntries.at(-1)).toEqual(
      expect.objectContaining({
        kind: 'video',
        filename: basename(envelope.result.artifactPath),
        sha256: envelope.result.sha256,
        bytes: envelope.result.bytes,
      }),
    );

    destroySession(testHome, sessionId);
  });

  it('exports webm video for exited sessions', async () => {
    const sessionId = createSession(testHome, [
      '/bin/sh',
      '-c',
      "printf 'hello webm\\n'; exit 0",
    ]);

    waitForExit(testHome, sessionId);

    const exportResult = runCli(
      ['record', 'export', sessionId, '--format', 'webm', '--json'],
      { AGENT_TTY_HOME: testHome },
      120_000,
    );
    expect(exportResult.status).toBe(0);
    expect(exportResult.stderr).toBe('');

    const envelope = JSON.parse(
      exportResult.stdout,
    ) as SuccessEnvelope<RecordExportResult>;
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe('record export');
    expect(envelope.result.sessionId).toBe(sessionId);
    expect(envelope.result.format).toBe('webm');
    expect(envelope.result.artifactPath.endsWith('.webm')).toBe(true);
    expect(envelope.result.bytes).toBeGreaterThan(0);
    expect(envelope.result.capturedAtSeq).toBeGreaterThanOrEqual(0);

    const contents = await readFile(envelope.result.artifactPath);
    expect(contents.byteLength).toBe(envelope.result.bytes);
    const sha256 = createHash('sha256').update(contents).digest('hex');
    expect(envelope.result.sha256).toBe(sha256);

    const artifactManifest = await readJsonFile<{
      artifacts: Array<{
        kind: string;
        filename: string;
        sha256?: string;
        bytes?: number;
        capturedAtSeq: number;
      }>;
    }>(join(testHome, 'sessions', sessionId, 'artifacts', 'manifest.json'));
    const videoEntries = artifactManifest.artifacts.filter(
      (entry) => entry.kind === 'video',
    );
    expect(videoEntries.length).toBeGreaterThanOrEqual(1);
    expect(videoEntries.at(-1)).toEqual(
      expect.objectContaining({
        kind: 'video',
        filename: basename(envelope.result.artifactPath),
        sha256: envelope.result.sha256,
        bytes: envelope.result.bytes,
      }),
    );
  });

  it('lists a glyph that a webm frame drew as a box although the last frame is clean, and asciicast lists none', () => {
    const sessionId = createSession(testHome, [
      '/bin/sh',
      '-c',
      "printf 'box \\315\\270\\n'; read line; printf '\\033[2J\\033[Hclean\\n'; exec cat",
    ]);

    waitForIdle(testHome, sessionId);
    const enterResult = runCli(['send-keys', sessionId, 'Enter', '--json'], {
      AGENT_TTY_HOME: testHome,
    });
    expect(enterResult.status).toBe(0);
    const waitResult = runCli(
      ['wait', sessionId, '--text', 'clean', '--timeout', '10000', '--json'],
      { AGENT_TTY_HOME: testHome },
      15_000,
    );
    expect(waitResult.status).toBe(0);
    waitForIdle(testHome, sessionId);

    const exportAs = (format: 'asciicast' | 'webm') => {
      const result = runCli(
        ['record', 'export', sessionId, '--format', format, '--json'],
        { AGENT_TTY_HOME: testHome },
        120_000,
      );
      expect(result.status).toBe(0);
      return (JSON.parse(result.stdout) as SuccessEnvelope<RecordExportResult>)
        .result;
    };

    expect(exportAs('webm').missingGlyphs).toEqual([{ codePoint: 'U+0378' }]);
    expect(exportAs('asciicast')).not.toHaveProperty('missingGlyphs');

    destroySession(testHome, sessionId);
  });

  it.skipIf(process.getuid?.() === 0)(
    'fails with EXPORT_ERROR when the --out parent folder cannot be searched',
    async () => {
      const sessionId = createSession(testHome, [
        '/bin/sh',
        '-c',
        "printf 'done\\n'; exit 0",
      ]);
      waitForExit(testHome, sessionId);
      const writeOnly = join(testHome, 'write-only');
      await mkdir(writeOnly, { mode: 0o200 });
      await chmod(writeOnly, 0o200);
      const out = join(writeOnly, 'session.cast');

      try {
        const result = runCli(
          [
            'record',
            'export',
            sessionId,
            '--format',
            'asciicast',
            '--out',
            out,
            '--json',
          ],
          { AGENT_TTY_HOME: testHome },
          15_000,
        );

        expect(result.status).toBe(7);
        expect(result.stderr).toBe('');
        const envelope = JSON.parse(result.stdout) as ErrorEnvelope;
        expect(envelope.error).toMatchObject({
          code: 'EXPORT_ERROR',
          details: { sessionId, out },
        });
      } finally {
        await chmod(writeOnly, 0o700);
      }
    },
  );

  it('keeps one manifest entry per file when it exports the same seq again', async () => {
    const sessionId = createSession(testHome, [
      '/bin/sh',
      '-c',
      "printf 'done\\n'; exit 0",
    ]);
    waitForExit(testHome, sessionId);
    const out = join(testHome, 'exports', 'session.cast');
    const exportCast = (extra: string[]): RecordExportResult => {
      const result = runCli(
        [
          'record',
          'export',
          sessionId,
          '--format',
          'asciicast',
          ...extra,
          '--json',
        ],
        { AGENT_TTY_HOME: testHome },
        15_000,
      );
      expect(result.status).toBe(0);
      return (JSON.parse(result.stdout) as SuccessEnvelope<RecordExportResult>)
        .result;
    };

    const first = exportCast([]);
    const second = exportCast([]);
    exportCast(['--out', out]);
    exportCast(['--out', out]);

    expect(second.artifactPath).toBe(first.artifactPath);
    const manifest = await readArtifactManifest(
      sessionDir(testHome, sessionId),
    );
    expect(
      manifest.artifacts.map((entry) => entry.metadata.outputPath),
    ).toEqual([first.artifactPath, out]);
  });

  it('creates missing parent folders of --out', async () => {
    const sessionId = createSession(testHome, [
      '/bin/sh',
      '-c',
      "printf 'done\\n'; exit 0",
    ]);
    waitForExit(testHome, sessionId);
    const out = join(testHome, 'exports', 'nested', 'session.cast');

    const result = runCli(
      [
        'record',
        'export',
        sessionId,
        '--format',
        'asciicast',
        '--out',
        out,
        '--json',
      ],
      { AGENT_TTY_HOME: testHome },
      15_000,
    );

    expect(result.status).toBe(0);
    const envelope = JSON.parse(
      result.stdout,
    ) as SuccessEnvelope<RecordExportResult>;
    expect(envelope.result.artifactPath).toBe(out);
    expect(await readFile(out, 'utf8')).toContain('done');
  });

  it('rejects invalid export formats', () => {
    const result = runCli(
      ['record', 'export', 'session-01', '--format', 'bogus', '--json'],
      { AGENT_TTY_HOME: testHome },
      15_000,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(result.stdout) as ErrorEnvelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.command).toBe('record export');
    expect(envelope.error.code).toBe('INVALID_INPUT');
  });
});
