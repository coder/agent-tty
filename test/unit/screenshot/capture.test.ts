import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createTemporarySessionDir } from '../../helpers.js';

import type { RendererBackend } from '../../../src/renderer/backend.js';
import type { ScreenshotResult } from '../../../src/protocol/messages.js';
import type {
  ReplayInput,
  ReplayState,
  SemanticSnapshot,
} from '../../../src/renderer/types.js';

import {
  captureScreenshotResult,
  parseScreenshotResult,
} from '../../../src/screenshot/capture.js';
import { readArtifactManifest } from '../../../src/storage/artifactManifest.js';
import {
  artifactPath,
  screenshotFilename,
} from '../../../src/storage/artifactPaths.js';

const TEST_SHA256 = 'a'.repeat(64);
const TEST_RENDER_PROFILE_HASH = 'b'.repeat(64);

interface FakeBackendOptions {
  resultOverrides?: Partial<ScreenshotResult>;
  writePng?: boolean;
  fail?: Error;
  onScreenshot?: (
    outputPath: string,
    options?: { showCursor?: boolean },
  ) => void;
}

function createFakeBackend(options: FakeBackendOptions = {}): RendererBackend {
  const writePng = options.writePng ?? true;

  return {
    rendererBackend: 'fake-renderer',
    isBooted: false,
    boot: vi.fn().mockResolvedValue(undefined),
    replayTo: vi.fn(
      (input: ReplayInput): Promise<ReplayState> =>
        Promise.resolve({
          lastSeq: input.targetSeq,
          cols: input.initialCols,
          rows: input.initialRows,
          cursorRow: 0,
          cursorCol: 0,
        }),
    ),
    snapshot: vi.fn(
      (): Promise<SemanticSnapshot> =>
        Promise.resolve({
          sessionId: 'session-01',
          capturedAtSeq: 0,
          cols: 80,
          rows: 24,
          cursorRow: 0,
          cursorCol: 0,
          isAltScreen: false,
          visibleLines: [],
        }),
    ),
    screenshot: vi.fn(
      async (
        outputPath: string,
        screenshotOptions?: { showCursor?: boolean },
      ): Promise<ScreenshotResult> => {
        options.onScreenshot?.(outputPath, screenshotOptions);
        if (options.fail !== undefined) {
          throw options.fail;
        }
        if (writePng) {
          await writeFile(outputPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        }
        return {
          sessionId: 'session-01',
          capturedAtSeq: 5,
          profileName: 'reference-dark',
          cols: 80,
          rows: 24,
          artifactPath: outputPath,
          pngSizeBytes: 4,
          cursorVisible: screenshotOptions?.showCursor === true,
          rendererBackend: 'fake-renderer',
          pixelWidth: 800,
          pixelHeight: 600,
          sha256: TEST_SHA256,
          renderProfileHash: TEST_RENDER_PROFILE_HASH,
          ...options.resultOverrides,
        };
      },
    ),
    getVisibleText: vi.fn().mockResolvedValue(''),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

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
    await expect(readFile(expectedPath)).resolves.toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );

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
  });

  it('rejects renderer results that violate the shared invariants', async () => {
    const cases: Array<{
      name: string;
      overrides: Partial<ScreenshotResult>;
      pattern: RegExp;
    }> = [
      {
        name: 'sessionId mismatch',
        overrides: { sessionId: 'other-session' },
        pattern: /sessionId must match expected sessionId/u,
      },
      {
        name: 'profileName mismatch',
        overrides: { profileName: 'reference-light' },
        pattern: /profileName must match the requested profile/u,
      },
      {
        name: 'non-positive pngSizeBytes',
        // pngSizeBytes is asserted before the schema runs, so the loose cast is
        // intentional to exercise the runtime invariant the same way a buggy
        // backend would surface.
        overrides: { pngSizeBytes: 0 } as unknown as Partial<ScreenshotResult>,
        pattern: /pngSizeBytes must be positive/u,
      },
      {
        name: 'mismatched artifactPath',
        overrides: { artifactPath: '/wrong/path.png' },
        pattern: /path must match the requested output path/u,
      },
      {
        name: 'missing sha256',
        overrides: { sha256: undefined },
        pattern: /must produce sha256/u,
      },
    ];

    for (const testCase of cases) {
      const sessionDirectory = await createSessionDir(
        `session-inv-${testCase.name.replace(/\W+/gu, '-')}`,
      );
      const backend = createFakeBackend({
        resultOverrides: {
          ...testCase.overrides,
          sessionId:
            testCase.overrides.sessionId ??
            `session-inv-${testCase.name.replace(/\W+/gu, '-')}`,
        },
      });
      const expectedSessionId = `session-inv-${testCase.name.replace(/\W+/gu, '-')}`;

      await expect(
        captureScreenshotResult({
          backend,
          sessionDir: sessionDirectory,
          profileName: 'reference-dark',
          expectedSessionId,
        }),
      ).rejects.toThrow(testCase.pattern);

      const manifest = await readArtifactManifest(sessionDirectory);
      expect(manifest.artifacts, `case: ${testCase.name}`).toEqual([]);
      // The temp file should have been cleaned up; final filename should not
      // exist either since rename never ran.
      await expect(
        access(
          artifactPath(
            sessionDirectory,
            screenshotFilename(5, 'reference-dark'),
          ),
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('rejects malformed public results before rename or manifest append', async () => {
    const sessionDirectory = await createSessionDir();
    const backend = createFakeBackend({
      // cols=0 passes the runtime invariants but trips the strict
      // ScreenshotResultSchema PositiveIntSchema validation.
      resultOverrides: { cols: 0 } as unknown as Partial<ScreenshotResult>,
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

  it('preserves the renamed final PNG when manifest append fails after rename', async () => {
    const sessionDirectory = await createSessionDir();
    const finalFilename = screenshotFilename(5, 'reference-dark');
    const finalPath = artifactPath(sessionDirectory, finalFilename);
    // Pre-write a manifest whose sessionId does not match the directory so
    // `appendArtifact` raises a MANIFEST_VALIDATION_ERROR after the temp file
    // has already been renamed into place.
    const manifestFilePath = artifactPath(sessionDirectory, 'manifest.json');
    await mkdir(dirname(manifestFilePath), { recursive: true });
    await writeFile(
      manifestFilePath,
      `${JSON.stringify({
        version: 1,
        sessionId: 'unrelated-session',
        artifacts: [],
      })}\n`,
    );

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

    // Final PNG remains as a documented G1 orphan — there is no rollback
    // for the rename when the manifest append fails afterwards.
    await expect(access(finalPath)).resolves.toBeUndefined();
    if (observedTempPath !== undefined) {
      await expect(access(observedTempPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
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
