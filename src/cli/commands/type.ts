import type { CommandContext } from '../context.js';

import { resolveCommandTarget } from '../commandTarget.js';
import { emitSuccess } from '../output.js';
import { sendRpc } from '../../host/rpcClient.js';
import { resolveCommandInputText } from './inputSource.js';

export interface TypeResult {
  [key: string]: never;
}

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

  await sendRpc(target.socketPath, 'type', {
    text,
  });

  const result: TypeResult = {};
  emitSuccess({
    command: 'type',
    json: options.json,
    result,
    lines: ['Typed text into session.'],
  });
}
