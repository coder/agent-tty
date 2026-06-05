import type { CommandContext } from '../context.js';
import type { PasteResult } from '../../protocol/messages.js';

import { resolveCommandTarget } from '../commandTarget.js';
import { emitSuccess } from '../output.js';
import { sendRpc } from '../../host/rpcClient.js';
import { PasteResultSchema } from '../../protocol/messages.js';
import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';
import { resolveCommandInputText } from './inputSource.js';

export type { PasteResult } from '../../protocol/messages.js';

interface CommandOptions {
  context: CommandContext;
  json: boolean;
  sessionId: string;
  text: string | undefined;
  file?: string;
}

export async function runPasteCommand(options: CommandOptions): Promise<void> {
  const text = await resolveCommandInputText({
    commandName: 'paste',
    text: options.text,
    file: options.file,
  });

  const target = await resolveCommandTarget({
    home: options.context.home,
    sessionId: options.sessionId,
  });

  const rawResult: unknown = await sendRpc(target.socketPath, 'paste', {
    text,
  });
  const parsedResult = PasteResultSchema.safeParse(rawResult);
  if (!parsedResult.success) {
    throw makeCliError(ERROR_CODES.PROTOCOL_ERROR, {
      message: 'Unexpected response from host',
      details: { issues: parsedResult.error.issues },
    });
  }

  const result: PasteResult = { seq: parsedResult.data.seq };
  emitSuccess({
    command: 'paste',
    json: options.json,
    result,
    lines: [`Pasted text into session at seq ${String(result.seq)}.`],
  });
}
