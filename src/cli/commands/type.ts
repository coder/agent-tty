import type { CommandContext } from '../context.js';
import type { TypeResult } from '../../protocol/messages.js';

import { resolveCommandTarget } from '../commandTarget.js';
import { emitSuccess } from '../output.js';
import { sendRpc } from '../../host/rpcClient.js';
import { TypeResultSchema } from '../../protocol/messages.js';
import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';
import { resolveCommandInputText } from './inputSource.js';

export type { TypeResult } from '../../protocol/messages.js';

interface CommandOptions {
  context: CommandContext;
  json: boolean;
  sessionId: string;
  text: string | undefined;
  file?: string;
  appendNewline?: boolean;
}

export async function runTypeCommand(options: CommandOptions): Promise<void> {
  const resolvedText = await resolveCommandInputText({
    commandName: 'type',
    text: options.text,
    file: options.file,
  });
  const text =
    options.appendNewline === true ? resolvedText + '\n' : resolvedText;

  const target = await resolveCommandTarget({
    home: options.context.home,
    sessionId: options.sessionId,
  });

  const rawResult: unknown = await sendRpc(target.socketPath, 'type', {
    text,
  });
  const parsedResult = TypeResultSchema.safeParse(rawResult);
  if (!parsedResult.success) {
    throw makeCliError(ERROR_CODES.PROTOCOL_ERROR, {
      message: 'Unexpected response from host',
      details: { issues: parsedResult.error.issues },
    });
  }

  const result: TypeResult = { seq: parsedResult.data.seq };
  emitSuccess({
    command: 'type',
    json: options.json,
    result,
    lines: [`Typed text into session at seq ${String(result.seq)}.`],
  });
}
