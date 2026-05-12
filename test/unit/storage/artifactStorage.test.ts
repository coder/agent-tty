import { access, mkdir, readFile, writeFile } from 'node:fs/promises';

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTemporarySessionDir } from '../../helpers.js';

import type {
  ArtifactEntry,
  ArtifactManifest,
} from '../../../src/storage/artifactManifest.js';
import {
  appendArtifactWithRollback,
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

async function createSessionDir(sessionId = 'session-01'): Promise<string> {
  return await createTemporarySessionDir('agent-tty-artifacts-', sessionId);
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

  it('generates recording filenames for webm format', () => {
    expect(recordingFilename(7, 'webm')).toBe('recording-7-webm.webm');
  });

  it('asserts on unsupported recording formats', () => {
    expect(() => recordingFilename(7, 'trace')).toThrow(
      /unsupported recording format: trace/u,
    );
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
          sha256: 'a'.repeat(64),
          bytes: 2048,
        }),
      ).success,
    ).toBe(true);
  });

  it('rejects invalid sha256 values', () => {
    for (const sha256 of ['abc123', 'A'.repeat(64), 'g'.repeat(64)]) {
      const parsed = ArtifactEntrySchema.safeParse(
        createArtifactEntry({
          sha256,
        }),
      );

      expect(parsed.success).toBe(false);
    }
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

    await appendArtifactWithRollback({
      sessionDir,
      entry: createArtifactEntry({
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
    });

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

  it('preserves all entries when many concurrent appendArtifact() calls race for the same session', async () => {
    const sessionDir = await createSessionDir();
    const concurrentAppends = 20;

    await Promise.all(
      Array.from({ length: concurrentAppends }, (_value, index) =>
        appendArtifactWithRollback({
          sessionDir,
          entry: createArtifactEntry({
            id: `01JQ${String(index).padStart(22, '0')}`,
            filename: `snapshot-${String(index)}-structured.json`,
            capturedAtSeq: index,
          }),
        }),
      ),
    );

    const manifest = await readArtifactManifest(sessionDir);

    // DEREM-12: KeyedSerializer guarantees sequential execution in
    // submission order, so assert the persisted order directly rather
    // than collapsing to set membership via sort.
    expect(manifest.artifacts).toHaveLength(concurrentAppends);
    const seenSeqs = manifest.artifacts.map((entry) => entry.capturedAtSeq);
    expect(seenSeqs).toEqual(
      Array.from({ length: concurrentAppends }, (_value, index) => index),
    );
  });

  it('removes rollback artifact paths when manifest append fails', async () => {
    const sessionDir = await createSessionDir();
    const artifactFile = artifactPath(sessionDir, 'orphan.json');

    await ensureArtifactsDir(sessionDir);
    await writeFile(artifactFile, 'artifact', 'utf8');
    await writeFile(
      artifactPath(sessionDir, 'manifest.json'),
      `${JSON.stringify({
        version: 1,
        sessionId: 'other-session',
        artifacts: [],
      })}\n`,
      'utf8',
    );

    await expect(
      appendArtifactWithRollback({
        sessionDir,
        entry: createArtifactEntry({ filename: 'orphan.json' }),
        rollbackArtifactPath: artifactFile,
      }),
    ).rejects.toMatchObject({ code: 'MANIFEST_VALIDATION_ERROR' });

    await expect(access(artifactFile)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('preserves artifact paths when rollback is not requested', async () => {
    const sessionDir = await createSessionDir();
    const artifactFile = artifactPath(sessionDir, 'explicit-out.cast');

    await ensureArtifactsDir(sessionDir);
    await writeFile(artifactFile, 'artifact', 'utf8');
    await writeFile(
      artifactPath(sessionDir, 'manifest.json'),
      `${JSON.stringify({
        version: 1,
        sessionId: 'other-session',
        artifacts: [],
      })}\n`,
      'utf8',
    );

    await expect(
      appendArtifactWithRollback({
        sessionDir,
        entry: createArtifactEntry({ filename: 'explicit-out.cast' }),
      }),
    ).rejects.toMatchObject({ code: 'MANIFEST_VALIDATION_ERROR' });

    await expect(access(artifactFile)).resolves.toBeUndefined();
  });

  it('asserts rollback paths are non-empty and absolute', async () => {
    const sessionDir = await createSessionDir();

    await expect(
      appendArtifactWithRollback({
        sessionDir,
        entry: createArtifactEntry(),
        rollbackArtifactPath: '',
      }),
    ).rejects.toThrow(/rollbackArtifactPath must be a non-empty string/u);
    await expect(
      appendArtifactWithRollback({
        sessionDir,
        entry: createArtifactEntry(),
        rollbackArtifactPath: 'relative-artifact.json',
      }),
    ).rejects.toThrow(/rollbackArtifactPath must be absolute/u);
  });

  it('does not remove queued rollback paths when an earlier append fails', async () => {
    const sessionDir = await createSessionDir();
    const firstArtifact = artifactPath(sessionDir, 'first-orphan.json');
    const secondArtifact = artifactPath(sessionDir, 'second-orphan.json');

    await ensureArtifactsDir(sessionDir);
    await writeFile(firstArtifact, 'first', 'utf8');
    await writeFile(secondArtifact, 'second', 'utf8');
    await writeFile(
      artifactPath(sessionDir, 'manifest.json'),
      `${JSON.stringify({
        version: 1,
        sessionId: 'other-session',
        artifacts: [],
      })}\n`,
      'utf8',
    );

    const results = await Promise.allSettled([
      appendArtifactWithRollback({
        sessionDir,
        entry: createArtifactEntry({ filename: 'first-orphan.json' }),
        rollbackArtifactPath: firstArtifact,
      }),
      appendArtifactWithRollback({
        sessionDir,
        entry: createArtifactEntry({ filename: 'second-orphan.json' }),
        rollbackArtifactPath: secondArtifact,
      }),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ status: 'rejected' }),
      expect.objectContaining({ status: 'rejected' }),
    ]);
    await expect(access(firstArtifact)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(access(secondArtifact)).resolves.toBeUndefined();
  });

  it('does not mask the manifest error when rollback removal fails', async () => {
    const sessionDir = await createSessionDir();
    const blockedPath = artifactPath(sessionDir, 'blocked-artifact');

    await ensureArtifactsDir(sessionDir);
    await writeFile(
      artifactPath(sessionDir, 'manifest.json'),
      `${JSON.stringify({
        version: 1,
        sessionId: 'other-session',
        artifacts: [],
      })}\n`,
      'utf8',
    );
    await mkdir(blockedPath);
    await writeFile(join(blockedPath, 'child'), 'artifact', 'utf8');

    await expect(
      appendArtifactWithRollback({
        sessionDir,
        entry: createArtifactEntry({ filename: 'blocked-artifact' }),
        rollbackArtifactPath: blockedPath,
      }),
    ).rejects.toMatchObject({ code: 'MANIFEST_VALIDATION_ERROR' });
    await expect(access(join(blockedPath, 'child'))).resolves.toBeUndefined();
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
      appendArtifactWithRollback({
        sessionDir,
        entry: createArtifactEntry({
          sessionId: 'other-session',
        }),
      }),
    ).rejects.toMatchObject({
      code: 'MANIFEST_VALIDATION_ERROR',
    });
  });
});
