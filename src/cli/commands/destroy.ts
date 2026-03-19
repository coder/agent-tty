import { CliError } from '../errors.js';
import { emitSuccess } from '../output.js';

export interface DestroyResult {
  sessionId: string;
  destroyed: boolean;
}

interface CommandOptions {
  json: boolean;
  sessionId: string;
  force: boolean;
}

export async function runDestroyCommand(options: CommandOptions): Promise<void> {
  void emitSuccess;
  await Promise.resolve();

  throw new CliError('NOT_IMPLEMENTED', 'destroy command is not yet implemented', {
    details: { options },
  });
}
