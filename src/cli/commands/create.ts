import { CliError } from '../errors.js';
import { emitSuccess } from '../output.js';

export interface CreateResult {
  sessionId: string;
}

interface CommandOptions {
  json: boolean;
  command: string[];
  shellCommand: string;
  cwd: string;
  cols: number;
  rows: number;
}

export async function runCreateCommand(options: CommandOptions): Promise<void> {
  void emitSuccess;
  await Promise.resolve();

  throw new CliError('NOT_IMPLEMENTED', 'create command is not yet implemented', {
    details: { options },
  });
}
