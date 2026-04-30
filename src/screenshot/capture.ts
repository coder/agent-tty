import { rename, rm } from 'node:fs/promises';

import { ulid } from 'ulid';

import type { ScreenshotResult } from '../protocol/messages.js';
import type { RendererBackend } from '../renderer/backend.js';

import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import { ScreenshotResultSchema } from '../protocol/schemas.js';
import {
  appendArtifact,
  createArtifactEntry,
} from '../storage/artifactManifest.js';
import {
  artifactPath,
  ensureArtifactsDir,
  screenshotFilename,
} from '../storage/artifactPaths.js';
import { invariant } from '../util/assert.js';

/**
 * The narrow renderer surface the capture helper needs. Accepting only
 * `screenshot()` makes it impossible for future edits to reach for unrelated
 * lifecycle methods (`boot`, `replayTo`, `dispose`, etc.) from inside the
 * capture seam. Callers already hold a full `RendererBackend`, which is
 * structurally assignable to this `Pick<...>`.
 */
export type CaptureScreenshotBackend = Pick<RendererBackend, 'screenshot'>;

/**
 * The shared capture path enforces `sha256` as a runtime invariant on every
 * successful screenshot. We refine the public schema's optional `sha256` to
 * `string` here so callers — and TypeScript — see that guarantee directly.
 */
export type CapturedScreenshotResult = ScreenshotResult & { sha256: string };

export interface CaptureScreenshotResultOptions {
  backend: CaptureScreenshotBackend;
  sessionDir: string;
  profileName: string;
  expectedSessionId: string;
  showCursor?: boolean;
}

export function parseScreenshotResult(
  rawResult: unknown,
  message = 'Unexpected response from host',
): ScreenshotResult {
  const parsedResult = ScreenshotResultSchema.safeParse(rawResult);
  if (!parsedResult.success) {
    throw makeCliError(ERROR_CODES.PROTOCOL_ERROR, {
      message,
      details: { issues: parsedResult.error.issues },
    });
  }

  return parsedResult.data;
}

export async function captureScreenshotResult(
  options: CaptureScreenshotResultOptions,
): Promise<CapturedScreenshotResult> {
  invariant(options.sessionDir.length > 0, 'sessionDir must be non-empty');
  invariant(options.profileName.length > 0, 'profileName must be non-empty');
  invariant(
    options.expectedSessionId.length > 0,
    'expectedSessionId must be non-empty',
  );

  await ensureArtifactsDir(options.sessionDir);
  const temporaryOutputPath = artifactPath(
    options.sessionDir,
    `.tmp-screenshot-${ulid()}.png`,
  );

  try {
    const rendererResult = await options.backend.screenshot(
      temporaryOutputPath,
      options.showCursor === undefined
        ? undefined
        : { showCursor: options.showCursor },
    );

    invariant(
      rendererResult.sessionId === options.expectedSessionId,
      'renderer screenshot sessionId must match expected sessionId',
    );
    invariant(
      rendererResult.profileName === options.profileName,
      'renderer screenshot profileName must match the requested profile',
    );
    invariant(
      rendererResult.pngSizeBytes > 0,
      'renderer screenshot pngSizeBytes must be positive',
    );
    invariant(
      rendererResult.artifactPath === temporaryOutputPath,
      'renderer screenshot path must match the requested output path',
    );
    const sha256 = rendererResult.sha256;
    invariant(sha256 !== undefined, 'renderer screenshot must produce sha256');

    const filename = screenshotFilename(
      rendererResult.capturedAtSeq,
      rendererResult.profileName,
    );
    const finalArtifactPath = artifactPath(options.sessionDir, filename);

    // Mirror `src/snapshot/capture.ts` by building a typed intermediate
    // before validation. A misspelled field name surfaces at compile time
    // here rather than only at Zod runtime.
    const publicResultCandidate: CapturedScreenshotResult = {
      sessionId: rendererResult.sessionId,
      capturedAtSeq: rendererResult.capturedAtSeq,
      profileName: rendererResult.profileName,
      cols: rendererResult.cols,
      rows: rendererResult.rows,
      artifactPath: finalArtifactPath,
      pngSizeBytes: rendererResult.pngSizeBytes,
      cursorVisible: rendererResult.cursorVisible,
      rendererBackend: rendererResult.rendererBackend,
      pixelWidth: rendererResult.pixelWidth,
      pixelHeight: rendererResult.pixelHeight,
      sha256,
      renderProfileHash: rendererResult.renderProfileHash,
    };
    const parsedResult = parseScreenshotResult(
      publicResultCandidate,
      'Screenshot result validation failed.',
    );
    // Re-narrow `sha256` after the parse instead of asserting through a
    // type cast. If `ScreenshotResultSchema` is ever changed to strip or
    // transform `sha256`, this invariant catches it instead of silently
    // hiding the regression.
    invariant(
      parsedResult.sha256 !== undefined,
      'parsed screenshot result must preserve sha256',
    );
    const publicResult: CapturedScreenshotResult = {
      ...parsedResult,
      sha256: parsedResult.sha256,
    };

    await rename(temporaryOutputPath, finalArtifactPath);
    await appendArtifact(
      options.sessionDir,
      createArtifactEntry({
        kind: 'screenshot',
        filename,
        sessionId: publicResult.sessionId,
        capturedAtSeq: publicResult.capturedAtSeq,
        sha256,
        metadata: {
          profileName: publicResult.profileName,
          cols: publicResult.cols,
          rows: publicResult.rows,
          pngSizeBytes: publicResult.pngSizeBytes,
          cursorVisible: publicResult.cursorVisible,
          rendererBackend: publicResult.rendererBackend,
          pixelWidth: publicResult.pixelWidth,
          pixelHeight: publicResult.pixelHeight,
          renderProfileHash: publicResult.renderProfileHash,
        },
      }),
    );

    return publicResult;
  } catch (error) {
    await rm(temporaryOutputPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
