import { CliError } from '../errors.js';
import { emitSuccess } from '../output.js';

export interface SendKeysResult {
  [key: string]: never;
}

interface CommandOptions {
  json: boolean;
  sessionId: string;
  keys: string[];
}

export async function runSendKeysCommand(options: CommandOptions): Promise<void> {
  void emitSuccess;
  await Promise.resolve();

  throw new CliError('NOT_IMPLEMENTED', 'send-keys command is not yet implemented', {
    details: { options },
  });
}
