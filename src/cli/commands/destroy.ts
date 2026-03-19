import { emitSuccess } from '../output.js';
import { destroySession } from '../../host/lifecycle.js';

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
  await destroySession(options.sessionId, options.force);

  emitSuccess({
    command: 'destroy',
    json: options.json,
    result: {
      sessionId: options.sessionId,
      destroyed: true,
    },
    lines: [`Session destroyed: ${options.sessionId}`],
  });
}
