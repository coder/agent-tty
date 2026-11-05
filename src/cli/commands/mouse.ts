import type { CommandContext } from '../context.js';
import type { MouseResult } from '../../protocol/messages.js';

import { resolveCommandTarget } from '../commandTarget.js';
import { emitSuccess } from '../output.js';
import { sendRpc } from '../../host/rpcClient.js';
import {
  MouseParamsSchema,
  MouseResultSchema,
} from '../../protocol/messages.js';
import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';

interface CommandOptions {
  context: CommandContext;
  json: boolean;
  sessionId: string;
  action: string;
  button?: string;
  row: number;
  col: number;
  cellWidth?: number;
  cellHeight?: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

/** Validate one cell-addressed action before asking the host to encode it. */
export async function runMouseCommand(options: CommandOptions): Promise<void> {
  const paramsResult = MouseParamsSchema.safeParse({
    action: options.action,
    ...(options.button === undefined ? {} : { button: options.button }),
    row: options.row,
    col: options.col,
    ...(options.cellWidth === undefined
      ? {}
      : { cellWidth: options.cellWidth }),
    ...(options.cellHeight === undefined
      ? {}
      : { cellHeight: options.cellHeight }),
    modifiers: {
      shift: options.shift,
      alt: options.alt,
      ctrl: options.ctrl,
    },
    rendererName: options.context.rendererDefault,
  });
  if (!paramsResult.success) {
    throw makeCliError(ERROR_CODES.INVALID_INPUT, {
      message: 'Invalid mouse input.',
      details: { issues: paramsResult.error.issues },
    });
  }

  const target = await resolveCommandTarget({
    home: options.context.home,
    sessionId: options.sessionId,
  });
  const rawResult: unknown = await sendRpc(
    target.socketPath,
    'mouse',
    paramsResult.data,
  );
  const result = MouseResultSchema.safeParse(rawResult);
  if (!result.success) {
    throw makeCliError(ERROR_CODES.PROTOCOL_ERROR, {
      message: 'Unexpected response from host',
      details: { issues: result.error.issues },
    });
  }

  const mouseResult: MouseResult = result.data;
  emitSuccess({
    command: 'mouse',
    json: options.json,
    result: mouseResult,
    lines: [
      mouseResult.reported
        ? `Sent ${String(mouseResult.bytesWritten)} mouse byte(s), seq ${String(mouseResult.seq)}.`
        : `Mouse tracking suppressed the input, seq ${String(mouseResult.seq)}.`,
    ],
  });
}
