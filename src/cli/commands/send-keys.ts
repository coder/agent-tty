import type { CommandContext } from '../context.js';
import type { SendKeysResult } from '../../protocol/messages.js';

import { resolveCommandTarget } from '../commandTarget.js';
import { emitSuccess } from '../output.js';
import { sendRpc } from '../../host/rpcClient.js';
import { SendKeysResultSchema } from '../../protocol/messages.js';
import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';

export type { SendKeysResult } from '../../protocol/messages.js';

interface CommandOptions {
  context: CommandContext;
  json: boolean;
  sessionId: string;
  keys: string[];
}

export async function runSendKeysCommand(
  options: CommandOptions,
): Promise<void> {
  const target = await resolveCommandTarget({
    home: options.context.home,
    sessionId: options.sessionId,
  });

  const rawResult: unknown = await sendRpc(target.socketPath, 'sendKeys', {
    keys: options.keys,
  });
  const parsedResult = SendKeysResultSchema.safeParse(rawResult);
  if (!parsedResult.success) {
    throw makeCliError(ERROR_CODES.PROTOCOL_ERROR, {
      message: 'Unexpected response from host',
      details: { issues: parsedResult.error.issues },
    });
  }

  const result: SendKeysResult = {
    accepted: parsedResult.data.accepted,
    bytesWritten: parsedResult.data.bytesWritten,
    seq: parsedResult.data.seq,
  };
  emitSuccess({
    command: 'send-keys',
    json: options.json,
    result,
    lines: [
      `Sent ${String(result.accepted.length)} key(s) (${String(result.bytesWritten)} byte(s), seq ${String(result.seq)}).`,
    ],
  });
}
