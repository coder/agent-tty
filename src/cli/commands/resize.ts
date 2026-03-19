import { CliError } from '../errors.js';
import { emitSuccess } from '../output.js';

export interface ResizeResult {
  cols: number;
  rows: number;
}

interface CommandOptions {
  json: boolean;
  sessionId: string;
  cols: number;
  rows: number;
}

export async function runResizeCommand(options: CommandOptions): Promise<void> {
  void emitSuccess;
  await Promise.resolve();

  throw new CliError('NOT_IMPLEMENTED', 'resize command is not yet implemented', {
    details: { options },
  });
}
