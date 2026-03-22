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
}

function resolveScreenshotProfile(profile: string | undefined): string {
  const effectiveProfile = profile ?? DEFAULT_SCREENSHOT_PROFILE;
  const profileResult = ScreenshotParamsSchema.safeParse({
    profile: effectiveProfile,
  });

  if (!profileResult.success) {
    throw makeCliError(ERROR_CODES.INVALID_INPUT, {
      message: 'Screenshot profile must be a non-empty string.',
      details: {
        profile: effectiveProfile,
      },
      cause: profileResult.error,
    });
  }

  if (profileResult.data.profile === undefined) {
    throw makeCliError(ERROR_CODES.INVALID_INPUT, {
      message: 'Screenshot profile is required.',
      details: {
        profile: effectiveProfile,
      },
    });
  }

  return profileResult.data.profile;
}

function formatScreenshotLines(result: ScreenshotResult): string[] {
  return [
    `Session ID: ${result.sessionId}`,
    `Captured At Seq: ${String(result.capturedAtSeq)}`,
    `Profile: ${result.profileName}`,
    `Size: ${String(result.cols)}x${String(result.rows)}`,
    `PNG Path: ${result.artifactPath}`,
    `PNG Size: ${String(result.pngSizeBytes)} bytes`,
  ];
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
        const result = await backend.screenshot(temporaryOutputPath);
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
            metadata: {
              profileName: result.profileName,
              cols: result.cols,
              rows: result.rows,
              pngSizeBytes: result.pngSizeBytes,
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
  const profile = resolveScreenshotProfile(options.profile);
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
      });
    } catch (error) {
      if (
        !(error instanceof CliError) ||
        error.code !== ERROR_CODES.HOST_UNREACHABLE
      ) {
        throw error;
      }

      rawResult = await runOfflineScreenshot(sessionDirectory, profile);
      invalidResultMessage = 'Unexpected screenshot result from offline replay';
    }
  } else {
    rawResult = await runOfflineScreenshot(sessionDirectory, profile);
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
