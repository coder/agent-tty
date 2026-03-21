import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  ArtifactEntry,
  ArtifactManifest,
} from '../../../src/storage/artifactManifest.js';
import {
  appendArtifact,
  ArtifactEntrySchema,
  readArtifactManifest,
  writeArtifactManifest,
} from '../../../src/storage/artifactManifest.js';
import {
  artifactPath,
  ensureArtifactsDir,
  recordingFilename,
  screenshotFilename,
  snapshotFilename,
  videoFilename,
} from '../../../src/storage/artifactPaths.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createSessionDir(sessionId = 'session-01'): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'agent-terminal-artifacts-'));
  temporaryDirectories.push(home);
  return join(home, sessionId);
}

function createArtifactEntry(
  overrides: Partial<ArtifactEntry> = {},
): ArtifactEntry {
  return {
    id: '01JQ0000000000000000000000',
    kind: 'snapshot',
    filename: 'snapshot-4-structured.json',
    sessionId: 'session-01',
    capturedAtSeq: 4,
    createdAt: '2026-03-20T12:00:00.000Z',
    metadata: {
      format: 'structured',
      cols: 80,
      rows: 24,
      cursorRow: 1,
      cursorCol: 2,
    },
    ...overrides,
  };
}

describe('artifact paths', () => {
  it('builds deterministic sanitized filenames and session artifact paths', async () => {
    const sessionDir = await createSessionDir();
    const screenshot = screenshotFilename(7, 'reference dark / baseline');
    const snapshot = snapshotFilename(7, 'structured');
    const recording = recordingFilename(7, 'asciicast');
    const video = videoFilename(7, 'reference dark / baseline');

    expect(screenshot).toBe('screenshot-7-reference-dark-baseline.png');
    expect(snapshot).toBe('snapshot-7-structured.json');
    expect(recording).toBe('recording-7-asciicast.cast');
    expect(video).toBe('video-7-reference-dark-baseline.mp4');
    expect(artifactPath(sessionDir, screenshot)).toBe(
      join(sessionDir, 'artifacts', screenshot),
    );

    const artifactsDir = await ensureArtifactsDir(sessionDir);

    expect(artifactsDir).toBe(join(sessionDir, 'artifacts'));
    await expect(access(artifactsDir)).resolves.toBeUndefined();
  });

  it('asserts on invalid helper inputs', () => {
    expect(() => screenshotFilename(-1, 'reference-dark')).toThrow(
      /seq must be a non-negative integer/u,
    );
    expect(() => screenshotFilename(0, '')).toThrow(
      /profileName must be a non-empty string/u,
    );
    expect(() => recordingFilename(0, '')).toThrow(
      /format must be a non-empty string/u,
    );
    expect(() => videoFilename(0, '')).toThrow(
      /profileName must be a non-empty string/u,
    );
    expect(() => artifactPath('relative/session', 'capture.png')).toThrow(
      /sessionDir must be an absolute path/u,
    );
    expect(() => artifactPath('/tmp/session-01', 'nested/capture.png')).toThrow(
      /filename must not contain path separators/u,
    );
  });
});

describe('artifact entry schema', () => {
  it('accepts recording and video artifact kinds', () => {
    expect(
      ArtifactEntrySchema.safeParse(
        createArtifactEntry({
          kind: 'recording',
          filename: 'recording-4-asciicast.cast',
        }),
      ).success,
    ).toBe(true);
    expect(
      ArtifactEntrySchema.safeParse(
        createArtifactEntry({
          kind: 'video',
          filename: 'video-4-reference-dark.mp4',
        }),
      ).success,
    ).toBe(true);
  });

  it('accepts optional sha256 and bytes fields', () => {
    expect(
      ArtifactEntrySchema.safeParse(
        createArtifactEntry({
          sha256: 'abc123',
          bytes: 2048,
        }),
      ).success,
    ).toBe(true);
  });
});

describe('artifact manifest storage', () => {
  it('returns an empty manifest when none exists and appends new artifacts', async () => {
    const sessionDir = await createSessionDir();

    await expect(readArtifactManifest(sessionDir)).resolves.toEqual({
      version: 1,
      sessionId: 'session-01',
      artifacts: [],
    });

    await appendArtifact(
      sessionDir,
      createArtifactEntry({
        id: '01JQ0000000000000000000001',
        kind: 'screenshot',
        filename: 'screenshot-4-reference-dark.png',
        metadata: {
          profileName: 'reference-dark',
          cols: 80,
          rows: 24,
          pngSizeBytes: 2048,
        },
      }),
    );

    await expect(readArtifactManifest(sessionDir)).resolves.toEqual({
      version: 1,
      sessionId: 'session-01',
      artifacts: [
        createArtifactEntry({
          id: '01JQ0000000000000000000001',
          kind: 'screenshot',
          filename: 'screenshot-4-reference-dark.png',
          metadata: {
            profileName: 'reference-dark',
            cols: 80,
            rows: 24,
            pngSizeBytes: 2048,
          },
        }),
      ],
    });
  });

  it('writes and reads artifact manifests with validation', async () => {
    const sessionDir = await createSessionDir();
    const manifest: ArtifactManifest = {
      version: 1,
      sessionId: 'session-01',
      artifacts: [createArtifactEntry()],
    };

    await writeArtifactManifest(sessionDir, manifest);

    await expect(readArtifactManifest(sessionDir)).resolves.toEqual(manifest);
    await expect(
      readFile(artifactPath(sessionDir, 'manifest.json'), 'utf8'),
    ).resolves.toMatch(/\n$/u);
  });

  it('rejects invalid manifest contents and mismatched entries', async () => {
    const sessionDir = await createSessionDir();

    await ensureArtifactsDir(sessionDir);
    await writeFile(
      artifactPath(sessionDir, 'manifest.json'),
      JSON.stringify({
        version: 1,
        sessionId: 'other-session',
        artifacts: [],
      }),
      'utf8',
    );

    await expect(readArtifactManifest(sessionDir)).rejects.toMatchObject({
      code: 'MANIFEST_VALIDATION_ERROR',
    });
    await expect(
      appendArtifact(
        sessionDir,
        createArtifactEntry({
          sessionId: 'other-session',
        }),
      ),
    ).rejects.toMatchObject({
      code: 'MANIFEST_VALIDATION_ERROR',
    });
  });
});
