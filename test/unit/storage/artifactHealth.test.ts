import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ArtifactEntry,
  ArtifactManifest,
} from '../../../src/storage/artifactManifest.js';
import { ArtifactHealthSummarySchema } from '../../../src/protocol/messages.js';
import { writeArtifactManifest } from '../../../src/storage/artifactManifest.js';
import { computeArtifactHealth } from '../../../src/storage/artifactHealth.js';
import {
  artifactPath,
  ensureArtifactsDir,
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
  const home = await realpath(
    await mkdtemp(join(tmpdir(), 'agent-terminal-artifact-health-')),
  );
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

async function writeManifestAndFiles(
  sessionDir: string,
  artifacts: ArtifactEntry[],
  filenamesOnDisk: string[],
): Promise<void> {
  const manifest: ArtifactManifest = {
    version: 1,
    sessionId: 'session-01',
    artifacts,
  };

  await writeArtifactManifest(sessionDir, manifest);
  await ensureArtifactsDir(sessionDir);
  await Promise.all(
    filenamesOnDisk.map((filename) =>
      writeFile(artifactPath(sessionDir, filename), `${filename}\n`, 'utf8'),
    ),
  );
}

describe('computeArtifactHealth', () => {
  it('returns no-artifacts when no manifest file exists', async () => {
    const sessionDir = await createSessionDir();

    await expect(computeArtifactHealth(sessionDir)).resolves.toEqual({
      total: 0,
      byKind: {},
      missingCount: 0,
      health: 'no-artifacts',
    });
  });

  it('returns no-artifacts for an empty manifest', async () => {
    const sessionDir = await createSessionDir();

    await writeArtifactManifest(sessionDir, {
      version: 1,
      sessionId: 'session-01',
      artifacts: [],
    });

    await expect(computeArtifactHealth(sessionDir)).resolves.toEqual({
      total: 0,
      byKind: {},
      missingCount: 0,
      health: 'no-artifacts',
    });
  });

  it('returns healthy when all manifest artifacts exist on disk', async () => {
    const sessionDir = await createSessionDir();
    const artifacts = [
      createArtifactEntry(),
      createArtifactEntry({
        id: '01JQ0000000000000000000001',
        kind: 'screenshot',
        filename: 'screenshot-5-reference-dark.png',
        capturedAtSeq: 5,
        metadata: {
          profileName: 'reference-dark',
          cols: 80,
          rows: 24,
        },
      }),
    ];

    await writeManifestAndFiles(
      sessionDir,
      artifacts,
      artifacts.map((artifact) => artifact.filename),
    );

    const summary = await computeArtifactHealth(sessionDir);

    expect(summary).toEqual({
      total: 2,
      byKind: {
        snapshot: 1,
        screenshot: 1,
      },
      missingCount: 0,
      health: 'healthy',
    });
    expect(ArtifactHealthSummarySchema.safeParse(summary).success).toBe(true);
  });

  it('returns missing-artifacts with missing details when files are absent', async () => {
    const sessionDir = await createSessionDir();
    const artifacts = [
      createArtifactEntry(),
      createArtifactEntry({
        id: '01JQ0000000000000000000001',
        kind: 'video',
        filename: 'video-6-reference-dark.mp4',
        capturedAtSeq: 6,
        metadata: {
          profileName: 'reference-dark',
          durationMs: 1000,
        },
      }),
      createArtifactEntry({
        id: '01JQ0000000000000000000002',
        kind: 'recording',
        filename: 'recording-7-asciicast.cast',
        capturedAtSeq: 7,
        metadata: {
          format: 'asciicast',
        },
      }),
    ];

    await writeManifestAndFiles(
      sessionDir,
      artifacts,
      artifacts.slice(0, 1).map((artifact) => artifact.filename),
    );

    const summary = await computeArtifactHealth(sessionDir);

    expect(summary).toEqual({
      total: 3,
      byKind: {
        snapshot: 1,
        video: 1,
        recording: 1,
      },
      missingCount: 2,
      health: 'missing-artifacts',
      missing: [
        {
          id: '01JQ0000000000000000000001',
          kind: 'video',
          filename: 'video-6-reference-dark.mp4',
        },
        {
          id: '01JQ0000000000000000000002',
          kind: 'recording',
          filename: 'recording-7-asciicast.cast',
        },
      ],
    });
    expect(ArtifactHealthSummarySchema.safeParse(summary).success).toBe(true);
  });

  it('treats permission-denied artifacts as missing', async () => {
    const sessionDir = await createSessionDir();
    const artifact = createArtifactEntry({
      kind: 'screenshot',
      filename: 'screenshot-5-reference-dark.png',
      metadata: {
        profileName: 'reference-dark',
        cols: 80,
        rows: 24,
      },
    });

    await writeManifestAndFiles(sessionDir, [artifact], [artifact.filename]);

    const filePath = artifactPath(sessionDir, artifact.filename);
    vi.resetModules();
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<{
        access: (path: string) => Promise<void>;
      }>();

      return {
        ...actual,
        access: async (path: string) => {
          if (path === filePath) {
            throw Object.assign(new Error('EACCES: permission denied'), {
              code: 'EACCES',
            });
          }

          return actual.access(path);
        },
      };
    });

    try {
      const { computeArtifactHealth: computeArtifactHealthWithMock } =
        await import('../../../src/storage/artifactHealth.js');
      const summary = await computeArtifactHealthWithMock(sessionDir);

      expect(summary).toEqual({
        total: 1,
        byKind: {
          screenshot: 1,
        },
        missingCount: 1,
        health: 'missing-artifacts',
        missing: [
          {
            id: artifact.id,
            kind: 'screenshot',
            filename: artifact.filename,
          },
        ],
      });
      expect(ArtifactHealthSummarySchema.safeParse(summary).success).toBe(true);
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });

  it('counts mixed artifact kinds correctly', async () => {
    const sessionDir = await createSessionDir();
    const artifacts = [
      createArtifactEntry(),
      createArtifactEntry({
        id: '01JQ0000000000000000000001',
        kind: 'snapshot',
        filename: 'snapshot-5-text.json',
        capturedAtSeq: 5,
        metadata: {
          format: 'text',
          rows: 24,
          cols: 80,
        },
      }),
      createArtifactEntry({
        id: '01JQ0000000000000000000002',
        kind: 'screenshot',
        filename: 'screenshot-6-reference-light.png',
        capturedAtSeq: 6,
        metadata: {
          profileName: 'reference-light',
          cols: 80,
          rows: 24,
        },
      }),
      createArtifactEntry({
        id: '01JQ0000000000000000000003',
        kind: 'video',
        filename: 'video-7-reference-light.mp4',
        capturedAtSeq: 7,
        metadata: {
          profileName: 'reference-light',
          durationMs: 1000,
        },
      }),
    ];

    await writeManifestAndFiles(
      sessionDir,
      artifacts,
      artifacts.map((artifact) => artifact.filename),
    );

    await expect(computeArtifactHealth(sessionDir)).resolves.toMatchObject({
      total: 4,
      byKind: {
        snapshot: 2,
        screenshot: 1,
        video: 1,
      },
      missingCount: 0,
      health: 'healthy',
    });
  });

  it('returns manifest-invalid for invalid manifest JSON', async () => {
    const sessionDir = await createSessionDir();

    await ensureArtifactsDir(sessionDir);
    await writeFile(
      artifactPath(sessionDir, 'manifest.json'),
      '{invalid',
      'utf8',
    );

    await expect(computeArtifactHealth(sessionDir)).resolves.toEqual({
      total: 0,
      byKind: {},
      missingCount: 0,
      health: 'manifest-invalid',
    });
  });
});
