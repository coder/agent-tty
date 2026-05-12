import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createTemporarySessionDir,
  createTestSemanticSnapshot,
} from '../../helpers.js';

import {
  captureSnapshotResult,
  createSnapshotResult,
  persistSnapshotArtifact,
} from '../../../src/snapshot/capture.js';
import { readArtifactManifest } from '../../../src/storage/artifactManifest.js';
import {
  artifactPath,
  snapshotFilename,
} from '../../../src/storage/artifactPaths.js';

async function createSessionDir(sessionId = 'session-01'): Promise<string> {
  return await createTemporarySessionDir(
    'agent-tty-snapshot-capture-',
    sessionId,
  );
}

describe('snapshot capture', () => {
  it('creates structured snapshot results without changing the semantic snapshot shape', () => {
    const snapshot = createTestSemanticSnapshot({
      cells: [
        {
          lineNumber: 0,
          cells: [{ char: 'v', fg: '#ffffff', bg: '#000000' }],
        },
      ],
    });

    expect(createSnapshotResult(snapshot, 'structured')).toEqual({
      format: 'structured',
      ...snapshot,
    });
  });

  it('fails validation before writing snapshot artifacts', async () => {
    const sessionDirectory = await createSessionDir();
    const invalidSnapshot = createTestSemanticSnapshot({
      rows: 0,
    });

    await expect(
      captureSnapshotResult({
        sessionDir: sessionDirectory,
        format: 'structured',
        snapshot: invalidSnapshot,
        rendererBackend: 'test-backend',
        expectedSessionId: 'session-01',
      }),
    ).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
      message: 'Snapshot result validation failed.',
      details: { issues: expect.any(Array) as unknown },
    });

    await expect(
      access(artifactPath(sessionDirectory, snapshotFilename(5, 'structured'))),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readArtifactManifest(sessionDirectory)).resolves.toEqual({
      version: 1,
      sessionId: 'session-01',
      artifacts: [],
    });
  });

  it('fails expected session id mismatches before writing snapshot artifacts', async () => {
    const sessionDirectory = await createSessionDir();

    await expect(
      captureSnapshotResult({
        sessionDir: sessionDirectory,
        format: 'structured',
        snapshot: createTestSemanticSnapshot(),
        rendererBackend: 'test-backend',
        expectedSessionId: 'other-session',
      }),
    ).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
      message: 'Snapshot sessionId mismatch.',
      details: {
        expectedSessionId: 'other-session',
        actualSessionId: 'session-01',
      },
    });

    await expect(
      access(artifactPath(sessionDirectory, snapshotFilename(5, 'structured'))),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readArtifactManifest(sessionDirectory)).resolves.toEqual({
      version: 1,
      sessionId: 'session-01',
      artifacts: [],
    });
  });

  it('rejects inconsistent artifact persistence inputs before writing', async () => {
    const sessionDirectory = await createSessionDir();
    const snapshot = createTestSemanticSnapshot();
    const result = createSnapshotResult(snapshot, 'structured');

    await expect(
      persistSnapshotArtifact({
        sessionDir: sessionDirectory,
        format: 'text',
        snapshot,
        result,
        rendererBackend: 'test-backend',
      }),
    ).rejects.toThrow(/snapshot result format must match format/u);

    await expect(
      access(artifactPath(sessionDirectory, snapshotFilename(5, 'text'))),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not append a manifest entry when artifact writing fails', async () => {
    const sessionDirectory = await createSessionDir();
    const snapshot = createTestSemanticSnapshot();
    const result = createSnapshotResult(snapshot, 'structured');
    const filename = snapshotFilename(5, 'structured');
    await mkdir(artifactPath(sessionDirectory, filename), { recursive: true });

    await expect(
      persistSnapshotArtifact({
        sessionDir: sessionDirectory,
        format: 'structured',
        snapshot,
        result,
        rendererBackend: 'test-backend',
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_WRITE_ERROR' });

    await expect(readArtifactManifest(sessionDirectory)).resolves.toEqual({
      version: 1,
      sessionId: 'session-01',
      artifacts: [],
    });
  });

  it('removes the snapshot artifact when manifest append fails after write', async () => {
    const sessionDirectory = await createSessionDir();
    const snapshot = createTestSemanticSnapshot();
    const result = createSnapshotResult(snapshot, 'structured');
    const filename = snapshotFilename(5, 'structured');
    const snapshotPath = artifactPath(sessionDirectory, filename);
    const manifestFilePath = artifactPath(sessionDirectory, 'manifest.json');
    const unrelatedManifest = {
      version: 1,
      sessionId: 'unrelated-session',
      artifacts: [],
    };
    await mkdir(dirname(manifestFilePath), { recursive: true });
    await writeFile(manifestFilePath, `${JSON.stringify(unrelatedManifest)}\n`);

    await expect(
      persistSnapshotArtifact({
        sessionDir: sessionDirectory,
        format: 'structured',
        snapshot,
        result,
        rendererBackend: 'test-backend',
      }),
    ).rejects.toMatchObject({ code: 'MANIFEST_VALIDATION_ERROR' });

    await expect(access(snapshotPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(manifestFilePath, 'utf8')).resolves.toBe(
      `${JSON.stringify(unrelatedManifest)}\n`,
    );
  });

  it('requires renderer backend metadata before writing artifacts', async () => {
    const sessionDirectory = await createSessionDir();

    await expect(
      captureSnapshotResult({
        sessionDir: sessionDirectory,
        format: 'structured',
        snapshot: createTestSemanticSnapshot(),
        rendererBackend: '',
      }),
    ).rejects.toThrow(/rendererBackend must be a non-empty string/u);

    await expect(readArtifactManifest(sessionDirectory)).resolves.toEqual({
      version: 1,
      sessionId: 'session-01',
      artifacts: [],
    });
  });

  it('persists structured cells and omits scrollback metadata when scrollback is absent', async () => {
    const sessionDirectory = await createSessionDir();
    const snapshot = createTestSemanticSnapshot({
      cells: [
        {
          lineNumber: 0,
          cells: [
            { char: 'o', fg: '#ffffff', bg: '#000000' },
            { char: 'k', fg: '#00ff00', bg: '#000000', bold: true },
          ],
        },
      ],
    });

    const result = await captureSnapshotResult({
      sessionDir: sessionDirectory,
      format: 'structured',
      snapshot,
      rendererBackend: 'test-backend',
    });

    expect(result).toEqual({ format: 'structured', ...snapshot });
    const filename = snapshotFilename(5, 'structured');
    expect(
      JSON.parse(
        await readFile(artifactPath(sessionDirectory, filename), 'utf8'),
      ),
    ).toEqual(result);

    const manifest = await readArtifactManifest(sessionDirectory);
    expect(manifest.artifacts[0]?.metadata).toEqual({
      format: 'structured',
      rendererBackend: 'test-backend',
      cols: 80,
      rows: 24,
      cursorRow: 0,
      cursorCol: 0,
    });
  });

  it('captures text snapshot results without scrollback metadata when scrollback is absent', async () => {
    const sessionDirectory = await createSessionDir();
    const snapshot = createTestSemanticSnapshot({
      visibleLines: [
        { row: 0, text: 'first visible line' },
        { row: 1, text: 'second visible line' },
      ],
    });

    const result = await captureSnapshotResult({
      sessionDir: sessionDirectory,
      format: 'text',
      snapshot,
      rendererBackend: 'test-backend',
      expectedSessionId: 'session-01',
    });

    expect(result).toEqual({
      format: 'text',
      sessionId: 'session-01',
      capturedAtSeq: 5,
      cols: 80,
      rows: 24,
      cursorRow: 0,
      cursorCol: 0,
      text: 'first visible line\nsecond visible line',
    });

    const filename = snapshotFilename(5, 'text');
    await expect(
      readFile(artifactPath(sessionDirectory, filename), 'utf8'),
    ).resolves.toBe(`${JSON.stringify(result, null, 2)}\n`);

    const manifest = await readArtifactManifest(sessionDirectory);
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0]?.metadata).toEqual({
      format: 'text',
      rendererBackend: 'test-backend',
      cols: 80,
      rows: 24,
      cursorRow: 0,
      cursorCol: 0,
    });
  });

  it('captures text snapshot results and persists matching artifacts with scrollback metadata', async () => {
    const sessionDirectory = await createSessionDir();
    const snapshot = createTestSemanticSnapshot({
      scrollbackLines: [
        { row: 0, text: 'scrolled' },
        { row: 1, text: 'away' },
      ],
      visibleLines: [{ row: 2, text: 'visible output' }],
    });

    const result = await captureSnapshotResult({
      sessionDir: sessionDirectory,
      format: 'text',
      snapshot,
      rendererBackend: 'test-backend',
      expectedSessionId: 'session-01',
    });

    expect(result).toEqual({
      format: 'text',
      sessionId: 'session-01',
      capturedAtSeq: 5,
      cols: 80,
      rows: 24,
      cursorRow: 0,
      cursorCol: 0,
      text: 'scrolled\naway\nvisible output',
    });

    const filename = snapshotFilename(5, 'text');
    await expect(
      readFile(artifactPath(sessionDirectory, filename), 'utf8'),
    ).resolves.toBe(`${JSON.stringify(result, null, 2)}\n`);

    const manifest = await readArtifactManifest(sessionDirectory);
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0]).toMatchObject({
      kind: 'snapshot',
      filename,
      sessionId: 'session-01',
      capturedAtSeq: 5,
      metadata: {
        format: 'text',
        rendererBackend: 'test-backend',
        cols: 80,
        rows: 24,
        cursorRow: 0,
        cursorCol: 0,
        scrollbackLineCount: 2,
      },
    });
  });
});
