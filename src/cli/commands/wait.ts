import { CliError } from '../errors.js';
import { emitSuccess } from '../output.js';

export interface WaitResult {
  exitCode?: number;
  timedOut: boolean;
}

interface CommandOptions {
  json: boolean;
  sessionId: string;
  waitForExit: boolean;
  idleMs: number | undefined;
  timeout: number | undefined;
}

export async function runWaitCommand(options: CommandOptions): Promise<void> {
  void emitSuccess;
  await Promise.resolve();

  throw new CliError('NOT_IMPLEMENTED', 'wait command is not yet implemented', {
    details: { options },
  });
}
