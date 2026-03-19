import { CliError } from '../errors.js';
import { emitSuccess } from '../output.js';

export interface SignalResult {
  signal: string;
  delivered: boolean;
}

interface CommandOptions {
  json: boolean;
  sessionId: string;
  signal: string;
}

export async function runSignalCommand(options: CommandOptions): Promise<void> {
  void emitSuccess;
  await Promise.resolve();

  throw new CliError('NOT_IMPLEMENTED', 'signal command is not yet implemented', {
    details: { options },
  });
}
