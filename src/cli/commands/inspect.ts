import { CliError } from '../errors.js';
import { emitSuccess } from '../output.js';

export interface InspectResult {
  session: {
    sessionId: string;
    status: string;
    command: string[];
    createdAt: string;
    exitedAt?: string;
    exitCode?: number;
  };
}

interface CommandOptions {
  json: boolean;
  sessionId: string;
}

export async function runInspectCommand(options: CommandOptions): Promise<void> {
  void emitSuccess;
  await Promise.resolve();

  throw new CliError('NOT_IMPLEMENTED', 'inspect command is not yet implemented', {
    details: { options },
  });
}
