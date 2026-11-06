import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  truncate,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readArtifactManifest } from '../../src/storage/artifactManifest.js';
import { MAX_EVENT_LOG_SIZE } from '../../src/storage/eventLogCodec.js';
import { eventLogPath, sessionDir } from '../../src/storage/sessionPaths.js';
import {
  cleanupHome,
  createSession,
  destroySession,
  runCli,
  type SuccessEnvelope,
  type WaitResult,
} from '../helpers.js';

// SVG export requires the optional native libghostty-vt package; skip the
// svg happy-path cases cleanly when it is unavailable.
let nativeAvailable = false;
try {
  await import('@coder/libghostty-vt-node');
  nativeAvailable = true;
} catch {
  nativeAvailable = false;
}
const maybeIt = nativeAvailable ? it : it.skip;

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
  format: 'asciicast' | 'webm' | 'svg';
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

  maybeIt(
    'exports deterministic svg artifacts with expected visible text',
    async () => {
      const sessionId = createSession(testHome, [
        '/bin/sh',
        '-c',
        "printf 'ready svg\\n'; exec cat",
      ]);

      waitForIdle(testHome, sessionId);

      const exportResult = runCli(
        ['record', 'export', sessionId, '--format', 'svg', '--json'],
        { AGENT_TTY_HOME: testHome },
        30_000,
      );
      expect(exportResult.status).toBe(0);
      expect(exportResult.stderr).toBe('');

      const envelope = JSON.parse(
        exportResult.stdout,
      ) as SuccessEnvelope<RecordExportResult>;
      expect(envelope.ok).toBe(true);
      expect(envelope.command).toBe('record export');
      expect(envelope.result.sessionId).toBe(sessionId);
      expect(envelope.result.format).toBe('svg');
      expect(envelope.result.artifactPath.endsWith('.svg')).toBe(true);
      expect(envelope.result.capturedAtSeq).toBeGreaterThanOrEqual(0);
      expect(envelope.result.durationMs).toBe(0);
      expect(envelope.result.metadata).toMatchObject({
        profileName: 'reference-dark',
        rendererBackend: 'libghostty-vt',
        animated: false,
        frameCount: 1,
      });

      const contents = await readFile(envelope.result.artifactPath, 'utf8');
      expect(
        contents.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'),
      ).toBe(true);
      expect(contents).toContain('ready svg');
      expect(envelope.result.bytes).toBe(Buffer.byteLength(contents, 'utf8'));
      expect(envelope.result.sha256).toBe(
        createHash('sha256')
          .update(Buffer.from(contents, 'utf8'))
          .digest('hex'),
      );

      // Determinism: repeated exports of the same session are byte-identical.
      const repeatSha256s: string[] = [];
      for (const outName of ['repeat-1.svg', 'repeat-2.svg']) {
        const repeatOut = join(testHome, outName);
        const repeatResult = runCli(
          [
            'record',
            'export',
            sessionId,
            '--format',
            'svg',
            '--out',
            repeatOut,
            '--json',
          ],
          { AGENT_TTY_HOME: testHome },
          30_000,
        );
        expect(repeatResult.status).toBe(0);
        const repeatContents = await readFile(repeatOut);
        repeatSha256s.push(
          createHash('sha256').update(repeatContents).digest('hex'),
        );
      }
      expect(repeatSha256s[0]).toBe(repeatSha256s[1]);

      const artifactManifest = await readJsonFile<{
        artifacts: Array<{
          kind: string;
          filename: string;
          sha256?: string;
          bytes?: number;
          capturedAtSeq: number;
        }>;
      }>(join(testHome, 'sessions', sessionId, 'artifacts', 'manifest.json'));
      const svgEntries = artifactManifest.artifacts.filter((entry) =>
        entry.filename.endsWith('.svg'),
      );
      expect(svgEntries.length).toBeGreaterThanOrEqual(1);
      expect(svgEntries[0]).toEqual(
        expect.objectContaining({
          kind: 'recording',
          filename: basename(envelope.result.artifactPath),
          sha256: envelope.result.sha256,
          bytes: envelope.result.bytes,
          capturedAtSeq: envelope.result.capturedAtSeq,
        }),
      );

      destroySession(testHome, sessionId);
    },
  );

  maybeIt(
    'writes distinct default files for still and animated svg exports',
    async () => {
      const sessionId = createSession(testHome, [
        '/bin/sh',
        '-c',
        "printf 'collide check\\n'; sleep 0.3; printf 'second\\n'; exit 0",
      ]);

      waitForExit(testHome, sessionId);

      const stillResult = runCli(
        ['record', 'export', sessionId, '--format', 'svg', '--json'],
        { AGENT_TTY_HOME: testHome },
        30_000,
      );
      expect(stillResult.status).toBe(0);
      const stillEnvelope = JSON.parse(
        stillResult.stdout,
      ) as SuccessEnvelope<RecordExportResult>;

      const animatedResult = runCli(
        [
          'record',
          'export',
          sessionId,
          '--format',
          'svg',
          '--animate',
          '--json',
        ],
        { AGENT_TTY_HOME: testHome },
        30_000,
      );
      expect(animatedResult.status).toBe(0);
      const animatedEnvelope = JSON.parse(
        animatedResult.stdout,
      ) as SuccessEnvelope<RecordExportResult>;

      // Distinct default filenames: the animated export must not overwrite
      // the still artifact file.
      expect(animatedEnvelope.result.artifactPath).not.toBe(
        stillEnvelope.result.artifactPath,
      );
      expect(
        basename(animatedEnvelope.result.artifactPath).includes('animated'),
      ).toBe(true);

      const stillContents = await readFile(stillEnvelope.result.artifactPath);
      const animatedContents = await readFile(
        animatedEnvelope.result.artifactPath,
      );
      expect(createHash('sha256').update(stillContents).digest('hex')).toBe(
        stillEnvelope.result.sha256,
      );
      expect(createHash('sha256').update(animatedContents).digest('hex')).toBe(
        animatedEnvelope.result.sha256,
      );

      const artifactManifest = await readJsonFile<{
        artifacts: Array<{
          kind: string;
          filename: string;
          sha256?: string;
          bytes?: number;
          metadata: Record<string, unknown>;
        }>;
      }>(join(testHome, 'sessions', sessionId, 'artifacts', 'manifest.json'));
      const svgEntries = artifactManifest.artifacts.filter((entry) =>
        entry.filename.endsWith('.svg'),
      );
      expect(svgEntries).toHaveLength(2);

      const stillEntry = svgEntries.find(
        (entry) =>
          entry.filename === basename(stillEnvelope.result.artifactPath),
      );
      const animatedEntry = svgEntries.find(
        (entry) =>
          entry.filename === basename(animatedEnvelope.result.artifactPath),
      );
      expect(stillEntry).toMatchObject({
        sha256: stillEnvelope.result.sha256,
        bytes: stillEnvelope.result.bytes,
        metadata: expect.objectContaining({ animated: false }) as unknown,
      });
      expect(animatedEntry).toMatchObject({
        sha256: animatedEnvelope.result.sha256,
        bytes: animatedEnvelope.result.bytes,
        metadata: expect.objectContaining({ animated: true }) as unknown,
      });
    },
  );

  maybeIt(
    'writes distinct default files per render profile for svg exports',
    async () => {
      const sessionId = createSession(testHome, [
        '/bin/sh',
        '-c',
        "printf 'profile collide check\\n'; exit 0",
      ]);

      waitForExit(testHome, sessionId);

      const envelopes: Array<SuccessEnvelope<RecordExportResult>> = [];
      for (const profile of ['reference-dark', 'reference-light']) {
        const result = runCli(
          [
            'record',
            'export',
            sessionId,
            '--format',
            'svg',
            '--profile',
            profile,
            '--json',
          ],
          { AGENT_TTY_HOME: testHome },
          30_000,
        );
        expect(result.status).toBe(0);
        envelopes.push(
          JSON.parse(result.stdout) as SuccessEnvelope<RecordExportResult>,
        );
      }
      const [darkEnvelope, lightEnvelope] = envelopes;
      expect(darkEnvelope).toBeDefined();
      expect(lightEnvelope).toBeDefined();

      // Distinct default filenames per profile: neither overwrites the other.
      expect(lightEnvelope?.result.artifactPath).not.toBe(
        darkEnvelope?.result.artifactPath,
      );
      expect(
        basename(darkEnvelope?.result.artifactPath ?? '').includes(
          'reference-dark',
        ),
      ).toBe(true);
      expect(
        basename(lightEnvelope?.result.artifactPath ?? '').includes(
          'reference-light',
        ),
      ).toBe(true);

      const artifactManifest = await readJsonFile<{
        artifacts: Array<{
          filename: string;
          sha256?: string;
          bytes?: number;
          metadata: Record<string, unknown>;
        }>;
      }>(join(testHome, 'sessions', sessionId, 'artifacts', 'manifest.json'));
      const entriesByFilename = new Map(
        artifactManifest.artifacts.map((entry) => [entry.filename, entry]),
      );

      const hashes: unknown[] = [];
      for (const envelope of envelopes) {
        const artifactFilePath = envelope.result.artifactPath;
        const contents = await readFile(artifactFilePath);
        expect(createHash('sha256').update(contents).digest('hex')).toBe(
          envelope.result.sha256,
        );
        const entry = entriesByFilename.get(basename(artifactFilePath));
        expect(entry).toMatchObject({
          sha256: envelope.result.sha256,
          bytes: envelope.result.bytes,
          metadata: expect.objectContaining({
            profileName: envelope.result.metadata.profileName,
            renderProfileHash: envelope.result.metadata.renderProfileHash,
          }) as unknown,
        });
        hashes.push(envelope.result.metadata.renderProfileHash);
      }
      // Different profiles produce different render profile hashes.
      expect(hashes[0]).toBeTruthy();
      expect(hashes[0]).not.toBe(hashes[1]);
    },
  );

  maybeIt('exports animated svg with recorded timing', async () => {
    const sessionId = createSession(testHome, [
      '/bin/sh',
      '-c',
      "printf 'first\\n'; sleep 0.3; printf 'second\\n'; exit 0",
    ]);

    waitForExit(testHome, sessionId);

    const exportResult = runCli(
      ['record', 'export', sessionId, '--format', 'svg', '--animate', '--json'],
      { AGENT_TTY_HOME: testHome },
      30_000,
    );
    expect(exportResult.status).toBe(0);
    expect(exportResult.stderr).toBe('');

    const envelope = JSON.parse(
      exportResult.stdout,
    ) as SuccessEnvelope<RecordExportResult>;
    expect(envelope.ok).toBe(true);
    expect(envelope.result.format).toBe('svg');
    expect(envelope.result.metadata.animated).toBe(true);
    expect(
      envelope.result.metadata.frameCount as number,
    ).toBeGreaterThanOrEqual(2);
    expect(envelope.result.durationMs ?? 0).toBeGreaterThan(0);

    const contents = await readFile(envelope.result.artifactPath, 'utf8');
    expect(contents).toContain('<animate attributeName="visibility"');
    expect(contents).toContain('second');
  });

  it('exports blank svg for a running-but-silent session', async () => {
    // /bin/sleep produces no output, so the event log stays empty. The blank
    // initial grid is synthesized from the manifest without booting a
    // renderer backend, so this needs no native gating.
    const sessionId = createSession(testHome, ['/bin/sleep', '60']);

    const exportResult = runCli(
      ['record', 'export', sessionId, '--format', 'svg', '--json'],
      { AGENT_TTY_HOME: testHome },
      30_000,
    );
    expect(exportResult.status).toBe(0);
    expect(exportResult.stderr).toBe('');

    const envelope = JSON.parse(
      exportResult.stdout,
    ) as SuccessEnvelope<RecordExportResult>;
    expect(envelope.ok).toBe(true);
    expect(envelope.result.format).toBe('svg');
    expect(envelope.result.capturedAtSeq).toBe(-1);
    expect(basename(envelope.result.artifactPath)).toBe(
      'recording--1-svg-reference-dark.svg',
    );
    expect(envelope.result.metadata).toMatchObject({
      frameCount: 1,
      animated: false,
      outputEventCount: 0,
      resizeEventCount: 0,
    });

    const contents = await readFile(envelope.result.artifactPath, 'utf8');
    expect(contents.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(
      true,
    );
    expect(contents).toContain(
      '<rect width="100%" height="100%" fill="#1e1e2e"/>',
    );

    destroySession(testHome, sessionId);
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

  it('names the size limit when the event log is too large to read', async () => {
    const sessionId = createSession(testHome, [
      '/bin/sh',
      '-c',
      "printf 'done\\n'; exit 0",
    ]);
    waitForExit(testHome, sessionId);
    // A log that a host of an older version grew past the limit. A sparse
    // file keeps the test fast: the size check runs before the read.
    await truncate(
      eventLogPath(sessionDir(testHome, sessionId)),
      MAX_EVENT_LOG_SIZE + 1,
    );

    const exportResult = runCli(
      ['record', 'export', sessionId, '--format', 'asciicast', '--json'],
      { AGENT_TTY_HOME: testHome },
      15_000,
    );
    expect(exportResult.status).toBe(7);
    const exportEnvelope = JSON.parse(exportResult.stdout) as ErrorEnvelope;
    expect(exportEnvelope.error.code).toBe('EXPORT_ERROR');
    expect(exportEnvelope.error.message).toMatch(
      new RegExp(
        `^Failed to export session "${sessionId}" as asciicast: its event log is \\d+ bytes, over the ${String(MAX_EVENT_LOG_SIZE)}-byte limit that commands can read\\.$`,
      ),
    );
    expect(exportEnvelope.error.details?.maxEventLogBytes).toBe(
      MAX_EVENT_LOG_SIZE,
    );

    const snapshotResult = runCli(
      ['snapshot', sessionId, '--json'],
      { AGENT_TTY_HOME: testHome },
      15_000,
    );
    expect(snapshotResult.status).toBe(10);
    const snapshotEnvelope = JSON.parse(snapshotResult.stdout) as ErrorEnvelope;
    expect(snapshotEnvelope.error.code).toBe('REPLAY_ERROR');
    expect(snapshotEnvelope.error.message).toContain(
      `-byte limit that commands can read.`,
    );
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

  it('rejects --animate with non-svg formats', () => {
    const result = runCli(
      [
        'record',
        'export',
        'session-01',
        '--format',
        'asciicast',
        '--animate',
        '--json',
      ],
      { AGENT_TTY_HOME: testHome },
      15_000,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(result.stdout) as ErrorEnvelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.command).toBe('record export');
    expect(envelope.error.code).toBe('INVALID_INPUT');
    expect(envelope.error.message).toContain('--animate');
  });

  it('rejects --timing with svg exports', () => {
    const result = runCli(
      [
        'record',
        'export',
        'session-01',
        '--format',
        'svg',
        '--timing',
        'recorded',
        '--json',
      ],
      { AGENT_TTY_HOME: testHome },
      15_000,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(result.stdout) as ErrorEnvelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.command).toBe('record export');
    expect(envelope.error.code).toBe('INVALID_INPUT');
    expect(envelope.error.message).toContain('--timing');
  });
});
