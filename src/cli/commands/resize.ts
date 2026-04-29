import type { CommandContext } from '../context.js';

import { resolveCommandTarget } from '../commandTarget.js';
import { emitSuccess } from '../output.js';
import { sendRpc } from '../../host/rpcClient.js';
import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';

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
  const target = await resolveCommandTarget({
    home: options.context.home,
    sessionId: options.sessionId,
  });

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

  await sendRpc(target.socketPath, 'resize', {
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
