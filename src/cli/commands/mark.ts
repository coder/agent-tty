import type { CommandContext } from '../context.js';
import type { MarkResult } from '../../protocol/messages.js';

import { resolveCommandTarget } from '../commandTarget.js';
import { emitSuccess } from '../output.js';
import { sendRpc } from '../../host/rpcClient.js';
import { MarkResultSchema } from '../../protocol/messages.js';
import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';

export type { MarkResult } from '../../protocol/messages.js';

interface CommandOptions {
  context: CommandContext;
  json: boolean;
  sessionId: string;
  label: string;
}

export async function runMarkCommand(options: CommandOptions): Promise<void> {
  const target = await resolveCommandTarget({
    home: options.context.home,
    sessionId: options.sessionId,
  });

  const rawResult: unknown = await sendRpc(target.socketPath, 'mark', {
    label: options.label,
  });
  const parsedResult = MarkResultSchema.safeParse(rawResult);
  if (!parsedResult.success) {
    throw makeCliError(ERROR_CODES.PROTOCOL_ERROR, {
      message: 'Unexpected response from host',
      details: { issues: parsedResult.error.issues },
    });
  }

  const result: MarkResult = { seq: parsedResult.data.seq };
  emitSuccess({
    command: 'mark',
    json: options.json,
    result,
    lines: [`Marker set at seq ${String(result.seq)}.`],
  });
}
