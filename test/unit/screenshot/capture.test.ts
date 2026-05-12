import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTemporarySessionDir } from '../../helpers.js';

import type { ScreenshotResult } from '../../../src/renderer/types.js';

import {
  captureScreenshotResult,
  parseScreenshotResult,
} from '../../../src/screenshot/capture.js';
import { readArtifactManifest } from '../../../src/storage/artifactManifest.js';
import {
  artifactPath,
  screenshotFilename,
} from '../../../src/storage/artifactPaths.js';

import { createFakeBackend } from '../../helpers/fakeBackend.js';

const TEST_SHA256 = 'a'.repeat(64);
const TEST_RENDER_PROFILE_HASH = 'b'.repeat(64);
// First four bytes of the PNG magic signature (0x89 'P' 'N' 'G'). Enough to
// satisfy the test that we wrote/read the same buffer; the renderer
// produces a real PNG, but these unit tests do not validate the format.
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

async function createSessionDir(sessionId = 'session-01'): Promise<string> {
  return await createTemporarySessionDir(
    'agent-tty-screenshot-capture-',
    sessionId,
  );
}

describe('parseScreenshotResult', () => {
  it('returns the validated screenshot result on success', () => {
    const result = parseScreenshotResult({
      sessionId: 'session-01',
      capturedAtSeq: 5,
      profileName: 'reference-dark',
      cols: 80,
      rows: 24,
      artifactPath: '/tmp/screenshot.png',
      pngSizeBytes: 4,
      sha256: TEST_SHA256,
    });

    expect(result.sessionId).toBe('session-01');
    expect(result.sha256).toBe(TEST_SHA256);
  });

  it('throws PROTOCOL_ERROR with the supplied message on schema failure', () => {
    expect(() =>
      parseScreenshotResult(
        {
          sessionId: 'session-01',
          capturedAtSeq: 5,
          // missing profileName, cols, rows, artifactPath, pngSizeBytes
        },
        'custom error message',
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'PROTOCOL_ERROR',
        message: 'custom error message',
      }) as object,
    );
  });

  it('uses a default message when none is supplied', () => {
    expect(() => parseScreenshotResult({})).toThrow(
      expect.objectContaining({
        code: 'PROTOCOL_ERROR',
        message: 'Unexpected response from host',
      }) as object,
    );
  });
});

describe('screenshot capture', () => {
  it('writes the PNG to the final artifact path and returns a typed result', async () => {
    const sessionDirectory = await createSessionDir();
    const backend = createFakeBackend();

    const result = await captureScreenshotResult({
      backend,
      sessionDir: sessionDirectory,
      profileName: 'reference-dark',
      expectedSessionId: 'session-01',
    });

    const expectedFilename = screenshotFilename(5, 'reference-dark');
    const expectedPath = artifactPath(sessionDirectory, expectedFilename);

    expect(result).toEqual({
      sessionId: 'session-01',
      capturedAtSeq: 5,
      profileName: 'reference-dark',
      cols: 80,
      rows: 24,
      artifactPath: expectedPath,
      pngSizeBytes: 4,
      cursorVisible: false,
      rendererBackend: 'fake-renderer',
      pixelWidth: 800,
      pixelHeight: 600,
      sha256: TEST_SHA256,
      renderProfileHash: TEST_RENDER_PROFILE_HASH,
    });

    await expect(access(expectedPath)).resolves.toBeUndefined();
    await expect(readFile(expectedPath)).resolves.toEqual(PNG_HEADER);

    const manifest = await readArtifactManifest(sessionDirectory);
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0]).toMatchObject({
      kind: 'screenshot',
      filename: expectedFilename,
      sessionId: 'session-01',
      capturedAtSeq: 5,
      sha256: TEST_SHA256,
      metadata: {
        profileName: 'reference-dark',
        cols: 80,
        rows: 24,
        pngSizeBytes: 4,
        cursorVisible: false,
        rendererBackend: 'fake-renderer',
        pixelWidth: 800,
        pixelHeight: 600,
        renderProfileHash: TEST_RENDER_PROFILE_HASH,
      },
    });
  });

  it('omits screenshot options when showCursor is undefined and threads it when set', async () => {
    const sessionDirectory = await createSessionDir();
    const observed: Array<{
      outputPath: string;
      options: { showCursor?: boolean } | undefined;
    }> = [];
    const backend = createFakeBackend({
      onScreenshot: (outputPath, screenshotOptions) => {
        observed.push({ outputPath, options: screenshotOptions });
      },
    });

    await captureScreenshotResult({
      backend,
      sessionDir: sessionDirectory,
      profileName: 'reference-dark',
      expectedSessionId: 'session-01',
    });

    expect(observed.at(-1)?.options).toBeUndefined();

    const sessionDirectory2 = await createSessionDir('session-02');
    const backendWithCursor = createFakeBackend({
      onScreenshot: (outputPath, screenshotOptions) => {
        observed.push({ outputPath, options: screenshotOptions });
      },
      resultOverrides: { sessionId: 'session-02' },
    });

    const cursorResult = await captureScreenshotResult({
      backend: backendWithCursor,
      sessionDir: sessionDirectory2,
      profileName: 'reference-dark',
      expectedSessionId: 'session-02',
      showCursor: true,
    });

    expect(observed.at(-1)?.options).toEqual({ showCursor: true });
    expect(cursorResult.cursorVisible).toBe(true);

    // showCursor: false must be threaded through as a distinct value (not
    // collapsed to undefined). Guards against the ternary regressing to a
    // truthy-only check.
    const sessionDirectoryFalse = await createSessionDir('session-03');
    const backendShowFalse = createFakeBackend({
      onScreenshot: (outputPath, screenshotOptions) => {
        observed.push({ outputPath, options: screenshotOptions });
      },
      resultOverrides: { sessionId: 'session-03' },
    });

    const falseResult = await captureScreenshotResult({
      backend: backendShowFalse,
      sessionDir: sessionDirectoryFalse,
      profileName: 'reference-dark',
      expectedSessionId: 'session-03',
      showCursor: false,
    });

    expect(observed.at(-1)?.options).toEqual({ showCursor: false });
    expect(falseResult.cursorVisible).toBe(false);
  });

  it('rejects empty sessionDir, profileName, or expectedSessionId before invoking the backend', async () => {
    const sessionDirectory = await createSessionDir();
    const observed: Array<string> = [];
    const backend = createFakeBackend({
      onScreenshot: (outputPath) => {
        observed.push(outputPath);
      },
    });

    await expect(
      captureScreenshotResult({
        backend,
        sessionDir: '',
        profileName: 'reference-dark',
        expectedSessionId: 'session-01',
      }),
    ).rejects.toThrow(/sessionDir must be non-empty/u);

    await expect(
      captureScreenshotResult({
        backend,
        sessionDir: sessionDirectory,
        profileName: '',
        expectedSessionId: 'session-01',
      }),
    ).rejects.toThrow(/profileName must be non-empty/u);

    await expect(
      captureScreenshotResult({
        backend,
        sessionDir: sessionDirectory,
        profileName: 'reference-dark',
        expectedSessionId: '',
      }),
    ).rejects.toThrow(/expectedSessionId must be non-empty/u);

    expect(observed).toEqual([]);
  });

  // Each invariant gets its own test so that a single failure does not
  // mask the others. Using `it.each` keeps the table-driven readability
  // while reporting one independent test per row.
  it.each([
    {
      name: 'sessionId mismatch',
      overrides: { sessionId: 'other-session' } as Partial<ScreenshotResult>,
      pattern: /sessionId must match expected sessionId/u,
    },
    {
      name: 'profileName mismatch',
      overrides: {
        profileName: 'reference-light',
      } as Partial<ScreenshotResult>,
      pattern: /profileName must match the requested profile/u,
    },
    {
      // pngSizeBytes is asserted before the schema runs, so passing 0
      // exercises the runtime invariant the same way a buggy backend would.
      name: 'non-positive pngSizeBytes',
      overrides: { pngSizeBytes: 0 } as Partial<ScreenshotResult>,
      pattern: /pngSizeBytes must be positive/u,
    },
    {
      name: 'mismatched artifactPath',
      overrides: {
        artifactPath: '/wrong/path.png',
      } as Partial<ScreenshotResult>,
      pattern: /path must match the requested output path/u,
    },
    {
      name: 'missing sha256',
      overrides: { sha256: undefined } as Partial<ScreenshotResult>,
      pattern: /must produce sha256/u,
    },
  ])(
    'rejects $name and removes the temp file before any persistence',
    async ({ name, overrides, pattern }) => {
      const sessionId = `session-inv-${name.replace(/\W+/gu, '-')}`;
      const sessionDirectory = await createSessionDir(sessionId);
      let observedTempPath: string | undefined;
      const backend = createFakeBackend({
        resultOverrides: {
          ...overrides,
          sessionId: overrides.sessionId ?? sessionId,
        },
        onScreenshot: (outputPath) => {
          observedTempPath = outputPath;
        },
      });

      await expect(
        captureScreenshotResult({
          backend,
          sessionDir: sessionDirectory,
          profileName: 'reference-dark',
          expectedSessionId: sessionId,
        }),
      ).rejects.toThrow(pattern);

      const manifest = await readArtifactManifest(sessionDirectory);
      expect(manifest.artifacts).toEqual([]);
      // The temp file written by the fake backend should have been removed.
      expect(observedTempPath).toMatch(
        /\/artifacts\/\.tmp-screenshot-.*\.png$/u,
      );
      if (observedTempPath !== undefined) {
        await expect(access(observedTempPath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
      // The final filename should not exist either since rename never ran.
      await expect(
        access(
          artifactPath(
            sessionDirectory,
            screenshotFilename(5, 'reference-dark'),
          ),
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('rejects malformed public results before rename or manifest append', async () => {
    const sessionDirectory = await createSessionDir();
    const backend = createFakeBackend({
      // cols=0 passes the runtime invariants but trips the strict
      // ScreenshotResultSchema PositiveIntSchema validation.
      resultOverrides: { cols: 0 },
    });

    await expect(
      captureScreenshotResult({
        backend,
        sessionDir: sessionDirectory,
        profileName: 'reference-dark',
        expectedSessionId: 'session-01',
      }),
    ).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
      message: 'Screenshot result validation failed.',
      details: { issues: expect.any(Array) as unknown },
    });

    const manifest = await readArtifactManifest(sessionDirectory);
    expect(manifest.artifacts).toEqual([]);
    await expect(
      access(
        artifactPath(sessionDirectory, screenshotFilename(5, 'reference-dark')),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes the temp file when rename fails after a successful render', async () => {
    const sessionDirectory = await createSessionDir();
    const finalFilename = screenshotFilename(5, 'reference-dark');
    const finalPath = artifactPath(sessionDirectory, finalFilename);
    // Pre-create a non-empty directory at the final destination so rename
    // cannot replace it with the temp file (ENOTEMPTY/EISDIR on POSIX).
    await mkdir(finalPath, { recursive: true });
    await writeFile(`${finalPath}/blocker`, 'present');

    let observedTempPath: string | undefined;
    const backend = createFakeBackend({
      onScreenshot: (outputPath) => {
        observedTempPath = outputPath;
      },
    });

    await expect(
      captureScreenshotResult({
        backend,
        sessionDir: sessionDirectory,
        profileName: 'reference-dark',
        expectedSessionId: 'session-01',
      }),
    ).rejects.toThrow();

    expect(observedTempPath).toMatch(/\/artifacts\/\.tmp-screenshot-.*\.png$/u);
    if (observedTempPath !== undefined) {
      await expect(access(observedTempPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
    const manifest = await readArtifactManifest(sessionDirectory);
    expect(manifest.artifacts).toEqual([]);
  });

  it('removes the renamed final PNG when manifest append fails after rename', async () => {
    const sessionDirectory = await createSessionDir();
    const finalFilename = screenshotFilename(5, 'reference-dark');
    const finalPath = artifactPath(sessionDirectory, finalFilename);
    // Pre-write a manifest whose sessionId does not match the directory so
    // `appendArtifactWithRollback` raises a MANIFEST_VALIDATION_ERROR after
    // the temp file has already been renamed into place.
    const manifestFilePath = artifactPath(sessionDirectory, 'manifest.json');
    const unrelatedManifest = {
      version: 1,
      sessionId: 'unrelated-session',
      artifacts: [],
    };
    await mkdir(dirname(manifestFilePath), { recursive: true });
    await writeFile(manifestFilePath, `${JSON.stringify(unrelatedManifest)}\n`);

    let observedTempPath: string | undefined;
    const backend = createFakeBackend({
      onScreenshot: (outputPath) => {
        observedTempPath = outputPath;
      },
    });

    await expect(
      captureScreenshotResult({
        backend,
        sessionDir: sessionDirectory,
        profileName: 'reference-dark',
        expectedSessionId: 'session-01',
      }),
    ).rejects.toMatchObject({ code: 'MANIFEST_VALIDATION_ERROR' });

    // The temp file has already been renamed, so rollback must remove the
    // final artifact path to avoid leaving an unmanifested PNG behind.
    await expect(access(finalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    if (observedTempPath !== undefined) {
      await expect(access(observedTempPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
    await expect(readFile(manifestFilePath, 'utf8')).resolves.toBe(
      `${JSON.stringify(unrelatedManifest)}\n`,
    );
  });

  it('removes the temp file and rethrows when the renderer screenshot rejects', async () => {
    const sessionDirectory = await createSessionDir();
    const captureError = new Error('renderer crashed');
    let observedTempPath: string | undefined;
    const backend = createFakeBackend({
      writePng: false,
      onScreenshot: (outputPath) => {
        observedTempPath = outputPath;
      },
      fail: captureError,
    });

    await expect(
      captureScreenshotResult({
        backend,
        sessionDir: sessionDirectory,
        profileName: 'reference-dark',
        expectedSessionId: 'session-01',
      }),
    ).rejects.toBe(captureError);

    expect(observedTempPath).toMatch(/\/artifacts\/\.tmp-screenshot-.*\.png$/u);
    if (observedTempPath !== undefined) {
      await expect(access(observedTempPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
    const manifest = await readArtifactManifest(sessionDirectory);
    expect(manifest.artifacts).toEqual([]);
  });
});
