import type { DestroyResult } from '../../protocol/messages.js';

import { emitSuccess } from '../output.js';
import { destroySession } from '../../host/lifecycle.js';

interface CommandOptions {
  json: boolean;
  sessionId: string;
  force: boolean;
}

export async function runDestroyCommand(
  options: CommandOptions,
): Promise<void> {
  await destroySession(options.sessionId, options.force);

  const result: DestroyResult = {
    sessionId: options.sessionId,
    destroyed: true,
  };

  emitSuccess({
    command: 'destroy',
    json: options.json,
    result,
    lines: [`Session destroyed: ${options.sessionId}`],
  });
}
