import type { ScreenshotResult } from '../../protocol/messages.js';

import type { CommandContext } from '../context.js';

import { emitSuccess } from '../output.js';
import { CliError } from '../../cli/errors.js';
import { sendRpc } from '../../host/rpcClient.js';
import { ScreenshotParamsSchema } from '../../protocol/messages.js';
import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';
import { withOfflineReplayRenderer } from '../../replay/offlineReplay.js';
import {
  captureScreenshotResult,
  parseScreenshotResult,
} from '../../screenshot/capture.js';
import { readManifestIfExists } from '../../storage/manifests.js';
import {
  manifestPath,
  sessionDir,
  socketPath,
} from '../../storage/sessionPaths.js';

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

async function runOfflineScreenshot(
  sessionDirectory: string,
  rendererName: CommandContext['rendererDefault'],
  profile: string,
  showCursor: boolean | undefined,
): Promise<ScreenshotResult> {
  return withOfflineReplayRenderer(
    { sessionDir: sessionDirectory, profileName: profile, rendererName },
    async ({ backend, manifest }) =>
      captureScreenshotResult({
        backend,
        sessionDir: sessionDirectory,
        profileName: profile,
        expectedSessionId: manifest.sessionId,
        ...(showCursor === undefined ? {} : { showCursor }),
      }),
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

  let result: ScreenshotResult;

  // Snapshot and screenshot intentionally keep their narrower legacy live-RPC
  // gate. `exiting` sessions are live-host eligible for inspect, but these
  // commands preserve their existing offline-replay capture behavior.
  if (manifest.status === 'running') {
    try {
      const rawResult = await sendRpc(
        socketPath(sessionDirectory),
        'screenshot',
        {
          profile,
          rendererName: options.context.rendererDefault,
          ...(showCursor === undefined ? {} : { showCursor }),
        },
      );
      result = parseScreenshotResult(
        rawResult,
        'Unexpected response from host',
      );
    } catch (error) {
      if (
        !(error instanceof CliError) ||
        error.code !== ERROR_CODES.HOST_UNREACHABLE
      ) {
        throw error;
      }

      result = await runOfflineScreenshot(
        sessionDirectory,
        options.context.rendererDefault,
        profile,
        showCursor,
      );
    }
  } else {
    result = await runOfflineScreenshot(
      sessionDirectory,
      options.context.rendererDefault,
      profile,
      showCursor,
    );
  }

  emitSuccess({
    command: 'screenshot',
    json: options.json,
    result,
    lines: formatScreenshotLines(result),
  });
}
