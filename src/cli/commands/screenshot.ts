import type { ScreenshotResult } from '../../protocol/messages.js';

import { emitSuccess } from '../output.js';
import { sendRpc } from '../../host/rpcClient.js';
import { ScreenshotParamsSchema } from '../../protocol/messages.js';
import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';
import { readManifestIfExists } from '../../storage/manifests.js';
import { resolveHome } from '../../storage/home.js';
import {
  manifestPath,
  sessionDir,
  socketPath,
} from '../../storage/sessionPaths.js';

const DEFAULT_SCREENSHOT_PROFILE = 'reference-dark';

interface CommandOptions {
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

export async function runScreenshotCommand(
  options: CommandOptions,
): Promise<void> {
  const profile = resolveScreenshotProfile(options.profile);
  const home = resolveHome();
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

  if (manifest.status !== 'running') {
    throw makeCliError(ERROR_CODES.SESSION_NOT_RUNNING, {
      message: `Session "${options.sessionId}" is not running.`,
      details: {
        sessionId: options.sessionId,
        status: manifest.status,
      },
    });
  }

  const result = (await sendRpc(socketPath(sessionDirectory), 'screenshot', {
    profile,
  })) as ScreenshotResult;

  emitSuccess({
    command: 'screenshot',
    json: options.json,
    result,
    lines: formatScreenshotLines(result),
  });
}
