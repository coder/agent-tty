import type { CommandContext } from '../context.js';

import { emitSuccess } from '../output.js';
import { listSessions } from '../../host/lifecycle.js';

export interface ListResult {
  sessions: Array<{
    sessionId: string;
    status: string;
    command: string[];
    createdAt: string;
  }>;
}

interface CommandOptions {
  context: CommandContext;
  json: boolean;
  all: boolean;
}

export async function runListCommand(options: CommandOptions): Promise<void> {
  const home = options.context.home;
  const sessions = await listSessions(home, options.all);
  const lines = sessions.map(
    (session) =>
      `${session.sessionId}  ${session.status}  ${session.command.join(' ')}`,
  );

  emitSuccess({
    command: 'list',
    json: options.json,
    result: { sessions },
    lines,
  });
}
