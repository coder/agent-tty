import { rename, rm } from 'node:fs/promises';

import { ulid } from 'ulid';

import type { ScreenshotResult } from '../../protocol/messages.js';

import type { CommandContext } from '../context.js';

import { emitSuccess } from '../output.js';
import { CliError } from '../../cli/errors.js';
import { sendRpc } from '../../host/rpcClient.js';
import { ScreenshotParamsSchema } from '../../protocol/messages.js';
import { ScreenshotResultSchema } from '../../protocol/schemas.js';
import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';
import { withOfflineReplayRenderer } from '../../replay/offlineReplay.js';
import {
  appendArtifact,
  createArtifactEntry,
} from '../../storage/artifactManifest.js';
import {
  artifactPath,
  ensureArtifactsDir,
  screenshotFilename,
} from '../../storage/artifactPaths.js';
import { readManifestIfExists } from '../../storage/manifests.js';
import {
  manifestPath,
  sessionDir,
  socketPath,
} from '../../storage/sessionPaths.js';
import { invariant } from '../../util/assert.js';

const DEFAULT_SCREENSHOT_PROFILE = 'reference-dark';

interface CommandOptions {
  context: CommandContext;
  json: boolean;
  sessionId: string;
  profile?: string;
  showCursor?: boolean;
}

interface ResolvedScreenshotRequest {
  profile: string;
  showCursor?: boolean;
}

function resolveScreenshotRequest(
  commandProfile: string | undefined,
  contextProfileDefault: string | undefined,
  showCursor: boolean | undefined,
): ResolvedScreenshotRequest {
  const effectiveProfile =
    commandProfile ?? contextProfileDefault ?? DEFAULT_SCREENSHOT_PROFILE;
  const requestResult = ScreenshotParamsSchema.safeParse({
    profile: effectiveProfile,
    ...(showCursor === undefined ? {} : { showCursor }),
  });

  if (!requestResult.success) {
    throw makeCliError(ERROR_CODES.INVALID_INPUT, {
      message: 'Screenshot request is invalid.',
      details: {
        profile: effectiveProfile,
        ...(showCursor === undefined ? {} : { showCursor }),
      },
      cause: requestResult.error,
    });
  }

  if (requestResult.data.profile === undefined) {
    throw makeCliError(ERROR_CODES.INVALID_INPUT, {
      message: 'Screenshot profile is required.',
      details: {
        profile: effectiveProfile,
      },
    });
  }

  return {
    profile: requestResult.data.profile,
    ...(requestResult.data.showCursor === undefined
      ? {}
      : { showCursor: requestResult.data.showCursor }),
  };
}

function formatScreenshotLines(result: ScreenshotResult): string[] {
  const lines = [
    `Session ID: ${result.sessionId}`,
    `Captured At Seq: ${String(result.capturedAtSeq)}`,
    `Profile: ${result.profileName}`,
    `Size: ${String(result.cols)}x${String(result.rows)}`,
    `PNG Path: ${result.artifactPath}`,
    `PNG Size: ${String(result.pngSizeBytes)} bytes`,
  ];

  if (result.rendererBackend !== undefined) {
    lines.push(`Renderer backend: ${result.rendererBackend}`);
  }
  if (result.pixelWidth !== undefined && result.pixelHeight !== undefined) {
    lines.push(
      `Pixel dimensions: ${String(result.pixelWidth)}×${String(result.pixelHeight)}`,
    );
  }
  if (result.sha256 !== undefined) {
    lines.push(`SHA-256: ${result.sha256}`);
  }
  if (result.renderProfileHash !== undefined) {
    lines.push(`Render profile hash: ${result.renderProfileHash}`);
  }

  return lines;
}

function parseScreenshotResult(
  rawResult: unknown,
  invalidResultMessage: string,
): ScreenshotResult {
  const parsedResult = ScreenshotResultSchema.safeParse(rawResult);
  if (!parsedResult.success) {
    throw makeCliError(ERROR_CODES.PROTOCOL_ERROR, {
      message: invalidResultMessage,
      details: { issues: parsedResult.error.issues },
    });
  }

  return parsedResult.data;
}

async function runOfflineScreenshot(
  sessionDirectory: string,
  profile: string,
  showCursor: boolean | undefined,
): Promise<ScreenshotResult> {
  return withOfflineReplayRenderer(
    { sessionDir: sessionDirectory, profileName: profile },
    async ({ backend, manifest }) => {
      await ensureArtifactsDir(sessionDirectory);
      const temporaryOutputPath = artifactPath(
        sessionDirectory,
        `.tmp-screenshot-${ulid()}.png`,
      );

      try {
        const result = await backend.screenshot(
          temporaryOutputPath,
          showCursor === undefined ? undefined : { showCursor },
        );
        invariant(
          result.sessionId === manifest.sessionId,
          'offline screenshot sessionId must match the manifest sessionId',
        );
        invariant(
          result.profileName === profile,
          'offline screenshot profileName must match the requested profile',
        );
        invariant(
          result.pngSizeBytes > 0,
          'offline screenshot pngSizeBytes must be positive',
        );
        invariant(
          result.sha256 !== undefined,
          'offline screenshot must produce sha256',
        );

        const filename = screenshotFilename(
          result.capturedAtSeq,
          result.profileName,
        );
        const finalArtifactPath = artifactPath(sessionDirectory, filename);
        await rename(temporaryOutputPath, finalArtifactPath);
        await appendArtifact(
          sessionDirectory,
          createArtifactEntry({
            kind: 'screenshot',
            filename,
            sessionId: result.sessionId,
            capturedAtSeq: result.capturedAtSeq,
            sha256: result.sha256,
            metadata: {
              profileName: result.profileName,
              cols: result.cols,
              rows: result.rows,
              pngSizeBytes: result.pngSizeBytes,
              cursorVisible: result.cursorVisible,
              rendererBackend: result.rendererBackend,
              pixelWidth: result.pixelWidth,
              pixelHeight: result.pixelHeight,
              renderProfileHash: result.renderProfileHash,
            },
          }),
        );

        return {
          sessionId: result.sessionId,
          capturedAtSeq: result.capturedAtSeq,
          profileName: result.profileName,
          cols: result.cols,
          rows: result.rows,
          artifactPath: finalArtifactPath,
          pngSizeBytes: result.pngSizeBytes,
          cursorVisible: result.cursorVisible,
          rendererBackend: result.rendererBackend,
          pixelWidth: result.pixelWidth,
          pixelHeight: result.pixelHeight,
          sha256: result.sha256,
          renderProfileHash: result.renderProfileHash,
        };
      } catch (error) {
        await rm(temporaryOutputPath, { force: true }).catch(() => undefined);
        throw error;
      }
    },
  );
}

export async function runScreenshotCommand(
  options: CommandOptions,
): Promise<void> {
  const { profile, showCursor } = resolveScreenshotRequest(
    options.profile,
    options.context.profileDefault,
    options.showCursor,
  );
  const home = options.context.home;
  let sessionDirectory: string;

  try {
    sessionDirectory = sessionDir(home, options.sessionId);
  } catch (error) {
    throw makeCliError(ERROR_CODES.INVALID_SESSION_ID, {
      message: `Session ID "${options.sessionId}" is invalid.`,
      details: {
        sessionId: options.sessionId,
      },
      cause: error,
    });
  }

  const manifestFile = manifestPath(sessionDirectory);
  const manifest = await readManifestIfExists(manifestFile);

  if (manifest === null) {
    throw makeCliError(ERROR_CODES.SESSION_NOT_FOUND, {
      message: `Session "${options.sessionId}" was not found.`,
      details: {
        sessionId: options.sessionId,
        manifestPath: manifestFile,
      },
    });
  }

  let rawResult: unknown;
  let invalidResultMessage = 'Unexpected response from host';

  if (manifest.status === 'running') {
    try {
      rawResult = await sendRpc(socketPath(sessionDirectory), 'screenshot', {
        profile,
        ...(showCursor === undefined ? {} : { showCursor }),
      });
    } catch (error) {
      if (
        !(error instanceof CliError) ||
        error.code !== ERROR_CODES.HOST_UNREACHABLE
      ) {
        throw error;
      }

      rawResult = await runOfflineScreenshot(
        sessionDirectory,
        profile,
        showCursor,
      );
      invalidResultMessage = 'Unexpected screenshot result from offline replay';
    }
  } else {
    rawResult = await runOfflineScreenshot(
      sessionDirectory,
      profile,
      showCursor,
    );
    invalidResultMessage = 'Unexpected screenshot result from offline replay';
  }

  const result = parseScreenshotResult(rawResult, invalidResultMessage);

  emitSuccess({
    command: 'screenshot',
    json: options.json,
    result,
    lines: formatScreenshotLines(result),
  });
}
