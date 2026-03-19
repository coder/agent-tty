import { emitSuccess } from '../output.js';
import { sendRpc } from '../../host/rpcClient.js';
import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';
import { readManifestIfExists } from '../../storage/manifests.js';
import { resolveHome } from '../../storage/home.js';
import { manifestPath, sessionDir, socketPath } from '../../storage/sessionPaths.js';

export interface ResizeResult {
  cols: number;
  rows: number;
}

interface CommandOptions {
  json: boolean;
  sessionId: string;
  cols: number;
  rows: number;
}

export async function runResizeCommand(options: CommandOptions): Promise<void> {
  const home = resolveHome();
  const sessionDirectory = sessionDir(home, options.sessionId);
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

  if (
    !Number.isInteger(options.cols) ||
    !Number.isInteger(options.rows) ||
    options.cols <= 0 ||
    options.rows <= 0
  ) {
    throw makeCliError(ERROR_CODES.INVALID_DIMENSIONS, {
      message: 'Resize dimensions must be positive integers.',
      details: {
        cols: options.cols,
        rows: options.rows,
      },
    });
  }

  await sendRpc(socketPath(sessionDirectory), 'resize', {
    cols: options.cols,
    rows: options.rows,
  });

  const result: ResizeResult = {
    cols: options.cols,
    rows: options.rows,
  };
  emitSuccess({
    command: 'resize',
    json: options.json,
    result,
    lines: [`Resized session to ${String(options.cols)}x${String(options.rows)}.`],
  });
}
