import type { CommandContext } from '../context.js';

import { emitSuccess } from '../output.js';
import { sendRpc } from '../../host/rpcClient.js';
import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';
import { readManifestIfExists } from '../../storage/manifests.js';
import {
  manifestPath,
  sessionDir,
  socketPath,
} from '../../storage/sessionPaths.js';
import { assertSessionCommandable } from '../sessionGuards.js';

export interface ResizeResult {
  cols: number;
  rows: number;
}

interface CommandOptions {
  context: CommandContext;
  json: boolean;
  sessionId: string;
  cols: number;
  rows: number;
}

export async function runResizeCommand(options: CommandOptions): Promise<void> {
  const home = options.context.home;
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

  assertSessionCommandable(manifest, options.sessionId);

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
    lines: [
      `Resized session to ${String(options.cols)}x${String(options.rows)}.`,
    ],
  });
}
