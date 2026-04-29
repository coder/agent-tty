import type { CommandContext } from '../context.js';

import { resolveCommandTarget } from '../commandTarget.js';
import { emitSuccess } from '../output.js';
import { sendRpc } from '../../host/rpcClient.js';
import { resolveCommandInputText } from './inputSource.js';

export interface PasteResult {
  [key: string]: never;
}

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

  await sendRpc(target.socketPath, 'paste', {
    text,
  });

  const result: PasteResult = {};
  emitSuccess({
    command: 'paste',
    json: options.json,
    result,
    lines: ['Pasted text into session.'],
  });
}
