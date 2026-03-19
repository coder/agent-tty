import { CliError } from '../errors.js';
import { emitSuccess } from '../output.js';

export interface PasteResult {
  [key: string]: never;
}

interface CommandOptions {
  json: boolean;
  sessionId: string;
  text: string;
}

export async function runPasteCommand(options: CommandOptions): Promise<void> {
  void emitSuccess;
  await Promise.resolve();

  throw new CliError('NOT_IMPLEMENTED', 'paste command is not yet implemented', {
    details: { options },
  });
}
