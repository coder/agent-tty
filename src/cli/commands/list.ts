import { CliError } from '../errors.js';
import { emitSuccess } from '../output.js';

export interface ListResult {
  sessions: Array<{
    sessionId: string;
    status: string;
    command: string[];
    createdAt: string;
  }>;
}

interface CommandOptions {
  json: boolean;
  all: boolean;
}

export async function runListCommand(options: CommandOptions): Promise<void> {
  void emitSuccess;
  await Promise.resolve();

  throw new CliError('NOT_IMPLEMENTED', 'list command is not yet implemented', {
    details: { options },
  });
}
